//! Authed social API: follow/unfollow, follower listings, and counts.
//!
//! Worker parity (`worker/src/routes/social.ts`) over the Kith stores.
//! Nested under the authed `/api` router — every route requires auth; the
//! public counts surface arrives later with the gallery pages leaf.
//!
//! Kith `UserId` is the daemon `users.id` (`AuthedUser.user_id`), never the
//! raw OIDC subject — no aliasing layer.

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use kith::error::KithError;
use kith::types::{EntityId, EntityKind, PageRequest, UserId};
use serde::Deserialize;
use serde_json::json;

use super::auth::AuthedUser;
use super::DaemonState;

const DEFAULT_PAGE_LIMIT: u32 = 20;
const MAX_PAGE_LIMIT: u32 = 100;

pub fn routes() -> Router<Arc<DaemonState>> {
    Router::new()
        .route(
            "/follow",
            axum::routing::post(follow).delete(unfollow),
        )
        .route("/is-following", get(is_following))
        .route("/followers/{kind}/{id}", get(followers))
        .route("/following", get(following))
        .route("/counts/{kind}/{id}", get(counts))
        .route("/mutual/{user_id}", get(mutual))
}

/// `user | object | collection` — the kinds the social surface accepts for
/// now. Anything else is a 400, not an `EntityKind::Custom` passthrough.
fn parse_target_kind(kind: &str) -> Option<EntityKind> {
    match kind {
        "user" => Some(EntityKind::User),
        "object" => Some(EntityKind::Object),
        "collection" => Some(EntityKind::Collection),
        _ => None,
    }
}

fn bad_request(msg: impl std::fmt::Display) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": msg.to_string() })),
    )
        .into_response()
}

fn kith_error(context: &str, e: KithError) -> Response {
    match e {
        KithError::InvalidInput(msg) => bad_request(msg),
        KithError::NotFound(msg) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": msg })),
        )
            .into_response(),
        other => super::api::internal(context, other.to_string()),
    }
}

#[derive(Debug, Deserialize)]
pub struct TargetBody {
    target_kind: String,
    target_id: String,
}

#[derive(Debug, Deserialize)]
pub struct TargetParams {
    target_kind: String,
    target_id: String,
}

#[derive(Debug, Deserialize)]
pub struct PageParams {
    limit: Option<u32>,
    cursor: Option<String>,
}

impl PageParams {
    fn request(self) -> PageRequest {
        PageRequest {
            limit: self
                .limit
                .unwrap_or(DEFAULT_PAGE_LIMIT)
                .min(MAX_PAGE_LIMIT),
            cursor: self.cursor,
        }
    }
}

/// POST /api/social/follow — follow a user/object/collection and
/// auto-subscribe to its events (worker parity).
pub async fn follow(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
    Json(body): Json<TargetBody>,
) -> Response {
    let Some(kind) = parse_target_kind(&body.target_kind) else {
        return bad_request(format!("unsupported target_kind '{}'", body.target_kind));
    };
    let actor = UserId(user.user_id);
    let target = EntityId::new(kind, body.target_id);

    // Self-follow / follow-while-blocked surface as InvalidInput → 400.
    if let Err(e) = state.social().follow(&actor, &target).await {
        return kith_error("social follow", e);
    }

    // Auto-subscribe, idempotently: a second follow (or a follow after a
    // manual subscribe) must not stack subscriptions.
    let store = state.kith();
    match kith::storage::SubscriptionStore::subscriptions_for(&store, &actor).await {
        Ok(subs) if subs.iter().any(|s| s.topic == target) => {}
        Ok(_) => {
            if let Err(e) = kith::storage::SubscriptionStore::subscribe(
                &store,
                &actor,
                &target,
                Default::default(),
            )
            .await
            {
                return kith_error("social auto-subscribe", e);
            }
        }
        Err(e) => return kith_error("social auto-subscribe", e),
    }

    StatusCode::NO_CONTENT.into_response()
}

/// DELETE /api/social/follow — unfollow and drop the auto-subscription.
pub async fn unfollow(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
    Json(body): Json<TargetBody>,
) -> Response {
    let Some(kind) = parse_target_kind(&body.target_kind) else {
        return bad_request(format!("unsupported target_kind '{}'", body.target_kind));
    };
    let actor = UserId(user.user_id);
    let target = EntityId::new(kind, body.target_id);

    if let Err(e) = state.social().unfollow(&actor, &target).await {
        return kith_error("social unfollow", e);
    }

    let store = state.kith();
    match kith::storage::SubscriptionStore::subscriptions_for(&store, &actor).await {
        Ok(subs) => {
            for sub in subs.iter().filter(|s| s.topic == target) {
                if let Err(e) =
                    kith::storage::SubscriptionStore::unsubscribe(&store, &sub.id).await
                {
                    return kith_error("social unsubscribe", e);
                }
            }
        }
        Err(e) => return kith_error("social unsubscribe", e),
    }

    StatusCode::NO_CONTENT.into_response()
}

/// GET /api/social/is-following?target_kind=&target_id=
pub async fn is_following(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
    Query(params): Query<TargetParams>,
) -> Response {
    let Some(kind) = parse_target_kind(&params.target_kind) else {
        return bad_request(format!("unsupported target_kind '{}'", params.target_kind));
    };
    let actor = UserId(user.user_id);
    let target = EntityId::new(kind, params.target_id);

    match state.social().is_following(&actor, &target).await {
        Ok(following) => Json(json!({ "following": following })).into_response(),
        Err(e) => kith_error("social is-following", e),
    }
}

/// GET /api/social/followers/{kind}/{id}?limit=&cursor=
pub async fn followers(
    State(state): State<Arc<DaemonState>>,
    _user: AuthedUser,
    Path((kind, id)): Path<(String, String)>,
    Query(page): Query<PageParams>,
) -> Response {
    let Some(kind) = parse_target_kind(&kind) else {
        return bad_request(format!("unsupported target_kind '{kind}'"));
    };
    let target = EntityId::new(kind, id);

    let result = kith::storage::GraphStore::followers_page(
        &state.kith(),
        &target,
        &kith::types::EdgeKind::Follow,
        &page.request(),
    )
    .await;
    match result {
        Ok(page) => {
            let items: Vec<_> = page
                .items
                .iter()
                .map(|e| {
                    json!({
                        "user_id": e.actor.0,
                        "created_at": e.created_at.to_rfc3339(),
                    })
                })
                .collect();
            Json(json!({
                "items": items,
                "next_cursor": page.next_cursor,
                "total": page.total,
            }))
            .into_response()
        }
        Err(e) => kith_error("social followers", e),
    }
}

/// GET /api/social/following?limit=&cursor= — the caller's follow edges.
/// Same envelope as `followers`; items carry the target entity (followed
/// things aren't always users, so `user_id` alone would be lossy).
pub async fn following(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
    Query(page): Query<PageParams>,
) -> Response {
    let actor = UserId(user.user_id);

    let result = kith::storage::GraphStore::following_page(
        &state.kith(),
        &actor,
        &kith::types::EdgeKind::Follow,
        &page.request(),
    )
    .await;
    match result {
        Ok(page) => {
            let items: Vec<_> = page
                .items
                .iter()
                .map(|e| {
                    json!({
                        "target_kind": e.target.kind.to_string(),
                        "target_id": e.target.id,
                        "created_at": e.created_at.to_rfc3339(),
                    })
                })
                .collect();
            Json(json!({
                "items": items,
                "next_cursor": page.next_cursor,
                "total": page.total,
            }))
            .into_response()
        }
        Err(e) => kith_error("social following", e),
    }
}

/// GET /api/social/counts/{kind}/{id} — follower count, plus following
/// count when the entity is a user.
pub async fn counts(
    State(state): State<Arc<DaemonState>>,
    _user: AuthedUser,
    Path((kind, id)): Path<(String, String)>,
) -> Response {
    let Some(entity_kind) = parse_target_kind(&kind) else {
        return bad_request(format!("unsupported target_kind '{kind}'"));
    };
    let is_user = entity_kind == EntityKind::User;
    let target = EntityId::new(entity_kind, id.clone());

    let graph = state.social();
    let followers = match graph.follower_count(&target).await {
        Ok(n) => n,
        Err(e) => return kith_error("social counts", e),
    };
    let mut body = json!({ "followers": followers });
    if is_user {
        match graph.following_count(&UserId(id)).await {
            Ok(n) => body["following"] = json!(n),
            Err(e) => return kith_error("social counts", e),
        }
    }
    Json(body).into_response()
}

/// GET /api/social/mutual/{user_id} — do the caller and `user_id` follow
/// each other?
pub async fn mutual(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
    Path(other): Path<String>,
) -> Response {
    let me = UserId(user.user_id);
    match state.social().is_mutual(&me, &UserId(other)).await {
        Ok(mutual) => Json(json!({ "mutual": mutual })).into_response(),
        Err(e) => kith_error("social mutual", e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::auth::mint_token;
    use crate::daemon::router;
    use crate::db::test_support::{insert_user, test_pool};
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use kith::storage::SubscriptionStore;
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
        });
        (state, tmp)
    }

    /// (router, state, alice's bearer token, tempdir guard)
    async fn setup() -> (Router, Arc<DaemonState>, String, tempfile::TempDir) {
        let (state, tmp) = test_state().await;
        insert_user(&state.db, "alice");
        insert_user(&state.db, "bob");
        let token = mint_token(&state.db, "alice", "test").unwrap().token;
        (router(state.clone()), state, token, tmp)
    }

    async fn send(
        router: &Router,
        method: &str,
        uri: &str,
        token: Option<&str>,
        body: Option<serde_json::Value>,
    ) -> (StatusCode, serde_json::Value) {
        let mut req = Request::builder().method(method).uri(uri);
        if let Some(t) = token {
            req = req.header("Authorization", format!("Bearer {t}"));
        }
        let body = match body {
            Some(json) => {
                req = req.header("Content-Type", "application/json");
                Body::from(json.to_string())
            }
            None => Body::empty(),
        };
        let resp = router.clone().oneshot(req.body(body).unwrap()).await.unwrap();
        let status = resp.status();
        let bytes = to_bytes(resp.into_body(), 1 << 20).await.unwrap();
        let json = if bytes.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        (status, json)
    }

    fn follow_body(kind: &str, id: &str) -> serde_json::Value {
        json!({ "target_kind": kind, "target_id": id })
    }

    #[tokio::test]
    async fn routes_require_auth() {
        let (router, _state, _token, _tmp) = setup().await;
        for (method, uri) in [
            ("POST", "/api/social/follow"),
            ("DELETE", "/api/social/follow"),
            ("GET", "/api/social/is-following?target_kind=user&target_id=bob"),
            ("GET", "/api/social/followers/user/bob"),
            ("GET", "/api/social/following"),
            ("GET", "/api/social/counts/user/bob"),
            ("GET", "/api/social/mutual/bob"),
        ] {
            let (status, _) = send(&router, method, uri, None, None).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {uri}");
        }
    }

    #[tokio::test]
    async fn follow_lifecycle() {
        let (router, _state, token, _tmp) = setup().await;
        let t = Some(token.as_str());

        // Not following yet.
        let (status, body) = send(
            &router,
            "GET",
            "/api/social/is-following?target_kind=user&target_id=bob",
            t,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["following"], false);

        // Follow → 204.
        let (status, _) = send(
            &router,
            "POST",
            "/api/social/follow",
            t,
            Some(follow_body("user", "bob")),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);

        let (_, body) = send(
            &router,
            "GET",
            "/api/social/is-following?target_kind=user&target_id=bob",
            t,
            None,
        )
        .await;
        assert_eq!(body["following"], true);

        // Followers list carries alice; counts increment.
        let (status, body) = send(&router, "GET", "/api/social/followers/user/bob", t, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["total"], 1);
        assert_eq!(body["items"][0]["user_id"], "alice");
        assert!(body["items"][0]["created_at"].is_string());

        let (_, body) = send(&router, "GET", "/api/social/counts/user/bob", t, None).await;
        assert_eq!(body["followers"], 1);
        assert_eq!(body["following"], 0, "bob follows nobody");

        let (_, body) = send(&router, "GET", "/api/social/following", t, None).await;
        assert_eq!(body["total"], 1);
        assert_eq!(body["items"][0]["target_kind"], "user");
        assert_eq!(body["items"][0]["target_id"], "bob");

        // Unfollow → gone everywhere.
        let (status, _) = send(
            &router,
            "DELETE",
            "/api/social/follow",
            t,
            Some(follow_body("user", "bob")),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);

        let (_, body) = send(
            &router,
            "GET",
            "/api/social/is-following?target_kind=user&target_id=bob",
            t,
            None,
        )
        .await;
        assert_eq!(body["following"], false);
        let (_, body) = send(&router, "GET", "/api/social/counts/user/bob", t, None).await;
        assert_eq!(body["followers"], 0);
    }

    #[tokio::test]
    async fn self_follow_is_rejected() {
        let (router, _state, token, _tmp) = setup().await;
        let (status, body) = send(
            &router,
            "POST",
            "/api/social/follow",
            Some(&token),
            Some(follow_body("user", "alice")),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"].as_str().unwrap().contains("yourself"));
    }

    #[tokio::test]
    async fn unknown_target_kind_is_rejected() {
        let (router, _state, token, _tmp) = setup().await;
        let (status, _) = send(
            &router,
            "POST",
            "/api/social/follow",
            Some(&token),
            Some(follow_body("planet", "jupiter")),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn follow_auto_subscribes_exactly_once() {
        let (router, state, token, _tmp) = setup().await;
        let t = Some(token.as_str());
        let alice = UserId::from("alice");

        // Follow twice: the graph upsert is idempotent, and so must be the
        // auto-subscription.
        for _ in 0..2 {
            let (status, _) = send(
                &router,
                "POST",
                "/api/social/follow",
                t,
                Some(follow_body("object", "M42")),
            )
            .await;
            assert_eq!(status, StatusCode::NO_CONTENT);
        }
        let subs = state.kith().subscriptions_for(&alice).await.unwrap();
        assert_eq!(subs.len(), 1);
        assert_eq!(subs[0].topic, EntityId::object("M42"));

        // Unfollow removes the auto-subscription.
        let (status, _) = send(
            &router,
            "DELETE",
            "/api/social/follow",
            t,
            Some(follow_body("object", "M42")),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert!(state
            .kith()
            .subscriptions_for(&alice)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn mutual_follow_detection() {
        let (router, state, token, _tmp) = setup().await;
        let t = Some(token.as_str());

        let (_, body) = send(&router, "GET", "/api/social/mutual/bob", t, None).await;
        assert_eq!(body["mutual"], false);

        // alice → bob via the API; bob → alice directly through the store.
        let (status, _) = send(
            &router,
            "POST",
            "/api/social/follow",
            t,
            Some(follow_body("user", "bob")),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        state
            .social()
            .follow(&UserId::from("bob"), &EntityId::user(&UserId::from("alice")))
            .await
            .unwrap();

        let (_, body) = send(&router, "GET", "/api/social/mutual/bob", t, None).await;
        assert_eq!(body["mutual"], true);
    }

    #[tokio::test]
    async fn followers_pagination_cursor_walk() {
        let (router, state, token, _tmp) = setup().await;
        let t = Some(token.as_str());

        for i in 0..5 {
            state
                .social()
                .follow(
                    &UserId(format!("u{i}")),
                    &EntityId::user(&UserId::from("bob")),
                )
                .await
                .unwrap();
        }

        let (status, body) = send(
            &router,
            "GET",
            "/api/social/followers/user/bob?limit=2",
            t,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["total"], 5);
        assert_eq!(body["items"].as_array().unwrap().len(), 2);
        let cursor = body["next_cursor"].as_str().unwrap().to_string();

        let (_, body) = send(
            &router,
            "GET",
            &format!("/api/social/followers/user/bob?limit=4&cursor={cursor}"),
            t,
            None,
        )
        .await;
        assert_eq!(body["items"].as_array().unwrap().len(), 3);
        assert_eq!(body["next_cursor"], serde_json::Value::Null);
    }
}
