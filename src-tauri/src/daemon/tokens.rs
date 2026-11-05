//! Self-service personal access tokens: `/api/me/tokens`.
//!
//! A signed-in user lists, mints and revokes their own PATs here — the
//! credential the `astra-cli` uploader and the desktop push use. The
//! plaintext is returned exactly once, in the mint response; only its
//! SHA-256 lives in `access_tokens` (see [`super::auth`]).
//!
//! Policy: these routes refuse a caller who authenticated *with* a PAT
//! ([`Credential::Pat`] → 403). A token that leaks from a laptop can then
//! neither mint a replacement that outlives its own revocation nor revoke
//! the owner's other tokens; only an interactive sign-in (OIDC bearer or
//! the browser session cookie) manages tokens. The bootstrap path for a
//! server without OIDC stays `astra_daemon --mint-token`.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;

use super::auth::{self, AuthedUser, Credential};
use super::DaemonState;

/// Token labels are for the owner's eyes ("laptop", "observatory pi");
/// keep them short enough to render in a table.
const MAX_NAME_LEN: usize = 100;

fn forbidden_for_pat() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(serde_json::json!({
            "error": "forbidden",
            "message": "token management requires an interactive sign-in, not a personal access token",
        })),
    )
        .into_response()
}

fn internal(context: &str, e: String) -> Response {
    log::error!("{context}: {e}");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(serde_json::json!({ "error": "internal error" })),
    )
        .into_response()
}

/// `GET /api/me/tokens` → `{ "tokens": [TokenSummary…] }`, newest first.
pub async fn list(State(state): State<Arc<DaemonState>>, user: AuthedUser) -> Response {
    if user.credential == Credential::Pat {
        return forbidden_for_pat();
    }
    let db = state.db.clone();
    let user_id = user.user_id.clone();
    match tokio::task::spawn_blocking(move || auth::list_tokens(&db, &user_id)).await {
        Ok(Ok(tokens)) => Json(serde_json::json!({ "tokens": tokens })).into_response(),
        Ok(Err(e)) => internal("list tokens", e),
        Err(e) => internal("list tokens task", e.to_string()),
    }
}

#[derive(Debug, Deserialize)]
pub struct CreateTokenBody {
    name: String,
}

/// `POST /api/me/tokens {"name"}` → 201 `{ id, name, token, createdAt }`.
/// `token` is the plaintext — shown once, never retrievable again.
pub async fn create(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
    Json(body): Json<CreateTokenBody>,
) -> Response {
    if user.credential == Credential::Pat {
        return forbidden_for_pat();
    }
    let name = body.name.trim().to_string();
    if name.is_empty() || name.chars().count() > MAX_NAME_LEN {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "invalid name",
                "message": format!("name must be 1–{MAX_NAME_LEN} characters"),
            })),
        )
            .into_response();
    }
    let db = state.db.clone();
    let user_id = user.user_id.clone();
    match tokio::task::spawn_blocking(move || auth::mint_token(&db, &user_id, &name)).await {
        Ok(Ok(minted)) => (
            StatusCode::CREATED,
            Json(serde_json::json!({
                "id": minted.token_id,
                "name": minted.name,
                "token": minted.token,
                "createdAt": chrono::Utc::now().naive_utc(),
            })),
        )
            .into_response(),
        Ok(Err(e)) => internal("mint token", e),
        Err(e) => internal("mint token task", e.to_string()),
    }
}

/// `DELETE /api/me/tokens/{id}` → 204. 404 when the id is not one of the
/// caller's active tokens (unknown, already revoked, or someone else's —
/// deliberately indistinguishable).
pub async fn revoke(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
    Path(id): Path<String>,
) -> Response {
    if user.credential == Credential::Pat {
        return forbidden_for_pat();
    }
    let db = state.db.clone();
    let user_id = user.user_id.clone();
    match tokio::task::spawn_blocking(move || auth::revoke_owned_token(&db, &user_id, &id)).await {
        Ok(Ok(true)) => StatusCode::NO_CONTENT.into_response(),
        Ok(Ok(false)) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "not found" })),
        )
            .into_response(),
        Ok(Err(e)) => internal("revoke token", e),
        Err(e) => internal("revoke token task", e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use crate::daemon::auth::mint_token;
    use crate::daemon::session::{mint_cookie_value, COOKIE_NAME};
    use crate::daemon::DaemonState;
    use crate::db::test_support::{insert_user, test_pool};
    use axum::body::to_bytes;
    use axum::http::StatusCode;
    use std::sync::{Arc, Mutex};
    use tower::ServiceExt;

    const SESSION_KEY: [u8; 32] = [7u8; 32];

    async fn seeded() -> (Arc<DaemonState>, tempfile::TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        let db = test_pool();
        insert_user(&db, "alice");
        insert_user(&db, "bob");
        let hfs = hoardfs_volume::HoardFs::init(&tmp.path().join("hoardfs"))
            .await
            .unwrap();
        let state = Arc::new(DaemonState {
            db,
            hoardfs: Arc::new(Mutex::new(hfs)),
            oidc: None,
            limits: Default::default(),
            session_key: SESSION_KEY,
            processing: Default::default(),
            tetra3_db: None,
            handles: Default::default(),
            signer: None,
            mailer: Arc::new(crate::mail::LogMailer::default()),
            magic: Default::default(),
        });
        (state, tmp)
    }

    enum Cred<'a> {
        Cookie(&'a str),
        Bearer(&'a str),
    }

    async fn send(
        router: &axum::Router,
        method: &str,
        uri: &str,
        cred: Cred<'_>,
        body: Option<serde_json::Value>,
    ) -> (StatusCode, serde_json::Value) {
        let mut req = axum::http::Request::builder().method(method).uri(uri);
        req = match cred {
            Cred::Cookie(user_id) => {
                let value =
                    mint_cookie_value(&SESSION_KEY, user_id, chrono::Utc::now().timestamp() + 3600);
                req.header("Cookie", format!("{COOKIE_NAME}={value}"))
            }
            Cred::Bearer(token) => req.header("Authorization", format!("Bearer {token}")),
        };
        let body = match body {
            Some(v) => {
                req = req.header("Content-Type", "application/json");
                axum::body::Body::from(v.to_string())
            }
            None => axum::body::Body::empty(),
        };
        let resp = router
            .clone()
            .oneshot(req.body(body).unwrap())
            .await
            .unwrap();
        let status = resp.status();
        let bytes = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        let value = if bytes.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null)
        };
        (status, value)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn session_user_mints_lists_and_revokes_own_tokens() {
        let (state, _tmp) = seeded().await;
        let router = crate::daemon::router(state.clone());

        let (status, body) = send(
            &router,
            "GET",
            "/api/me/tokens",
            Cred::Cookie("alice"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["tokens"].as_array().unwrap().len(), 0);

        let (status, minted) = send(
            &router,
            "POST",
            "/api/me/tokens",
            Cred::Cookie("alice"),
            Some(serde_json::json!({ "name": "  laptop " })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{minted}");
        assert_eq!(minted["name"], "laptop");
        let plaintext = minted["token"].as_str().unwrap().to_string();
        assert!(plaintext.starts_with("astra_"));
        let token_id = minted["id"].as_str().unwrap().to_string();

        // The minted token authenticates as alice.
        let (status, me) = send(&router, "GET", "/api/me", Cred::Bearer(&plaintext), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(me["userId"], "alice");

        // Listed without the plaintext or hash.
        let (_, body) = send(
            &router,
            "GET",
            "/api/me/tokens",
            Cred::Cookie("alice"),
            None,
        )
        .await;
        let tokens = body["tokens"].as_array().unwrap();
        assert_eq!(tokens.len(), 1);
        assert_eq!(tokens[0]["id"], token_id);
        assert!(tokens[0].get("token").is_none());
        assert!(tokens[0].get("tokenHash").is_none());
        assert!(tokens[0]["lastUsedAt"].is_string(), "touched by /api/me");

        // Bob cannot see or revoke it.
        let (_, body) = send(&router, "GET", "/api/me/tokens", Cred::Cookie("bob"), None).await;
        assert_eq!(body["tokens"].as_array().unwrap().len(), 0);
        let (status, _) = send(
            &router,
            "DELETE",
            &format!("/api/me/tokens/{token_id}"),
            Cred::Cookie("bob"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = send(&router, "GET", "/api/me", Cred::Bearer(&plaintext), None).await;
        assert_eq!(status, StatusCode::OK, "bob's attempt changed nothing");

        // Alice revokes: the token stops working and disappears from the list.
        let (status, _) = send(
            &router,
            "DELETE",
            &format!("/api/me/tokens/{token_id}"),
            Cred::Cookie("alice"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let (status, _) = send(&router, "GET", "/api/me", Cred::Bearer(&plaintext), None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (_, body) = send(
            &router,
            "GET",
            "/api/me/tokens",
            Cred::Cookie("alice"),
            None,
        )
        .await;
        assert_eq!(body["tokens"].as_array().unwrap().len(), 0);
        let (status, _) = send(
            &router,
            "DELETE",
            &format!("/api/me/tokens/{token_id}"),
            Cred::Cookie("alice"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "revoke is not repeatable");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_pat_cannot_manage_tokens() {
        let (state, _tmp) = seeded().await;
        let router = crate::daemon::router(state.clone());
        let pat = mint_token(&state.db, "alice", "cli").unwrap().token;

        for (method, uri, body) in [
            ("GET", "/api/me/tokens".to_string(), None),
            (
                "POST",
                "/api/me/tokens".to_string(),
                Some(serde_json::json!({ "name": "escalated" })),
            ),
            ("DELETE", "/api/me/tokens/whatever".to_string(), None),
        ] {
            let (status, resp) = send(&router, method, &uri, Cred::Bearer(&pat), body).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri}: {resp}");
        }
        // …while the same PAT is still a perfectly good API credential.
        let (status, _) = send(&router, "GET", "/api/me", Cred::Bearer(&pat), None).await;
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn token_name_is_validated() {
        let (state, _tmp) = seeded().await;
        let router = crate::daemon::router(state.clone());
        for name in ["", "   ", &"x".repeat(101)] {
            let (status, _) = send(
                &router,
                "POST",
                "/api/me/tokens",
                Cred::Cookie("alice"),
                Some(serde_json::json!({ "name": name })),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "name {name:?}");
        }
    }
}
