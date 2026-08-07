//! Social event fan-out for the publish path.
//!
//! Daemon-side replacement for the worker's `presign.ts` emit hook: when a
//! gallery is first published publicly, followers of the publisher (who are
//! subscribers of `EntityId::user(publisher)` via follow auto-subscribe) get
//! a NewContent notification. Runs post-commit in a `tokio::spawn` —
//! fan-out failures are logged and never fail the publish.

use std::collections::HashMap;
use std::sync::Arc;

use diesel::prelude::*;
use kith::subscribe::SubscriptionEngine;
use kith::types::{EntityId, Event, EventKind, UserId};

use super::DaemonState;
use crate::db::schema::users;

/// Fire-and-forget wrapper for the publish handler: log-and-continue on any
/// error (worker `ctx.waitUntil` parity).
pub async fn emit_new_gallery(state: Arc<DaemonState>, publisher: String, title: String, slug: String) {
    match emit_new_gallery_inner(&state, &publisher, &title, &slug).await {
        Ok(sent) if sent > 0 => {
            log::info!("new-gallery fan-out for @{publisher}/{slug}: {sent} notification(s)")
        }
        Ok(_) => {}
        Err(e) => log::warn!("new-gallery fan-out for @{publisher}/{slug}: {e}"),
    }
}

/// Build the NewContent event and emit it through a block-aware engine.
/// Returns the number of notifications delivered.
async fn emit_new_gallery_inner(
    state: &DaemonState,
    publisher: &str,
    title: &str,
    slug: &str,
) -> kith::error::Result<u64> {
    // Payload keys mirror the worker's presign.ts emit: title, slug, url.
    // The gallery URL needs the publisher's username; a user without one
    // has no public gallery page, so the url key is simply omitted.
    let db = state.db.clone();
    let publisher_key = publisher.to_owned();
    let username: Option<String> = tokio::task::spawn_blocking(move || {
        users::table
            .find(&publisher_key)
            .select(users::username)
            .first::<Option<String>>(
                &mut db
                    .get()
                    .map_err(|e| kith::error::KithError::StorageError(e.to_string()))?,
            )
            .optional()
            .map_err(|e| kith::error::KithError::StorageError(e.to_string()))
            .map(Option::flatten)
    })
    .await
    .map_err(|e| kith::error::KithError::StorageError(format!("username lookup join: {e}")))??;

    let mut payload = HashMap::from([
        ("title".to_string(), title.to_string()),
        ("slug".to_string(), slug.to_string()),
    ]);
    if let Some(username) = username {
        payload.insert("url".to_string(), format!("/@{username}/{slug}"));
    }

    let store = state.kith();
    // No external sinks yet (ntfy/push are follow-ups); persistence via the
    // notification store, block/mute suppression via the graph store.
    let engine = SubscriptionEngine::without_sinks(store.clone())
        .with_notification_store(store.clone())
        .with_graph_store(store);

    let publisher = UserId::from(publisher);
    let event = Event {
        source: publisher.clone(),
        entity: EntityId::user(&publisher),
        kind: EventKind::NewContent,
        payload,
    };
    engine.emit(&event).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::auth::mint_token;
    use crate::daemon::router;
    use crate::db::test_support::{insert_user, test_pool};
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use kith::storage::{GraphStore, NotificationStore, SubscriptionStore};
    use kith::types::{Edge, EdgeKind, SubscriptionFilter};
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
        });
        (state, tmp)
    }

    fn user_with_handle(state: &DaemonState, id: &str, handle: &str) {
        insert_user(&state.db, id);
        diesel::update(users::table.find(id))
            .set(users::username.eq(Some(handle)))
            .execute(&mut state.db.get().unwrap())
            .unwrap();
    }

    #[tokio::test]
    async fn fan_out_delivers_suppresses_self_and_blocked() {
        let (state, _tmp) = test_state().await;
        user_with_handle(&state, "alice", "aliceh");
        let store = state.kith();
        let alice_topic = EntityId::user(&UserId::from("alice"));

        // carol follows alice (subscription is what the engine matches on);
        // dave subscribes too but has blocked alice; alice subscribes to
        // herself (self-suppression must skip her).
        for user in ["carol", "dave", "alice"] {
            store
                .subscribe(&UserId::from(user), &alice_topic, SubscriptionFilter::default())
                .await
                .unwrap();
        }
        store
            .add_edge(&Edge::new(
                UserId::from("dave"),
                alice_topic.clone(),
                EdgeKind::Block,
            ))
            .await
            .unwrap();

        let sent = emit_new_gallery_inner(&state, "alice", "Orion Widefield", "orion")
            .await
            .unwrap();
        assert_eq!(sent, 1, "only carol");

        let notifs = store
            .notifications_for(&UserId::from("carol"), true)
            .await
            .unwrap();
        assert_eq!(notifs.len(), 1);
        let event = &notifs[0].event;
        assert_eq!(event.kind, EventKind::NewContent);
        assert_eq!(event.source, UserId::from("alice"));
        assert_eq!(event.payload.get("title").map(String::as_str), Some("Orion Widefield"));
        assert_eq!(event.payload.get("slug").map(String::as_str), Some("orion"));
        assert_eq!(
            event.payload.get("url").map(String::as_str),
            Some("/@aliceh/orion")
        );

        assert!(store
            .notifications_for(&UserId::from("dave"), false)
            .await
            .unwrap()
            .is_empty());
        assert!(store
            .notifications_for(&UserId::from("alice"), false)
            .await
            .unwrap()
            .is_empty());
    }

    /// Publish through the real handler: the follower's notification row
    /// appears (async fan-out), and a re-publish doesn't duplicate it.
    #[tokio::test(flavor = "multi_thread")]
    async fn publish_handler_notifies_followers_once() {
        let (state, _tmp) = test_state().await;
        user_with_handle(&state, "alice", "aliceh");
        insert_user(&state.db, "carol");
        let router = router(state.clone());

        let collection = crate::commands::collections::create_collection_core(
            &state.db,
            "alice",
            crate::commands::collections::CreateCollectionInput {
                name: "Orion Widefield".to_string(),
                description: None,
                visibility: None,
                template: None,
                tags: None,
            },
        )
        .unwrap();

        // carol follows alice through the API (exercises auto-subscribe).
        let carol_token = mint_token(&state.db, "carol", "test").unwrap().token;
        let resp = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/social/follow")
                    .header("Authorization", format!("Bearer {carol_token}"))
                    .header("Content-Type", "application/json")
                    .body(Body::from(
                        serde_json::json!({ "target_kind": "user", "target_id": "alice" })
                            .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);

        let alice_token = mint_token(&state.db, "alice", "test").unwrap().token;
        let publish = |token: String| {
            let router = router.clone();
            let uri = format!("/api/collections/{}/publish", collection.id);
            async move {
                router
                    .oneshot(
                        Request::builder()
                            .method("POST")
                            .uri(uri)
                            .header("Authorization", format!("Bearer {token}"))
                            .body(Body::empty())
                            .unwrap(),
                    )
                    .await
                    .unwrap()
            }
        };

        let resp = publish(alice_token.clone()).await;
        assert_eq!(resp.status(), StatusCode::OK);

        // The fan-out runs in a detached task — poll briefly.
        let store = state.kith();
        let carol = UserId::from("carol");
        let mut notifs = Vec::new();
        for _ in 0..50 {
            notifs = store.notifications_for(&carol, false).await.unwrap();
            if !notifs.is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert_eq!(notifs.len(), 1, "follower notified exactly once");
        assert_eq!(notifs[0].event.kind, EventKind::NewContent);
        assert_eq!(
            notifs[0].event.payload.get("url").map(String::as_str),
            Some("/@aliceh/orion-widefield")
        );

        // Re-publish (already published): no second notification.
        let resp = publish(alice_token).await;
        assert_eq!(resp.status(), StatusCode::OK);
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert_eq!(
            store.notifications_for(&carol, false).await.unwrap().len(),
            1
        );
    }
}
