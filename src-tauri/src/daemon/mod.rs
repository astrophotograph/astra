//! Astra daemon — a long-running HTTP service over the same backend stack the
//! desktop app uses (SQLite via Diesel, HoardFS content-addressed storage).
//!
//! Foundation for the hosted astra.gallery service: later waves add auth,
//! tenancy, read APIs, and collection ingest on top of this skeleton. As
//! command cores are extracted (see the "Core-fn extraction" task), handlers
//! call the same core functions the Tauri commands wrap.
//!
//! # Concurrent access & the one-writer convention
//!
//! Both the desktop app and the daemon may open the same `astra.db`. Every
//! pool connection runs in WAL mode with a 5s busy timeout (see
//! [`crate::db`]), so SQLite supports many readers plus one writer across
//! processes; concurrent writers queue on the busy timeout rather than
//! corrupting. The convention on top of that: **at most one long-lived writer
//! per logical dataset** — a running desktop app owns writes to the local
//! user's data, the daemon owns writes to hosted-tenant data. The skeleton
//! daemon only reads (plus schema migrations at boot). On shutdown it
//! checkpoints the WAL so no `-wal` sidecar is left holding unmerged frames.
//!
//! # Authorization convention
//!
//! Every route under `/api` sits behind [`auth::require_auth`], which
//! authenticates the bearer token and inserts an [`auth::AuthedUser`]
//! request extension — default-deny: a route nested there cannot skip
//! authentication. Handlers declare `user: AuthedUser` and pass
//! `user.user_id` to core fns explicitly; there is no "current user"
//! global. The public surface is `/healthz` and (later) the public gallery
//! pages — nothing else.

pub mod api;
pub mod api_write;
pub mod auth;
pub mod webapp;
pub mod gallery;
pub mod ingest;
pub mod kith_store;
pub mod oidc;
pub mod session;
pub mod social_events;
pub mod social_routes;

use std::future::Future;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use diesel::connection::SimpleConnection;
use serde::Serialize;

use crate::db::{self, DbPool};

/// Default bind address ("ASTRA" on a phone keypad → 27872).
pub const DEFAULT_BIND: &str = "127.0.0.1:27872";

/// Runtime configuration for the daemon.
#[derive(Debug, Clone)]
pub struct DaemonConfig {
    /// App data directory holding `astra.db` and the `hoardfs/` repository.
    pub data_dir: PathBuf,
    /// Address the HTTP server binds to.
    pub bind: SocketAddr,
    /// Directory holding the Vite web build (`ASTRA_WEB_DIST`, default
    /// `{data_dir}/web`). Served under `/app` only when `index.html` exists.
    pub web_dist: PathBuf,
}

impl DaemonConfig {
    /// Resolve config with precedence: explicit value > `ASTRA_DATA_DIR` /
    /// `ASTRA_BIND` environment variable > default (the desktop app's data
    /// dir; [`DEFAULT_BIND`]).
    pub fn resolve(data_dir: Option<PathBuf>, bind: Option<String>) -> Result<Self, String> {
        let data_dir = data_dir
            .or_else(|| std::env::var_os("ASTRA_DATA_DIR").map(PathBuf::from))
            .unwrap_or_else(crate::default_app_data_dir);
        let bind_str = bind
            .or_else(|| std::env::var("ASTRA_BIND").ok())
            .unwrap_or_else(|| DEFAULT_BIND.to_string());
        let bind = bind_str
            .parse()
            .map_err(|e| format!("invalid bind address '{bind_str}': {e}"))?;
        let web_dist = std::env::var_os("ASTRA_WEB_DIST")
            .map(PathBuf::from)
            .unwrap_or_else(|| data_dir.join("web"));
        Ok(Self {
            data_dir,
            bind,
            web_dist,
        })
    }
}

/// Backend state shared by all request handlers.
pub struct DaemonState {
    pub db: DbPool,
    /// Same locking discipline as the desktop app's `AppState`: the lock must
    /// NOT be held across `.await` points (rusqlite::Connection is not Sync).
    pub hoardfs: Arc<Mutex<hoardfs_volume::HoardFs>>,
    /// OIDC session verification (Zitadel). None → only PATs authenticate.
    /// Configured via `ASTRA_OIDC_ISSUER` + `ASTRA_OIDC_CLIENT_ID`.
    pub oidc: Option<Arc<oidc::OidcVerifier>>,
    /// Push-ingest request limits (env: ASTRA_MAX_PUSH_IMAGES,
    /// ASTRA_MAX_ASSET_MB).
    pub limits: ingest::IngestLimits,
    /// HMAC key for browser session cookies ({data_dir}/session-key).
    pub session_key: [u8; 32],
}

impl DaemonState {
    /// Kith storage adapter over this state's pool. The store is just an
    /// Arc'd pool handle, so constructing per call is free — one definition
    /// point without adding a field to every `DaemonState` literal.
    pub fn kith(&self) -> kith_store::AstraKithStore {
        kith_store::AstraKithStore::new(self.db.clone())
    }

    /// High-level social graph over [`Self::kith`].
    pub fn social(&self) -> kith::graph::SocialGraph<kith_store::AstraKithStore> {
        kith::graph::SocialGraph::new(self.kith())
    }
}

/// A daemon that has initialized its backend and bound its listener but is
/// not yet serving. Split from [`Daemon::serve`] so tests can bind to port 0
/// and read the ephemeral address before starting the server.
pub struct Daemon {
    state: Arc<DaemonState>,
    listener: tokio::net::TcpListener,
    /// Some only when the configured dist actually holds a bundle.
    web_dist: Option<PathBuf>,
}

impl Daemon {
    /// Initialize the backend (DB + HoardFS, creating either if missing) and
    /// bind the listener.
    pub async fn bind(config: &DaemonConfig) -> Result<Self, String> {
        let state = Arc::new(init_backend(&config.data_dir).await?);
        let listener = tokio::net::TcpListener::bind(config.bind)
            .await
            .map_err(|e| format!("bind {}: {e}", config.bind))?;
        let web_dist = if config.web_dist.join("index.html").is_file() {
            log::info!("serving web app from {}", config.web_dist.display());
            Some(config.web_dist.clone())
        } else {
            log::info!(
                "no web bundle at {} — /app disabled",
                config.web_dist.display()
            );
            None
        };
        Ok(Self {
            state,
            listener,
            web_dist,
        })
    }

    pub fn local_addr(&self) -> Result<SocketAddr, String> {
        self.listener.local_addr().map_err(|e| e.to_string())
    }

    /// Shared backend state — lets callers (tests, the mint CLI path) reach
    /// the same pool the server uses.
    pub fn state(&self) -> Arc<DaemonState> {
        self.state.clone()
    }

    /// Serve until `shutdown` resolves, then checkpoint the WAL and return.
    pub async fn serve(
        self,
        shutdown: impl Future<Output = ()> + Send + 'static,
    ) -> Result<(), String> {
        let addr = self.local_addr()?;
        let app = router_with_web(self.state.clone(), self.web_dist.clone());
        log::info!("astra_daemon listening on http://{addr}");
        axum::serve(self.listener, app)
            .with_graceful_shutdown(shutdown)
            .await
            .map_err(|e| format!("server error: {e}"))?;
        checkpoint_wal(&self.state.db);
        log::info!("astra_daemon shut down cleanly");
        Ok(())
    }
}

/// Build the daemon router. Public so integration tests can drive handlers
/// against an arbitrary state. Equivalent to [`router_with_web`] with no
/// web bundle — the shape every pre-webapp test relies on.
pub fn router(state: Arc<DaemonState>) -> Router {
    router_with_web(state, None)
}

/// [`router`] plus the `/app` static surface when a web bundle exists.
pub fn router_with_web(state: Arc<DaemonState>, web_dist: Option<PathBuf>) -> Router {
    let api = Router::new()
        .route("/me", get(me))
        .route("/images", get(api::list_images))
        .route(
            "/images/{id}",
            get(api::get_image)
                .patch(api_write::update_image)
                .delete(api_write::delete_image),
        )
        .route("/images/{id}/thumbnail", get(api::image_thumbnail))
        .route("/images/{id}/preview", get(api::image_preview))
        .route(
            "/collections",
            get(api::list_collections).post(api_write::create_collection),
        )
        .route(
            "/collections/{id}",
            get(api::get_collection)
                .patch(api_write::update_collection)
                .delete(api_write::delete_collection),
        )
        .route(
            "/collections/{id}/images/{image_id}",
            axum::routing::put(api_write::add_collection_image)
                .delete(api_write::remove_collection_image),
        )
        .route("/todos", get(api::list_todos).post(api_write::create_todo))
        // Static segments outrank captures, so /sync and /active never
        // shadow the {id} routes below them.
        .route("/todos/sync", axum::routing::post(api_write::sync_todos))
        .route(
            "/todos/{id}",
            get(api::get_todo)
                .patch(api_write::update_todo)
                .delete(api_write::delete_todo),
        )
        .route(
            "/schedules",
            get(api::list_schedules).post(api_write::create_schedule),
        )
        .route("/schedules/active", get(api::active_schedules))
        .route(
            "/schedules/{id}",
            get(api::get_schedule)
                .patch(api_write::update_schedule)
                .delete(api_write::delete_schedule),
        )
        .route(
            "/schedules/{id}/items",
            axum::routing::post(api_write::add_schedule_item),
        )
        .route(
            "/schedules/{id}/items/{item_id}",
            axum::routing::delete(api_write::remove_schedule_item),
        )
        .route("/targets", get(api::list_targets))
        .route("/targets/search", get(api::target_search))
        .route("/targets/images", get(api::target_images))
        .route(
            "/collections/{id}/publish",
            get(api::publish_status)
                .post(api::publish_collection)
                .delete(api::unpublish_collection),
        )
        .route(
            "/push/collections",
            axum::routing::post(ingest::push_collection)
                .layer(axum::extract::DefaultBodyLimit::max(32 * 1024 * 1024)),
        )
        .route(
            "/push/images/{id}/asset",
            axum::routing::put(ingest::put_image_asset).layer(
                axum::extract::DefaultBodyLimit::max(state.limits.max_asset_bytes),
            ),
        )
        .nest("/social", social_routes::routes())
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::require_auth,
        ))
        // Registered AFTER the auth layer (axum layers wrap only the routes
        // added before them): logging in is how you obtain credentials, and
        // the SPA needs issuer/client id before it has any.
        .route(
            "/session",
            axum::routing::post(session::create_session).delete(session::destroy_session),
        )
        .route("/session/config", get(session_config))
        // Public discovery for the marketing landing — recent public galleries.
        .route("/galleries/recent", get(recent_galleries));

    Router::new()
        .route("/healthz", get(healthz))
        .nest("/api", api)
        // Public gallery surface: `{user}` carries the leading `@`; handlers
        // 404 anything else. Gated by publish-record resolution, not auth.
        .route("/{user}", get(gallery::profile_page))
        .route("/{user}/{slug}", get(gallery::gallery_page))
        .route("/{user}/{slug}/", get(gallery::gallery_page))
        .route("/{user}/{slug}/manifest.json", get(gallery::gallery_manifest))
        .route("/{user}/{slug}/images/{file}", get(gallery::gallery_image))
        .route("/{user}/{slug}/thumbs/{file}", get(gallery::gallery_thumb))
        // `/`, `/app`, `/app/{*path}`, `/auth/callback` — static segments,
        // so they can never shadow the `/{user}` gallery captures above.
        .merge(webapp::routes(web_dist))
        .with_state(state)
}

/// Public discovery: the most recent public galleries, feeding the landing
/// page's community strip. No auth — it only ever exposes already-public
/// galleries, and never unlisted ones.
async fn recent_galleries(State(state): State<Arc<DaemonState>>) -> Response {
    let db = state.db.clone();
    let result =
        tokio::task::spawn_blocking(move || crate::commands::publish::list_recent_public_core(&db, 12))
            .await;
    match result {
        Ok(Ok(items)) => {
            let mut response = Json(items).into_response();
            response.headers_mut().insert(
                axum::http::header::CACHE_CONTROL,
                axum::http::HeaderValue::from_static("public, max-age=60"),
            );
            response
        }
        Ok(Err(e)) => {
            log::error!("recent galleries: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
        Err(e) => {
            log::error!("recent galleries task: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// Public OIDC parameters for the SPA login flow (issuer + client id are
/// visible in every auth redirect anyway). 404 when OIDC is not configured.
async fn session_config(State(state): State<Arc<DaemonState>>) -> impl IntoResponse {
    match &state.oidc {
        Some(oidc) => {
            let config = oidc.config();
            (
                StatusCode::OK,
                Json(serde_json::json!({
                    "issuer": config.issuer,
                    "clientId": config.client_id,
                })),
            )
        }
        None => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "OIDC not configured" })),
        ),
    }
}

/// Open (or create) the database at the resolved data dir and mint a PAT —
/// backs `astra_daemon --mint-token`. The caller decides how to display the
/// plaintext; it is never logged here.
pub fn mint_token_standalone(
    data_dir: Option<PathBuf>,
    user_id: &str,
    name: &str,
) -> Result<auth::MintedToken, String> {
    let config = DaemonConfig::resolve(data_dir, None)?;
    std::fs::create_dir_all(&config.data_dir)
        .map_err(|e| format!("create data dir {}: {e}", config.data_dir.display()))?;
    let db = db::init_database(&config.data_dir.join("astra.db"))
        .map_err(|e| format!("DB init: {e}"))?;
    auth::mint_token(&db, user_id, name)
}

/// Resolves on SIGINT (Ctrl-C) or SIGTERM.
pub async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl-C handler");
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
}

/// Open (or create) the DB and HoardFS repo exactly the way the desktop app
/// does — same pattern as `run_standalone_migration` in `lib.rs`, including
/// the image + FITS variant pipeline.
async fn init_backend(data_dir: &Path) -> Result<DaemonState, String> {
    std::fs::create_dir_all(data_dir)
        .map_err(|e| format!("create data dir {}: {e}", data_dir.display()))?;

    let db_path = data_dir.join("astra.db");
    let db = db::init_database(&db_path).map_err(|e| format!("DB init: {e}"))?;

    // Backfill legacy worker-era publish records (idempotent, non-fatal).
    match crate::commands::publish::migrate_legacy_publish_metadata(&db) {
        Ok(0) => {}
        Ok(n) => log::info!("backfilled {n} legacy publish record(s)"),
        Err(e) => log::warn!("legacy publish backfill failed: {e}"),
    }

    let hoardfs_dir = data_dir.join("hoardfs");
    let mut hfs = match hoardfs_volume::HoardFs::open(&hoardfs_dir).await {
        Ok(hfs) => hfs,
        Err(_) => {
            log::info!(
                "initializing new HoardFS repository at {}",
                hoardfs_dir.display()
            );
            hoardfs_volume::HoardFs::init(&hoardfs_dir)
                .await
                .map_err(|e| format!("HoardFS open/init: {e}"))?
        }
    };
    hfs.set_variant_pipeline(
        hoardfs_variant::VariantPipeline::new()
            .with_image_generator()
            .register(Box::new(crate::fits_variant::FitsVariantGenerator::new())),
    );

    let oidc = match (
        std::env::var("ASTRA_OIDC_ISSUER"),
        std::env::var("ASTRA_OIDC_CLIENT_ID"),
    ) {
        (Ok(issuer), Ok(client_id)) if !issuer.is_empty() && !client_id.is_empty() => {
            log::info!("OIDC sessions enabled (issuer: {issuer})");
            Some(Arc::new(oidc::OidcVerifier::new(oidc::OidcConfig {
                issuer,
                client_id,
            })))
        }
        _ => {
            log::info!("OIDC not configured — only personal access tokens authenticate");
            None
        }
    };

    let mut limits = ingest::IngestLimits::default();
    if let Some(n) = std::env::var("ASTRA_MAX_PUSH_IMAGES")
        .ok()
        .and_then(|v| v.parse().ok())
    {
        limits.max_images_per_push = n;
    }
    if let Some(mb) = std::env::var("ASTRA_MAX_ASSET_MB")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
    {
        limits.max_asset_bytes = mb * 1024 * 1024;
    }

    let session_key = session::load_or_create_session_key(data_dir)?;

    Ok(DaemonState {
        db,
        hoardfs: Arc::new(Mutex::new(hfs)),
        oidc,
        limits,
        session_key,
    })
}

#[derive(Debug, Serialize)]
struct Health {
    /// "ok" when every component is healthy, otherwise "degraded".
    status: &'static str,
    version: &'static str,
    /// "ok" or the component's error message.
    db: String,
    hoardfs: String,
}

async fn healthz(State(state): State<Arc<DaemonState>>) -> (StatusCode, Json<Health>) {
    let db_pool = state.db.clone();
    let db_status = tokio::task::spawn_blocking(move || {
        let mut conn = db_pool.get().map_err(|e| e.to_string())?;
        conn.batch_execute("SELECT 1;").map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|e| Err(format!("health task panicked: {e}")));

    let hoardfs = state.hoardfs.clone();
    let hoardfs_status = tokio::task::spawn_blocking(move || {
        let hfs = hoardfs
            .lock()
            .map_err(|_| "HoardFS lock poisoned".to_string())?;
        hfs.list_volumes().map(|_| ()).map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|e| Err(format!("health task panicked: {e}")));

    let ok = db_status.is_ok() && hoardfs_status.is_ok();
    let health = Health {
        status: if ok { "ok" } else { "degraded" },
        version: env!("CARGO_PKG_VERSION"),
        db: db_status.err().unwrap_or_else(|| "ok".to_string()),
        hoardfs: hoardfs_status.err().unwrap_or_else(|| "ok".to_string()),
    };
    let code = if ok {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (code, Json(health))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MeResponse {
    user_id: String,
    username: Option<String>,
    display_name: Option<String>,
    role: crate::db::tenancy::UserRole,
    status: String,
}

/// Blocking: the `/api/me` payload for an authenticated user. Shared by the
/// `me` handler and the session-login response.
pub(crate) fn fetch_me(db: &DbPool, user: &auth::AuthedUser) -> Result<MeResponse, String> {
    use crate::db::schema::users;
    use diesel::prelude::*;
    let mut conn = db.get().map_err(|e| e.to_string())?;
    let (username, display_name, status) = users::table
        .find(&user.user_id)
        .select((users::username, users::name, users::status))
        .first::<(Option<String>, Option<String>, String)>(&mut conn)
        .map_err(|e| e.to_string())?;
    Ok(MeResponse {
        user_id: user.user_id.clone(),
        username,
        display_name,
        role: user.role,
        status,
    })
}

/// Identity of the authenticated caller — the first `/api` route and the
/// reference implementation of the handler convention.
async fn me(
    State(state): State<Arc<DaemonState>>,
    user: auth::AuthedUser,
) -> Result<Json<MeResponse>, StatusCode> {
    let db = state.db.clone();
    let response = tokio::task::spawn_blocking(move || fetch_me(&db, &user))
        .await
        .map_err(|e| {
            log::error!("me task panicked: {e}");
            StatusCode::INTERNAL_SERVER_ERROR
        })?
        .map_err(|e| {
            log::error!("me lookup failed: {e}");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;
    Ok(Json(response))
}

/// Merge WAL frames back into the main database file so a stopped daemon
/// leaves no `-wal` sidecar with unmerged writes.
fn checkpoint_wal(db: &DbPool) {
    match db.get() {
        Ok(mut conn) => {
            if let Err(e) = conn.batch_execute("PRAGMA wal_checkpoint(TRUNCATE);") {
                log::warn!("WAL checkpoint failed: {e}");
            }
        }
        Err(e) => log::warn!("WAL checkpoint skipped (no connection): {e}"),
    }
}
