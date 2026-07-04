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

use std::sync::Arc;

use axum::extract::{FromRequestParts, Request, State};
use axum::http::request::Parts;
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use diesel::prelude::*;
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::DaemonState;
use crate::db::schema::{access_tokens, users};
use crate::db::tenancy::{UserRole, UserStatus};
use crate::db::DbPool;

/// Authenticated per-request user context. There is no "current user"
/// global — handlers pass `user_id` to core fns explicitly.
#[derive(Debug, Clone)]
pub struct AuthedUser {
    pub user_id: String,
    pub role: UserRole,
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

    Ok(AuthedUser { user_id, role })
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

/// Default-deny middleware for the `/api` subtree: authenticates the bearer
/// credential and inserts [`AuthedUser`]. Routes under this layer cannot
/// skip authentication.
///
/// Two credential types share the header: personal access tokens carry the
/// `astra_` prefix; anything else is treated as an OIDC JWT and rejected
/// unless the daemon has OIDC configured.
pub async fn require_auth(
    State(state): State<Arc<DaemonState>>,
    mut req: Request,
    next: Next,
) -> Response {
    let Some(token) = bearer_token(req.headers()).map(str::to_owned) else {
        return unauthorized();
    };

    let result = if token.starts_with("astra_") {
        let db = state.db.clone();
        tokio::task::spawn_blocking(move || authenticate(&db, &token)).await
    } else if let Some(oidc) = state.oidc.clone() {
        match oidc.verify(&token).await {
            Ok(claims) => {
                let db = state.db.clone();
                let hoardfs = state.hoardfs.clone();
                tokio::task::spawn_blocking(move || {
                    super::oidc::resolve_user(&db, &hoardfs, &claims)
                })
                .await
            }
            Err(reason) => {
                log::debug!("OIDC token rejected: {reason}");
                return unauthorized();
            }
        }
    } else {
        log::debug!("JWT presented but OIDC is not configured");
        return unauthorized();
    };

    match result {
        Ok(Ok(user)) => {
            req.extensions_mut().insert(user);
            next.run(req).await
        }
        Ok(Err(AuthError::Forbidden(message))) => forbidden(message),
        Ok(Err(AuthError::Db(e))) => {
            log::error!("auth backend error: {e}");
            server_error()
        }
        Ok(Err(reason)) => {
            log::debug!("auth rejected: {reason:?}");
            unauthorized()
        }
        Err(e) => {
            log::error!("auth task panicked: {e}");
            server_error()
        }
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
