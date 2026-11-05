//! Circle management: the authed `/api/circles` routes an owner uses to
//! curate who is in `circle:<name>` — the kith edges the circle ACL
//! (`acl.rs`) and `circle:` gallery visibility read.
//!
//! A circle has no row of its own: it exists exactly as long as it has
//! members (edges `actor = me, target = (user, member), kind =
//! circle:<name>`). Edges are written through
//! [`signed_edges::write_edge`], so a membership granted by an owner with
//! a DID to a member with a DID is a signed `sh.kith.graph.edge` statement
//! (served at `GET /@{owner}/graph/circle:<name>/user/{member}` to the
//! owner and that member). Names are validated with
//! `kenning::private::Visibility::circle` — `1..=64` of `[a-z0-9_-]`, the
//! same rule as `circle:<name>` visibility.
//!
//! | route | response |
//! |---|---|
//! | `GET /api/circles` | `{"circles":[{"name","members"}]}` sorted by name |
//! | `GET /api/circles/{name}` | `{"name","members":[{"user_id","did","signed","created_at"}]}`; 404 when the circle has no members |
//! | `PUT /api/circles/{name}/members/{user_id}` | `{"signed": bool}`; 400 bad name or self, 404 unknown user |
//! | `DELETE /api/circles/{name}/members/{user_id}` | 204, also when not a member |

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use diesel::prelude::*;
use kenning::private::Visibility;
use kith::storage::GraphStore;
use kith::types::{Edge, EdgeKind, EntityId, UserId};
use serde_json::json;

use super::auth::AuthedUser;
use super::{signed_edges, DaemonState};
use crate::db::schema::users;

pub fn routes() -> Router<Arc<DaemonState>> {
    Router::new()
        .route("/", get(list_circles))
        .route("/{name}", get(circle_members))
        .route(
            "/{name}/members/{user_id}",
            axum::routing::put(add_member).delete(remove_member),
        )
}

fn bad_request(msg: impl std::fmt::Display) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": msg.to_string() })),
    )
        .into_response()
}

fn not_found(msg: &str) -> Response {
    (StatusCode::NOT_FOUND, Json(json!({ "error": msg }))).into_response()
}

/// The validated circle name, or the message for the 400.
fn circle_name(name: &str) -> Result<String, String> {
    Visibility::circle(name)
        .map(|_| name.to_string())
        .map_err(|e| format!("invalid circle name: {e}"))
}

/// `GET /api/circles` — the caller's circles with member counts.
pub async fn list_circles(State(state): State<Arc<DaemonState>>, user: AuthedUser) -> Response {
    match state.kith().circle_counts(&UserId(user.user_id)).await {
        Ok(counts) => {
            let circles: Vec<_> = counts
                .into_iter()
                .map(|(name, members)| json!({ "name": name, "members": members }))
                .collect();
            Json(json!({ "circles": circles })).into_response()
        }
        Err(e) => super::api::internal("circles list", e.to_string()),
    }
}

/// `GET /api/circles/{name}` — members of one circle, oldest first.
pub async fn circle_members(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
    Path(name): Path<String>,
) -> Response {
    let name = match circle_name(&name) {
        Ok(name) => name,
        Err(msg) => return bad_request(msg),
    };
    let edges = match state
        .kith()
        .following_with_signed(&UserId(user.user_id), &EdgeKind::Circle(name.clone()))
        .await
    {
        Ok(edges) => edges,
        Err(e) => return super::api::internal("circle members", e.to_string()),
    };
    if edges.is_empty() {
        return not_found("no such circle");
    }

    // DIDs of the members, one query.
    let ids: Vec<String> = edges.iter().map(|(e, _)| e.target.id.clone()).collect();
    let db = state.db.clone();
    let dids =
        tokio::task::spawn_blocking(move || -> Result<HashMap<String, Option<String>>, String> {
            let mut conn = db.get().map_err(|e| e.to_string())?;
            users::table
                .filter(users::id.eq_any(&ids))
                .select((users::id, users::did))
                .load::<(String, Option<String>)>(&mut conn)
                .map(|rows| rows.into_iter().collect())
                .map_err(|e| e.to_string())
        })
        .await;
    let dids = match dids {
        Ok(Ok(dids)) => dids,
        Ok(Err(e)) => return super::api::internal("circle members dids", e),
        Err(e) => return super::api::internal("circle members dids", e.to_string()),
    };

    let members: Vec<_> = edges
        .iter()
        .map(|(edge, signed)| {
            json!({
                "user_id": edge.target.id,
                "did": dids.get(&edge.target.id).cloned().flatten(),
                "signed": signed,
                "created_at": edge.created_at.to_rfc3339(),
            })
        })
        .collect();
    Json(json!({ "name": name, "members": members })).into_response()
}

/// `PUT /api/circles/{name}/members/{user_id}` — add a local user to the
/// caller's circle (idempotent). Signed when possible; the response says.
pub async fn add_member(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
    Path((name, member)): Path<(String, String)>,
) -> Response {
    let name = match circle_name(&name) {
        Ok(name) => name,
        Err(msg) => return bad_request(msg),
    };
    if member == user.user_id {
        return bad_request("cannot add yourself to your own circle");
    }

    let db = state.db.clone();
    let id = member.clone();
    let exists = tokio::task::spawn_blocking(move || -> Result<bool, String> {
        let mut conn = db.get().map_err(|e| e.to_string())?;
        users::table
            .find(&id)
            .select(users::id)
            .first::<String>(&mut conn)
            .optional()
            .map(|r| r.is_some())
            .map_err(|e| e.to_string())
    })
    .await;
    match exists {
        Ok(Ok(true)) => {}
        Ok(Ok(false)) => return not_found("no such user"),
        Ok(Err(e)) => return super::api::internal("circle add member", e),
        Err(e) => return super::api::internal("circle add member", e.to_string()),
    }

    let edge = Edge::new(
        UserId(user.user_id),
        EntityId::user(&UserId(member)),
        EdgeKind::Circle(name),
    );
    match signed_edges::write_edge(&state, &edge).await {
        Ok(signed) => Json(json!({ "signed": signed })).into_response(),
        Err(e) => signed_edges::error_response("circle add member", e),
    }
}

/// `DELETE /api/circles/{name}/members/{user_id}` — 204; access ends on
/// the member's next request (the ACL reads the live store).
pub async fn remove_member(
    State(state): State<Arc<DaemonState>>,
    user: AuthedUser,
    Path((name, member)): Path<(String, String)>,
) -> Response {
    let name = match circle_name(&name) {
        Ok(name) => name,
        Err(msg) => return bad_request(msg),
    };
    let result = state
        .kith()
        .remove_edge(
            &UserId(user.user_id),
            &EntityId::user(&UserId(member)),
            &EdgeKind::Circle(name),
        )
        .await;
    match result {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => super::api::internal("circle remove member", e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::publish::{publish_collection_core, PublishVisibility};
    use crate::daemon::auth::mint_token;
    use crate::daemon::gallery::tests::fixture;
    use crate::daemon::records::tests::{link_did, sign_publish};
    use crate::daemon::signed_edges::tests::{
        fake_handles, send, signed_json, signed_setup, user, ALICE_DID, BOB_DID,
    };
    use axum::body::Body;
    use axum::http::{header, Request};
    use kith::signed::SignedEdge;
    use tower::ServiceExt;

    const FAMILY_BOB: &str = "/api/circles/family/members/bob";
    const GRAPH_FAMILY_BOB: &str = "/@aliceh/graph/circle%3Afamily/user/bob";

    #[tokio::test]
    async fn routes_require_auth() {
        let s = signed_setup().await;
        for (method, uri) in [
            ("GET", "/api/circles"),
            ("GET", "/api/circles/family"),
            ("PUT", FAMILY_BOB),
            ("DELETE", FAMILY_BOB),
        ] {
            let (status, _) = send(&s.router, method, uri, None, None).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {uri}");
        }
    }

    #[tokio::test]
    async fn circle_lifecycle_signed_listed_served_and_removed() {
        let s = signed_setup().await;
        let alice = Some(s.alice.as_str());

        // Nothing yet.
        let (status, body) = send(&s.router, "GET", "/api/circles", alice, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["circles"].as_array().unwrap().len(), 0);
        let (status, _) = send(&s.router, "GET", "/api/circles/family", alice, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // Add bob (DID) → signed; carol (no DID) → unsigned.
        let (status, body) = send(&s.router, "PUT", FAMILY_BOB, alice, None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["signed"], true);
        let raw = signed_json(&s.state.db, "alice", "bob", "circle:family").expect("signed");
        let signed: SignedEdge = serde_json::from_str(&raw).unwrap();
        assert_eq!(signed.record.body.edge_kind, "circle:family");
        assert_eq!(signed.record.body.actor.as_str(), ALICE_DID);
        assert_eq!(signed.record.body.target.id, BOB_DID);
        kith::signed::verify_edge(&signed, s.state.handles.resolver().as_ref())
            .await
            .unwrap();

        let (status, body) = send(
            &s.router,
            "PUT",
            "/api/circles/family/members/carol",
            alice,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["signed"], false);

        // Idempotent re-add keeps the signature.
        let (status, body) = send(&s.router, "PUT", FAMILY_BOB, alice, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["signed"], true);

        // Listing.
        let (_, body) = send(&s.router, "GET", "/api/circles", alice, None).await;
        assert_eq!(body["circles"], json!([{ "name": "family", "members": 2 }]));
        let (status, body) = send(&s.router, "GET", "/api/circles/family", alice, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["name"], "family");
        let members = body["members"].as_array().unwrap();
        assert_eq!(members.len(), 2);
        assert_eq!(members[0]["user_id"], "bob");
        assert_eq!(members[0]["did"], BOB_DID);
        assert_eq!(members[0]["signed"], true);
        assert_eq!(members[1]["user_id"], "carol");
        assert_eq!(members[1]["did"], serde_json::Value::Null);
        assert_eq!(members[1]["signed"], false);

        // The ACL sees the membership through the same edge.
        assert!(s
            .state
            .kith()
            .edge_exists(
                &UserId("alice".into()),
                &EntityId::user(&UserId("bob".into())),
                &EdgeKind::Circle("family".into()),
            )
            .await
            .unwrap());

        // Public graph route: owner and member see it (private cache
        // policy); a stranger with a DID, and anonymous, get 404.
        for token in [&s.alice, &s.bob] {
            let resp = s
                .router
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(GRAPH_FAMILY_BOB)
                        .header(header::AUTHORIZATION, format!("Bearer {token}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::OK);
            assert_eq!(
                resp.headers().get(header::CACHE_CONTROL).unwrap(),
                crate::daemon::acl::PRIVATE_CACHE_CONTROL
            );
            assert_eq!(
                resp.headers().get(header::VARY).unwrap(),
                crate::daemon::acl::PRIVATE_VARY
            );
        }
        let (status, _) = send(&s.router, "GET", GRAPH_FAMILY_BOB, Some(&s.dave), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "stranger");
        let (status, _) = send(&s.router, "GET", GRAPH_FAMILY_BOB, None, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "anonymous");
        // Carol's membership is unsigned: nothing to serve, even to her.
        let (status, _) = send(
            &s.router,
            "GET",
            "/@aliceh/graph/circle%3Afamily/user/carol",
            Some(&s.carol),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // Remove bob → gone from the store, the listing and the route.
        let (status, _) = send(&s.router, "DELETE", FAMILY_BOB, alice, None).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert!(signed_json(&s.state.db, "alice", "bob", "circle:family").is_none());
        let (status, _) = send(&s.router, "GET", GRAPH_FAMILY_BOB, Some(&s.bob), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (_, body) = send(&s.router, "GET", "/api/circles/family", alice, None).await;
        assert_eq!(body["members"].as_array().unwrap().len(), 1);
        // Removing again, and removing a non-member, are 204.
        let (status, _) = send(&s.router, "DELETE", FAMILY_BOB, alice, None).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let (status, _) = send(
            &s.router,
            "DELETE",
            "/api/circles/family/members/carol",
            alice,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let (status, _) = send(&s.router, "GET", "/api/circles/family", alice, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn bad_names_self_and_unknown_users_are_rejected() {
        let s = signed_setup().await;
        let alice = Some(s.alice.as_str());
        for name in ["Family", "fam%20ily", "", "a%2Fb", &"x".repeat(65)] {
            for (method, uri) in [
                ("PUT", format!("/api/circles/{name}/members/bob")),
                ("DELETE", format!("/api/circles/{name}/members/bob")),
                ("GET", format!("/api/circles/{name}")),
            ] {
                let (status, _) = send(&s.router, method, &uri, alice, None).await;
                // An empty name leaves a path only the parent routes match.
                let expected = if name.is_empty() {
                    assert_ne!(status, StatusCode::OK, "{method} {uri}");
                    continue;
                } else {
                    StatusCode::BAD_REQUEST
                };
                assert_eq!(status, expected, "{method} {uri}");
            }
        }
        let (status, body) = send(
            &s.router,
            "PUT",
            "/api/circles/family/members/alice",
            alice,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"].as_str().unwrap().contains("yourself"));
        let (status, _) = send(
            &s.router,
            "PUT",
            "/api/circles/family/members/nobody",
            alice,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        // Nothing was written.
        let (status, _) = send(&s.router, "GET", "/api/circles/family", alice, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    /// End to end with the existing ACL: a membership granted through the
    /// API admits the member to a `circle:` gallery; a stranger stays out;
    /// removal shuts the door on the next request.
    #[tokio::test(flavor = "multi_thread")]
    async fn api_membership_admits_member_to_circle_gallery() {
        let f = fixture().await;
        link_did(&f);
        let alice = mint_token(&f.state.db, "alice", "t").unwrap().token;
        let bob = user(&f.state.db, "bob", "bobh", Some(BOB_DID));
        let carol = user(
            &f.state.db,
            "carol",
            "carolh",
            Some(crate::daemon::signed_edges::tests::DAVE_DID),
        );
        // Same state, with a resolver that trusts the fixture's key.
        let state = Arc::new(DaemonState {
            db: f.state.db.clone(),
            hoardfs: f.state.hoardfs.clone(),
            oidc: None,
            limits: Default::default(),
            session_key: f.state.session_key,
            processing: Default::default(),
            tetra3_db: None,
            uploads_dir: std::env::temp_dir().join("astra-test-uploads"),
            handles: fake_handles(f.verifying_key.clone()),
            mailer: Arc::new(crate::mail::LogMailer::default()),
            magic: Default::default(),
            signer: f.state.signer.clone(),
        });
        let router = crate::daemon::router(state.clone());

        // "Andromeda Nights" goes family-only.
        publish_collection_core(
            &f.state.db,
            "alice",
            &f.public_collection.id,
            PublishVisibility::circle("family").unwrap(),
            None,
        )
        .unwrap();
        sign_publish(&f, &f.public_collection.id).await.unwrap();

        let gallery = "/@aliceh/andromeda-nights";
        let (status, _) = send(&router, "GET", gallery, Some(&bob), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "not a member yet");

        let (status, body) = send(&router, "PUT", FAMILY_BOB, Some(&alice), None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["signed"], true);

        let (status, _) = send(&router, "GET", gallery, Some(&bob), None).await;
        assert_eq!(status, StatusCode::OK, "member");
        let (status, _) = send(&router, "GET", gallery, Some(&carol), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "stranger");
        let (status, _) = send(&router, "GET", gallery, None, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "anonymous");

        let (status, _) = send(&router, "DELETE", FAMILY_BOB, Some(&alice), None).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let (status, _) = send(&router, "GET", gallery, Some(&bob), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "removed");
    }
}
