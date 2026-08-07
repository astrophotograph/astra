//! Browser sessions: a stateless signed cookie so web clients (and plain
//! `<img>` tags, which cannot send Authorization headers) authenticate
//! against the daemon.
//!
//! `POST /api/session` verifies a Zitadel **ID token** (access tokens lack
//! the email claim invite-matching needs) through the same invite-gated
//! [`super::oidc::resolve_user`] path as bearer JWTs, then sets an HttpOnly
//! cookie `astra_session=<user_id_b64>.<exp>.<hmac>` signed with a key
//! generated once into `{data_dir}/session-key` (0600). No session table —
//! the cookie is self-authenticating and [`super::auth::require_auth`]
//! re-checks the user's status on every request, so disabling a user kills
//! their sessions immediately.
//!
//! These two routes are registered AFTER the auth layer in
//! `daemon::router` (axum layers only wrap routes added before them) —
//! logging in is how you obtain credentials.

use std::path::Path;
use std::sync::Arc;

use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64URL, Engine};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::Sha256;

use super::DaemonState;

pub const COOKIE_NAME: &str = "astra_session";
const SESSION_TTL_SECS: i64 = 7 * 24 * 3600;

type HmacSha256 = Hmac<Sha256>;

/// Load the cookie-signing key, generating it on first boot (0600).
pub fn load_or_create_session_key(data_dir: &Path) -> Result<[u8; 32], String> {
    let path = data_dir.join("session-key");
    if path.exists() {
        let hex_str = std::fs::read_to_string(&path)
            .map_err(|e| format!("read session key: {e}"))?;
        let bytes = hex::decode(hex_str.trim()).map_err(|e| format!("session key: {e}"))?;
        return bytes
            .try_into()
            .map_err(|_| "session key must be 32 bytes".to_string());
    }

    let mut key = [0u8; 32];
    getrandom::fill(&mut key).map_err(|e| format!("random source: {e}"))?;
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .map_err(|e| format!("create session key: {e}"))?;
        f.write_all(hex::encode(key).as_bytes())
            .map_err(|e| format!("write session key: {e}"))?;
    }
    #[cfg(not(unix))]
    std::fs::write(&path, hex::encode(key)).map_err(|e| format!("write session key: {e}"))?;
    Ok(key)
}

fn signature(key: &[u8], payload: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(key).expect("hmac accepts any key length");
    mac.update(payload.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// `<user_id_b64url>.<exp_unix>.<hmac_hex>`
pub fn mint_cookie_value(key: &[u8], user_id: &str, expires_at_unix: i64) -> String {
    let payload = format!("{}.{}", B64URL.encode(user_id), expires_at_unix);
    let sig = signature(key, &payload);
    format!("{payload}.{sig}")
}

/// Verify signature + expiry; returns the user id.
pub fn verify_cookie_value(key: &[u8], value: &str, now_unix: i64) -> Option<String> {
    let mut parts = value.splitn(3, '.');
    let (user_b64, exp_str, sig) = (parts.next()?, parts.next()?, parts.next()?);
    let payload = format!("{user_b64}.{exp_str}");

    let mut mac = HmacSha256::new_from_slice(key).ok()?;
    mac.update(payload.as_bytes());
    mac.verify_slice(&hex::decode(sig).ok()?).ok()?;

    let exp: i64 = exp_str.parse().ok()?;
    if exp <= now_unix {
        return None;
    }
    String::from_utf8(B64URL.decode(user_b64).ok()?).ok()
}

/// Pull the session cookie value out of request headers, if any.
pub fn cookie_from_headers(headers: &HeaderMap) -> Option<String> {
    let prefix = format!("{COOKIE_NAME}=");
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|line| line.split(';'))
        .map(str::trim)
        .find_map(|pair| pair.strip_prefix(prefix.as_str()).map(str::to_string))
}

fn set_cookie(value: &str, max_age: i64) -> String {
    format!("{COOKIE_NAME}={value}; Path=/; Max-Age={max_age}; HttpOnly; Secure; SameSite=Lax")
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionBody {
    id_token: String,
}

/// `POST /api/session` — Zitadel ID token in, session cookie out.
pub async fn create_session(
    State(state): State<Arc<DaemonState>>,
    Json(body): Json<CreateSessionBody>,
) -> Response {
    let Some(oidc) = state.oidc.clone() else {
        log::debug!("session login attempted but OIDC is not configured");
        return unauthorized();
    };

    let claims = match oidc.verify(&body.id_token).await {
        Ok(claims) => claims,
        Err(reason) => {
            log::debug!("session login rejected: {reason}");
            return unauthorized();
        }
    };

    let (sub, email) = (claims.sub.clone(), claims.email.clone());
    let db = state.db.clone();
    let hoardfs = state.hoardfs.clone();
    let resolved = tokio::task::spawn_blocking(move || {
        super::oidc::resolve_user(&db, &hoardfs, &claims)
    })
    .await;

    let user = match resolved {
        Ok(Ok(user)) => user,
        Ok(Err(super::auth::AuthError::Forbidden(message))) => {
            // The one place a rejected login is diagnosable server-side:
            // which subject knocked, and why it was turned away.
            log::info!(
                "session login forbidden for sub {sub} (email {}): {message}",
                email.as_deref().unwrap_or("-")
            );
            return (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({ "error": "forbidden", "message": message })),
            )
                .into_response()
        }
        Ok(Err(super::auth::AuthError::Db(e))) => {
            log::error!("session login backend error: {e}");
            return server_error();
        }
        Ok(Err(reason)) => {
            log::debug!("session login rejected: {reason:?}");
            return unauthorized();
        }
        Err(e) => {
            log::error!("session login task panicked: {e}");
            return server_error();
        }
    };

    let expires_at = chrono::Utc::now().timestamp() + SESSION_TTL_SECS;
    let cookie = set_cookie(
        &mint_cookie_value(&state.session_key, &user.user_id, expires_at),
        SESSION_TTL_SECS,
    );

    let db = state.db.clone();
    let me = match tokio::task::spawn_blocking(move || super::fetch_me(&db, &user)).await {
        Ok(Ok(me)) => me,
        Ok(Err(e)) => {
            log::error!("session me lookup failed: {e}");
            return server_error();
        }
        Err(e) => {
            log::error!("session me task panicked: {e}");
            return server_error();
        }
    };

    let mut response = Json(me).into_response();
    if let Ok(value) = cookie.parse() {
        response.headers_mut().insert(header::SET_COOKIE, value);
    }
    response
}

/// `DELETE /api/session` — clears the cookie (stateless server side).
pub async fn destroy_session() -> Response {
    let mut response = StatusCode::NO_CONTENT.into_response();
    if let Ok(value) = set_cookie("", 0).parse() {
        response.headers_mut().insert(header::SET_COOKIE, value);
    }
    response
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::oidc::test_jwt::{sign, valid_claims, verifier};
    use crate::db::schema::users;
    use crate::db::tenancy::UserStatus;
    use crate::db::test_support::{insert_user, test_pool};
    use axum::body::to_bytes;
    use diesel::prelude::*;
    use std::sync::Mutex;
    use tower::ServiceExt;

    const TEST_KEY: [u8; 32] = [7u8; 32];

    async fn test_state() -> (Arc<DaemonState>, tempfile::TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        let hfs = hoardfs_volume::HoardFs::init(&tmp.path().join("hoardfs"))
            .await
            .unwrap();
        let state = Arc::new(DaemonState {
            db: test_pool(),
            hoardfs: Arc::new(Mutex::new(hfs)),
            oidc: Some(Arc::new(verifier())),
            limits: Default::default(),
            session_key: TEST_KEY,
            processing: Default::default(),
        });
        (state, tmp)
    }

    fn insert_invited(db: &crate::db::DbPool, id: &str, email: &str) {
        diesel::insert_into(users::table)
            .values((
                users::id.eq(id),
                users::email.eq(Some(email)),
                users::status.eq(UserStatus::Invited.as_str()),
            ))
            .execute(&mut db.get().unwrap())
            .unwrap();
    }

    async fn login(
        router: &axum::Router,
        id_token: &str,
    ) -> (StatusCode, Option<String>, serde_json::Value) {
        let resp = router
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/api/session")
                    .header("Content-Type", "application/json")
                    .body(axum::body::Body::from(
                        serde_json::json!({ "idToken": id_token }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = resp.status();
        let cookie = resp
            .headers()
            .get(header::SET_COOKIE)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.split(';').next())
            .and_then(|s| s.strip_prefix(&format!("{COOKIE_NAME}=")))
            .map(str::to_string);
        let bytes = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, cookie, json)
    }

    async fn get_with_cookie(
        router: &axum::Router,
        uri: &str,
        cookie: &str,
    ) -> (StatusCode, serde_json::Value) {
        let resp = router
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri(uri)
                    .header(header::COOKIE, format!("{COOKIE_NAME}={cookie}"))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = resp.status();
        let bytes = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, json)
    }

    #[test]
    fn cookie_mint_verify_round_trip_and_tampering() {
        let now = 1_800_000_000;
        let value = mint_cookie_value(&TEST_KEY, "user-1", now + 100);
        assert_eq!(
            verify_cookie_value(&TEST_KEY, &value, now).as_deref(),
            Some("user-1")
        );
        // Expired.
        let stale = mint_cookie_value(&TEST_KEY, "user-1", now - 1);
        assert!(verify_cookie_value(&TEST_KEY, &stale, now).is_none());
        // Tampered signature and payload.
        let mut bytes = value.clone().into_bytes();
        let last = bytes.len() - 1;
        bytes[last] = if bytes[last] == b'0' { b'1' } else { b'0' };
        let tampered = String::from_utf8(bytes).unwrap();
        assert!(verify_cookie_value(&TEST_KEY, &tampered, now).is_none());
        let forged = value.replacen(&B64URL.encode("user-1"), &B64URL.encode("user-2"), 1);
        assert!(verify_cookie_value(&TEST_KEY, &forged, now).is_none());
        // Wrong key.
        assert!(verify_cookie_value(&[9u8; 32], &value, now).is_none());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn login_sets_cookie_and_cookie_authenticates_api() {
        let (state, _tmp) = test_state().await;
        insert_invited(&state.db, "u-web", "web@example.org");
        let router = crate::daemon::router(state.clone());

        let token = sign(
            &valid_claims("zitadel|web", Some("web@example.org"), Some("webby")),
            "test-key",
        );
        let (status, cookie, body) = login(&router, &token).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["userId"], "u-web");
        assert_eq!(body["status"], "active");
        let cookie = cookie.expect("session cookie set");

        // Cookie alone authenticates /api routes — including image URLs.
        let (status, me) = get_with_cookie(&router, "/api/me", &cookie).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(me["userId"], "u-web");
        let (status, images) = get_with_cookie(&router, "/api/images", &cookie).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(images["total"], 0);

        // No cookie, no bearer → still 401.
        let resp = router
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/me")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn bad_sessions_rejected_and_logout_clears() {
        let (state, _tmp) = test_state().await;
        insert_invited(&state.db, "u-web", "web@example.org");
        let router = crate::daemon::router(state.clone());
        let token = sign(
            &valid_claims("zitadel|web", Some("web@example.org"), None),
            "test-key",
        );
        let (_, cookie, _) = login(&router, &token).await;
        let cookie = cookie.unwrap();

        // Tampered cookie → 401 (flip the last signature nibble).
        let mut tampered = cookie.clone();
        let last = tampered.pop().unwrap();
        tampered.push(if last == '0' { '1' } else { '0' });
        let (status, _) = get_with_cookie(&router, "/api/me", &tampered).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);

        // Expired cookie → 401.
        let expired = mint_cookie_value(
            &TEST_KEY,
            "u-web",
            chrono::Utc::now().timestamp() - 10,
        );
        let (status, _) = get_with_cookie(&router, "/api/me", &expired).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);

        // Disabling the user kills live sessions (status re-checked).
        diesel::update(users::table.find("u-web"))
            .set(users::status.eq(UserStatus::Disabled.as_str()))
            .execute(&mut state.db.get().unwrap())
            .unwrap();
        let (status, _) = get_with_cookie(&router, "/api/me", &cookie).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);

        // Logout clears the cookie client-side.
        let resp = router
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("DELETE")
                    .uri("/api/session")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);
        let set = resp
            .headers()
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(set.contains("Max-Age=0"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn uninvited_login_gets_friendly_403() {
        let (state, _tmp) = test_state().await;
        let router = crate::daemon::router(state.clone());
        let token = sign(
            &valid_claims("zitadel|nope", Some("nope@example.org"), None),
            "test-key",
        );
        let (status, cookie, body) = login(&router, &token).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(cookie.is_none());
        assert_eq!(body["message"], "invite required");

        // Garbage ID token → 401.
        let (status, _, _) = login(&router, "not.a.jwt").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn session_key_persists_across_loads() {
        let tmp = tempfile::tempdir().unwrap();
        let k1 = load_or_create_session_key(tmp.path()).unwrap();
        let k2 = load_or_create_session_key(tmp.path()).unwrap();
        assert_eq!(k1, k2);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(tmp.path().join("session-key"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }
}
