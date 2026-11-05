//! Daemon authentication: personal access tokens and the per-request user
//! context.
//!
//! Tokens are bearer credentials for non-browser clients (desktop push,
//! CLI). The plaintext token is `astra_` + 64 hex chars of a random 256-bit
//! secret; only its SHA-256 hash is stored. Because the secret is
//! high-entropy, a fast hash is sufficient — argon2 is for low-entropy
//! passwords, not random tokens.
//!
//! # Request flow
//!
//! [`require_auth`] (layered on the `/api` subtree in `daemon::router`)
//! authenticates `Authorization: Bearer <token>` and inserts an
//! [`AuthedUser`] request extension. Handlers declare `user: AuthedUser`,
//! whose extractor reads that extension — and responds 500 if the route was
//! registered outside the authenticated scope, so a misconfigured route
//! fails loudly instead of silently skipping auth.
//!
//! The public gallery routes are not behind the layer but may still want
//! to know who is asking: [`MaybeViewer`] runs the same credential
//! resolution ([`resolve_credentials`]) optionally, yielding the viewer's
//! DID (`users.did`) when a valid PAT, OIDC bearer or session cookie names
//! a local user with one, and `None` otherwise. It never rejects. The
//! session cookie is either the stateless OIDC one or a magic-link viewer
//! session ([`super::magic_link`]); both arrive as `astra_session`.

use std::sync::Arc;

use std::convert::Infallible;

use axum::extract::{FromRequestParts, Request, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use diesel::prelude::*;
use kenning::Did;
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::DaemonState;
use crate::db::schema::{access_tokens, users};
use crate::db::tenancy::{UserRole, UserStatus};
use crate::db::DbPool;

/// Which kind of credential authenticated the request. Mostly informational,
/// with one policy hook: token management (`/api/me/tokens`) refuses
/// [`Credential::Pat`], so a leaked CLI token cannot mint successors or
/// revoke its siblings — only an interactive sign-in can.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Credential {
    /// `astra_…` personal access token (bearer).
    Pat,
    /// OIDC JWT (bearer) verified against the configured issuer.
    Oidc,
    /// `astra_session` cookie set by the OIDC browser login.
    Session,
    /// `astra_session` cookie backed by a magic-link viewer session.
    MagicLink,
}

/// Authenticated per-request user context. There is no "current user"
/// global — handlers pass `user_id` to core fns explicitly.
#[derive(Debug, Clone)]
pub struct AuthedUser {
    pub user_id: String,
    pub role: UserRole,
    pub credential: Credential,
}

#[derive(Debug)]
pub enum AuthError {
    /// No Authorization header or not a Bearer scheme.
    Missing,
    /// Unknown or revoked token.
    InvalidToken,
    /// Token is valid but the user is not active (invited/disabled).
    InactiveUser,
    /// Authenticated but not allowed — 403 with a friendly message
    /// (e.g. "invite required" from OIDC provisioning).
    Forbidden(&'static str),
    /// Backend failure — surfaces as 500, not 401.
    Db(String),
}

/// A freshly minted token. `token` is the only copy of the plaintext —
/// show it once, never log it.
#[derive(Debug)]
pub struct MintedToken {
    pub token: String,
    pub token_id: String,
    pub user_id: String,
    pub name: String,
}

fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// Mint a new personal access token for an existing user.
///
/// The user may be in any status (an invited user can hold a token before
/// activation) — [`authenticate`] is what gates on `active`.
pub fn mint_token(db: &DbPool, user_id: &str, name: &str) -> Result<MintedToken, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;

    let user_exists: bool = users::table
        .find(user_id)
        .count()
        .get_result::<i64>(&mut conn)
        .map(|n| n > 0)
        .map_err(|e| e.to_string())?;
    if !user_exists {
        return Err(format!("user not found: {user_id}"));
    }

    let mut secret = [0u8; 32];
    getrandom::fill(&mut secret).map_err(|e| format!("random source: {e}"))?;
    let token = format!("astra_{}", hex::encode(secret));
    let token_id = uuid::Uuid::new_v4().to_string();

    diesel::insert_into(access_tokens::table)
        .values((
            access_tokens::id.eq(&token_id),
            access_tokens::user_id.eq(user_id),
            access_tokens::name.eq(name),
            access_tokens::token_hash.eq(hash_token(&token)),
        ))
        .execute(&mut conn)
        .map_err(|e| format!("insert token: {e}"))?;

    Ok(MintedToken {
        token,
        token_id,
        user_id: user_id.to_string(),
        name: name.to_string(),
    })
}

/// A token as listed back to its owner: never the hash, never the
/// plaintext.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenSummary {
    pub id: String,
    pub name: String,
    pub created_at: chrono::NaiveDateTime,
    pub last_used_at: Option<chrono::NaiveDateTime>,
}

/// Active (unrevoked) tokens of a user, newest first.
pub fn list_tokens(db: &DbPool, user_id: &str) -> Result<Vec<TokenSummary>, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;
    let rows: Vec<(String, String, chrono::NaiveDateTime, Option<chrono::NaiveDateTime>)> =
        access_tokens::table
            .filter(access_tokens::user_id.eq(user_id))
            .filter(access_tokens::revoked_at.is_null())
            .order(access_tokens::created_at.desc())
            .select((
                access_tokens::id,
                access_tokens::name,
                access_tokens::created_at,
                access_tokens::last_used_at,
            ))
            .load(&mut conn)
            .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(id, name, created_at, last_used_at)| TokenSummary {
            id,
            name,
            created_at,
            last_used_at,
        })
        .collect())
}

/// Revoke one of the caller's own tokens. `false` when the id is unknown,
/// already revoked, or belongs to someone else — all indistinguishable to
/// the caller, so a token id never leaks across users.
pub fn revoke_owned_token(db: &DbPool, user_id: &str, token_id: &str) -> Result<bool, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;
    diesel::update(
        access_tokens::table
            .find(token_id)
            .filter(access_tokens::user_id.eq(user_id))
            .filter(access_tokens::revoked_at.is_null()),
    )
    .set(access_tokens::revoked_at.eq(Some(chrono::Utc::now().naive_utc())))
    .execute(&mut conn)
    .map(|n| n > 0)
    .map_err(|e| e.to_string())
}

/// Revoke a token by id. Idempotent; revoked tokens fail [`authenticate`].
pub fn revoke_token(db: &DbPool, token_id: &str) -> Result<bool, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;
    diesel::update(
        access_tokens::table
            .find(token_id)
            .filter(access_tokens::revoked_at.is_null()),
    )
    .set(access_tokens::revoked_at.eq(Some(chrono::Utc::now().naive_utc())))
    .execute(&mut conn)
    .map(|n| n > 0)
    .map_err(|e| e.to_string())
}

/// Resolve a bearer token to its active user. Touches `last_used_at`.
pub fn authenticate(db: &DbPool, token: &str) -> Result<AuthedUser, AuthError> {
    let hash = hash_token(token);
    let mut conn = db.get().map_err(|e| AuthError::Db(e.to_string()))?;

    let row: Option<(String, String, String, String)> = access_tokens::table
        .inner_join(users::table)
        .filter(access_tokens::token_hash.eq(&hash))
        .filter(access_tokens::revoked_at.is_null())
        .select((
            access_tokens::id,
            users::id,
            users::role,
            users::status,
        ))
        .first(&mut conn)
        .optional()
        .map_err(|e| AuthError::Db(e.to_string()))?;

    let (token_id, user_id, role, status) = row.ok_or(AuthError::InvalidToken)?;

    match UserStatus::parse(&status) {
        Ok(UserStatus::Active) => {}
        Ok(_) => return Err(AuthError::InactiveUser),
        Err(e) => return Err(AuthError::Db(e)),
    }
    let role = UserRole::parse(&role).map_err(AuthError::Db)?;

    // Best-effort usage stamp; auth does not fail on it.
    let _ = diesel::update(access_tokens::table.find(&token_id))
        .set(access_tokens::last_used_at.eq(Some(chrono::Utc::now().naive_utc())))
        .execute(&mut conn);

    Ok(AuthedUser {
        user_id,
        role,
        credential: Credential::Pat,
    })
}

fn bearer_token(parts_headers: &axum::http::HeaderMap) -> Option<&str> {
    let value = parts_headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?;
    let (scheme, token) = value.split_once(' ')?;
    if scheme.eq_ignore_ascii_case("bearer") {
        let token = token.trim();
        (!token.is_empty()).then_some(token)
    } else {
        None
    }
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(serde_json::json!({ "error": "unauthorized" })),
    )
        .into_response()
}

fn server_error() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(serde_json::json!({ "error": "internal error" })),
    )
        .into_response()
}

fn forbidden(message: &str) -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(serde_json::json!({ "error": "forbidden", "message": message })),
    )
        .into_response()
}

/// Blocking: map a session cookie's user id to an active AuthedUser. The
/// cookie is signature-checked by the caller; this re-checks user status on
/// every request so disabling a user kills live sessions immediately.
/// `credential` says which cookie flavour it was ([`Credential::Session`]
/// for the OIDC login, [`Credential::MagicLink`] for a viewer session).
pub fn authenticate_session_user(
    db: &DbPool,
    user_id: &str,
    credential: Credential,
) -> Result<AuthedUser, AuthError> {
    let mut conn = db.get().map_err(|e| AuthError::Db(e.to_string()))?;
    let row: Option<(String, String)> = users::table
        .find(user_id)
        .select((users::role, users::status))
        .first(&mut conn)
        .optional()
        .map_err(|e| AuthError::Db(e.to_string()))?;
    let (role, status) = row.ok_or(AuthError::InvalidToken)?;
    match UserStatus::parse(&status) {
        Ok(UserStatus::Active) => {}
        Ok(_) => return Err(AuthError::InactiveUser),
        Err(e) => return Err(AuthError::Db(e)),
    }
    Ok(AuthedUser {
        user_id: user_id.to_string(),
        role: UserRole::parse(&role).map_err(AuthError::Db)?,
        credential,
    })
}

/// Resolve the request's credential to an active user, without deciding
/// what to do about failure. Three credential types: personal access
/// tokens carry the `astra_` bearer prefix; other bearer values are OIDC
/// JWTs (rejected unless OIDC is configured); with no Authorization
/// header, the `astra_session` cookie (see [`super::session`]) is checked
/// last. `Missing` when the request carries nothing usable.
pub async fn resolve_credentials(
    state: &DaemonState,
    headers: &HeaderMap,
) -> Result<AuthedUser, AuthError> {
    let join = |e: tokio::task::JoinError| AuthError::Db(format!("auth task panicked: {e}"));

    let Some(token) = bearer_token(headers).map(str::to_owned) else {
        // No bearer header — fall back to the browser session cookie.
        let Some(cookie) = super::session::cookie_from_headers(headers) else {
            return Err(AuthError::Missing);
        };
        let Some(subject) = super::session::verify_cookie_value(
            &state.session_key,
            &cookie,
            chrono::Utc::now().timestamp(),
        ) else {
            log::debug!("session cookie rejected (bad signature or expired)");
            return Err(AuthError::InvalidToken);
        };
        let db = state.db.clone();
        // A magic-link cookie names a `viewer_sessions` row (sliding
        // expiry, revocable); the OIDC cookie names the user directly.
        if let Some(session_id) = subject
            .strip_prefix(super::magic_link::SESSION_SUBJECT_PREFIX)
            .map(str::to_owned)
        {
            return tokio::task::spawn_blocking(move || {
                super::magic_link::authenticate_session(&db, &session_id)
            })
            .await
            .map_err(join)?;
        }
        return tokio::task::spawn_blocking(move || {
            authenticate_session_user(&db, &subject, Credential::Session)
        })
        .await
        .map_err(join)?;
    };

    if token.starts_with("astra_") {
        let db = state.db.clone();
        tokio::task::spawn_blocking(move || authenticate(&db, &token))
            .await
            .map_err(join)?
    } else if let Some(oidc) = state.oidc.clone() {
        match oidc.verify(&token).await {
            Ok(claims) => {
                let db = state.db.clone();
                let hoardfs = state.hoardfs.clone();
                tokio::task::spawn_blocking(move || {
                    super::oidc::resolve_user(&db, &hoardfs, &claims)
                })
                .await
                .map_err(join)?
            }
            Err(reason) => {
                log::debug!("OIDC token rejected: {reason}");
                Err(AuthError::InvalidToken)
            }
        }
    } else {
        log::debug!("JWT presented but OIDC is not configured");
        Err(AuthError::InvalidToken)
    }
}

/// Default-deny middleware for the `/api` subtree: authenticates the bearer
/// credential ([`resolve_credentials`]) and inserts [`AuthedUser`]. Routes
/// under this layer cannot skip authentication.
pub async fn require_auth(
    State(state): State<Arc<DaemonState>>,
    mut req: Request,
    next: Next,
) -> Response {
    match resolve_credentials(&state, req.headers()).await {
        Ok(user) => {
            req.extensions_mut().insert(user);
            next.run(req).await
        }
        Err(AuthError::Forbidden(message)) => forbidden(message),
        Err(AuthError::Db(e)) => {
            log::error!("auth backend error: {e}");
            server_error()
        }
        Err(reason) => {
            log::debug!("auth rejected: {reason:?}");
            unauthorized()
        }
    }
}

/// The viewer's DID on a public route, if the request authenticates as a
/// local user who has one. Optional by construction: a missing, invalid or
/// expired credential, a user without a DID, or a backend hiccup all give
/// `None` and the route proceeds as anonymous — a public page must never
/// fail because of a stale cookie.
#[derive(Debug, Clone)]
pub struct MaybeViewer(pub Option<Did>);

/// Blocking: `users.did` of a user, parsed.
fn user_did_parsed(db: &DbPool, user_id: &str) -> Option<Did> {
    let mut conn = db.get().ok()?;
    let did: Option<String> = users::table
        .find(user_id)
        .select(users::did)
        .first::<Option<String>>(&mut conn)
        .optional()
        .ok()
        .flatten()
        .flatten();
    Did::parse(&did?).ok()
}

/// [`MaybeViewer`] as a function, for handlers that already hold the
/// headers.
pub async fn viewer_did(state: &DaemonState, headers: &HeaderMap) -> Option<Did> {
    let user = match resolve_credentials(state, headers).await {
        Ok(user) => user,
        Err(AuthError::Missing) => return None,
        Err(AuthError::Db(e)) => {
            log::warn!("viewer identity unavailable (backend): {e}");
            return None;
        }
        Err(reason) => {
            log::debug!("viewer credential ignored: {reason:?}");
            return None;
        }
    };
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || user_did_parsed(&db, &user.user_id))
        .await
        .unwrap_or_else(|e| {
            log::warn!("viewer did task panicked: {e}");
            None
        })
}

impl FromRequestParts<Arc<DaemonState>> for MaybeViewer {
    type Rejection = Infallible;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &Arc<DaemonState>,
    ) -> Result<Self, Self::Rejection> {
        Ok(Self(viewer_did(state, &parts.headers).await))
    }
}

impl<S> FromRequestParts<S> for AuthedUser
where
    S: Send + Sync,
{
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        parts.extensions.get::<AuthedUser>().cloned().ok_or_else(|| {
            // A handler asked for AuthedUser on a route that isn't behind
            // require_auth — fail loudly rather than invent a context.
            log::error!(
                "AuthedUser extracted on a route outside the authenticated /api scope: {}",
                parts.uri.path()
            );
            server_error()
        })
    }
}

/// Serializable role for API responses.
impl Serialize for UserRole {
    fn serialize<Ser: serde::Serializer>(&self, s: Ser) -> Result<Ser::Ok, Ser::Error> {
        s.serialize_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::tenancy::{provision_user, NewTenant};
    use crate::db::test_support::{insert_user, test_pool};
    use axum::body::to_bytes;
    use axum::http::Request as HttpRequest;
    use tower::ServiceExt;

    async fn test_state() -> (Arc<DaemonState>, tempfile::TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        let hfs = hoardfs_volume::HoardFs::init(&tmp.path().join("hoardfs"))
            .await
            .unwrap();
        let state = Arc::new(DaemonState {
            db: test_pool(),
            hoardfs: Arc::new(std::sync::Mutex::new(hfs)),
            oidc: None,
            limits: Default::default(),
            session_key: [7u8; 32],
            processing: Default::default(),
            tetra3_db: None,
            handles: Default::default(),
            signer: None,
            mailer: Arc::new(crate::mail::LogMailer::default()),
            magic: Default::default(),
        });
        (state, tmp)
    }

    async fn get_me(router: &axum::Router, token: Option<&str>) -> (StatusCode, serde_json::Value) {
        let mut req = HttpRequest::builder().uri("/api/me");
        if let Some(t) = token {
            req = req.header("Authorization", format!("Bearer {t}"));
        }
        let resp = router
            .clone()
            .oneshot(req.body(axum::body::Body::empty()).unwrap())
            .await
            .unwrap();
        let status = resp.status();
        let bytes = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        let json = if bytes.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        (status, json)
    }

    #[test]
    fn mint_and_authenticate_round_trip() {
        let db = test_pool();
        insert_user(&db, "alice");

        let minted = mint_token(&db, "alice", "cli").unwrap();
        assert!(minted.token.starts_with("astra_"));
        assert_eq!(minted.token.len(), 6 + 64);

        // Only the hash hits the database.
        let stored: String = {
            use crate::db::schema::access_tokens::dsl::*;
            access_tokens
                .find(&minted.token_id)
                .select(token_hash)
                .first(&mut db.get().unwrap())
                .unwrap()
        };
        assert_ne!(stored, minted.token);
        assert_eq!(stored, hash_token(&minted.token));

        let authed = authenticate(&db, &minted.token).unwrap();
        assert_eq!(authed.user_id, "alice");
        assert_eq!(authed.role, UserRole::Member);

        // last_used_at stamped on successful auth.
        let last_used: Option<chrono::NaiveDateTime> = {
            use crate::db::schema::access_tokens::dsl::*;
            access_tokens
                .find(&minted.token_id)
                .select(last_used_at)
                .first(&mut db.get().unwrap())
                .unwrap()
        };
        assert!(last_used.is_some());
    }

    #[test]
    fn authenticate_rejects_garbage_revoked_and_inactive() {
        let db = test_pool();
        insert_user(&db, "alice");

        assert!(matches!(
            authenticate(&db, "astra_definitely_not_a_token"),
            Err(AuthError::InvalidToken)
        ));

        let minted = mint_token(&db, "alice", "cli").unwrap();
        assert!(revoke_token(&db, &minted.token_id).unwrap());
        assert!(matches!(
            authenticate(&db, &minted.token),
            Err(AuthError::InvalidToken)
        ));

        // Token for a not-yet-active user authenticates only after activation.
        let tmp = tempfile::tempdir().unwrap();
        let hfs = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(hoardfs_volume::HoardFs::init(&tmp.path().join("hoardfs")))
            .unwrap();
        provision_user(
            &mut db.get().unwrap(),
            &hfs,
            &NewTenant {
                id: "u-invited".to_string(),
                username: "newcomer".to_string(),
                display_name: None,
                email: None,
                external_subject: None,
                role: UserRole::Member,
                status: UserStatus::Invited,
            },
        )
        .unwrap();
        let invited_token = mint_token(&db, "u-invited", "onboarding").unwrap();
        assert!(matches!(
            authenticate(&db, &invited_token.token),
            Err(AuthError::InactiveUser)
        ));

        assert!(mint_token(&db, "nobody", "x").is_err());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn api_routes_require_valid_bearer() {
        let (state, _tmp) = test_state().await;
        insert_user(&state.db, "alice");
        let router = super::super::router(state.clone());

        let (status, _) = get_me(&router, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);

        let (status, _) = get_me(&router, Some("astra_garbage")).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);

        let db = state.db.clone();
        let minted =
            tokio::task::spawn_blocking(move || mint_token(&db, "alice", "test").unwrap())
                .await
                .unwrap();
        let (status, body) = get_me(&router, Some(&minted.token)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["userId"], "alice");
        assert_eq!(body["role"], "member");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn tokens_map_to_distinct_users() {
        let (state, _tmp) = test_state().await;
        insert_user(&state.db, "alice");
        insert_user(&state.db, "bob");
        let router = super::super::router(state.clone());

        let db = state.db.clone();
        let (alice_tok, bob_tok) = tokio::task::spawn_blocking(move || {
            (
                mint_token(&db, "alice", "a").unwrap(),
                mint_token(&db, "bob", "b").unwrap(),
            )
        })
        .await
        .unwrap();

        let (_, alice_body) = get_me(&router, Some(&alice_tok.token)).await;
        let (_, bob_body) = get_me(&router, Some(&bob_tok.token)).await;
        assert_eq!(alice_body["userId"], "alice");
        assert_eq!(bob_body["userId"], "bob");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn authed_user_outside_api_scope_fails_loudly() {
        // A route that takes AuthedUser but isn't behind require_auth must
        // 500 (misconfiguration), never fabricate a user context.
        let naked: axum::Router = axum::Router::new().route(
            "/naked",
            axum::routing::get(|user: AuthedUser| async move { user.user_id }),
        );
        let resp = naked
            .oneshot(
                HttpRequest::builder()
                    .uri("/naked")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }
}
