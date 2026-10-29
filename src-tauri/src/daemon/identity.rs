//! Identity linking: `PUT /api/me/did` records the caller's AT Protocol
//! DID on their `users` row. Signed publishing (`share::records`) writes
//! records under `at://<did>/...`, so a user without a DID keeps publishing
//! the legacy way. Minting the DID (and registering the daemon's app key in
//! its document) happens out of band with `kenning mint`.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use diesel::prelude::*;
use serde::Deserialize;

use super::auth::AuthedUser;
use super::DaemonState;
use crate::db::schema::users;

#[derive(Debug, Deserialize)]
pub struct DidBody {
    pub did: String,
}

enum SetDidError {
    /// Another user already holds this DID.
    Taken,
    Db(String),
}

/// `PUT /api/me/did {"did": "did:plc:..."}` → `200 {"userId", "did"}`.
/// 400 for anything `kenning::Did::parse` rejects, 409 when the DID is
/// already another user's. Re-setting one's own DID is idempotent.
pub async fn set_did(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
    Json(body): Json<DidBody>,
) -> Response {
    let did = match kenning::Did::parse(body.did.trim()) {
        Ok(d) => d,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "invalid did",
                    "message": e.to_string(),
                })),
            )
                .into_response();
        }
    };

    let db = state.db.clone();
    let user_id = user.user_id.clone();
    let did_str = did.as_str().to_string();
    let result = tokio::task::spawn_blocking(move || -> Result<(), SetDidError> {
        let mut conn = db.get().map_err(|e| SetDidError::Db(e.to_string()))?;
        let holder: Option<String> = users::table
            .filter(users::did.eq(&did_str))
            .select(users::id)
            .first(&mut conn)
            .optional()
            .map_err(|e| SetDidError::Db(e.to_string()))?;
        if holder.as_deref().is_some_and(|h| h != user_id) {
            return Err(SetDidError::Taken);
        }
        match diesel::update(users::table.find(&user_id))
            .set((
                users::did.eq(Some(&did_str)),
                users::updated_at.eq(chrono::Utc::now().naive_utc()),
            ))
            .execute(&mut conn)
        {
            Ok(_) => Ok(()),
            // The partial unique index closes the check-then-set race.
            Err(diesel::result::Error::DatabaseError(
                diesel::result::DatabaseErrorKind::UniqueViolation,
                _,
            )) => Err(SetDidError::Taken),
            Err(e) => Err(SetDidError::Db(e.to_string())),
        }
    })
    .await;

    match result {
        Ok(Ok(())) => Json(serde_json::json!({
            "userId": user.user_id,
            "did": did.as_str(),
        }))
        .into_response(),
        Ok(Err(SetDidError::Taken)) => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "error": "did already linked to another user",
            })),
        )
            .into_response(),
        Ok(Err(SetDidError::Db(e))) => super::api::internal("set_did", e),
        Err(e) => super::api::internal("set_did task", e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::auth::mint_token;
    use crate::db::test_support::{insert_user, test_pool};
    use axum::body::{to_bytes, Body};
    use axum::http::{header, Request};
    use tower::ServiceExt;

    async fn put_did(
        router: &axum::Router,
        token: &str,
        body: &str,
    ) -> (StatusCode, serde_json::Value) {
        let resp = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/me/did")
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = resp.status();
        let bytes = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, json)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn set_did_valid_invalid_duplicate() {
        let tmp = tempfile::tempdir().unwrap();
        let db = test_pool();
        insert_user(&db, "alice");
        insert_user(&db, "bob");
        let alice = mint_token(&db, "alice", "t").unwrap().token;
        let bob = mint_token(&db, "bob", "t").unwrap().token;
        let hfs = hoardfs_volume::HoardFs::init(&tmp.path().join("hoardfs"))
            .await
            .unwrap();
        let state = Arc::new(DaemonState {
            db: db.clone(),
            hoardfs: Arc::new(std::sync::Mutex::new(hfs)),
            oidc: None,
            limits: Default::default(),
            session_key: [7u8; 32],
            processing: Default::default(),
            tetra3_db: None,
            signer: None,
        });
        let router = crate::daemon::router(state);

        // Valid: stored and echoed.
        let did = "did:plc:z72i7hdynmk6r22z27h6tvur";
        let (status, json) = put_did(&router, &alice, &format!(r#"{{"did":"{did}"}}"#)).await;
        assert_eq!(status, StatusCode::OK, "{json}");
        assert_eq!(json["did"], did);
        assert_eq!(json["userId"], "alice");
        let stored: Option<String> = users::table
            .find("alice")
            .select(users::did)
            .first(&mut db.get().unwrap())
            .unwrap();
        assert_eq!(stored.as_deref(), Some(did));

        // Idempotent for the same user.
        let (status, _) = put_did(&router, &alice, &format!(r#"{{"did":"{did}"}}"#)).await;
        assert_eq!(status, StatusCode::OK);

        // Invalid DIDs → 400, row untouched.
        for bad in ["not-a-did", "did:plc:", "did:key:zQ3sh", "", "did:PLC:abc"] {
            let (status, _) = put_did(&router, &bob, &format!(r#"{{"did":"{bad}"}}"#)).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{bad:?}");
        }

        // Duplicate → 409.
        let (status, json) = put_did(&router, &bob, &format!(r#"{{"did":"{did}"}}"#)).await;
        assert_eq!(status, StatusCode::CONFLICT, "{json}");
        let bob_did: Option<String> = users::table
            .find("bob")
            .select(users::did)
            .first(&mut db.get().unwrap())
            .unwrap();
        assert!(bob_did.is_none());

        // Unauthenticated → 401 (behind the auth layer).
        let resp = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/me/did")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(format!(r#"{{"did":"{did}"}}"#)))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }
}
