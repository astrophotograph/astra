//! End-to-end slice test for the kith-consumer-proof epic: follow →
//! publish → notification, entirely through the daemon HTTP surface over
//! the real Diesel store (a temp-dir `astra.db` — no memory adapter
//! anywhere, no network beyond the loopback listener).

use astra_lib::daemon::{auth, Daemon, DaemonConfig, DaemonState};
use diesel::RunQueryDsl;
use kith::storage::{NotificationStore, SubscriptionStore};
use kith::types::{EntityId, UserId};

// The `db` module is crate-private; raw SQL through the (public) pool keeps
// this test on the daemon's public surface.
fn insert_user(state: &DaemonState, id: &str, handle: Option<&str>) {
    diesel::sql_query("INSERT INTO users (id, name, username) VALUES (?, ?, ?)")
        .bind::<diesel::sql_types::Text, _>(id)
        .bind::<diesel::sql_types::Text, _>(format!("Test {id}"))
        .bind::<diesel::sql_types::Nullable<diesel::sql_types::Text>, _>(handle)
        .execute(&mut state.db.get().unwrap())
        .unwrap();
}

async fn mint(state: &DaemonState, user: &str) -> String {
    let db = state.db.clone();
    let user = user.to_string();
    tokio::task::spawn_blocking(move || auth::mint_token(&db, &user, "e2e").unwrap().token)
        .await
        .unwrap()
}

struct Api {
    client: reqwest::Client,
    base: String,
}

impl Api {
    async fn post(
        &self,
        path: &str,
        token: &str,
        body: Option<serde_json::Value>,
    ) -> reqwest::Response {
        let mut req = self
            .client
            .post(format!("{}{path}", self.base))
            .bearer_auth(token);
        if let Some(body) = body {
            req = req.json(&body);
        }
        req.send().await.unwrap()
    }

    async fn delete_json(
        &self,
        path: &str,
        token: &str,
        body: serde_json::Value,
    ) -> reqwest::Response {
        self.client
            .delete(format!("{}{path}", self.base))
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .unwrap()
    }

    async fn get(&self, path: &str, token: &str) -> serde_json::Value {
        let resp = self
            .client
            .get(format!("{}{path}", self.base))
            .bearer_auth(token)
            .send()
            .await
            .unwrap();
        assert!(
            resp.status().is_success(),
            "GET {path}: {}",
            resp.status()
        );
        resp.json().await.unwrap()
    }
}

fn target(kind: &str, id: &str) -> serde_json::Value {
    serde_json::json!({ "target_kind": kind, "target_id": id })
}

#[tokio::test(flavor = "multi_thread")]
async fn follow_publish_notify_slice() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let config = DaemonConfig {
        data_dir: tmp.path().to_path_buf(),
        bind: "127.0.0.1:0".parse().unwrap(),
        web_dist: tmp.path().join("web"),
    };

    let daemon = Daemon::bind(&config).await.expect("daemon bind");
    let addr = daemon.local_addr().expect("local addr");
    let state = daemon.state();

    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(daemon.serve(async {
        let _ = shutdown_rx.await;
    }));

    // alice follows bob; carol subscribes but ends up blocked by bob; bob
    // publishes. Only bob needs a username (his gallery URL).
    insert_user(&state, "alice", None);
    insert_user(&state, "bob", Some("bobh"));
    insert_user(&state, "carol", None);
    let alice = mint(&state, "alice").await;
    let bob = mint(&state, "bob").await;
    let carol = mint(&state, "carol").await;

    let api = Api {
        client: reqwest::Client::new(),
        base: format!("http://{addr}"),
    };

    // 1. Follow over HTTP; verify through the query routes.
    let resp = api
        .post("/api/social/follow", &alice, Some(target("user", "bob")))
        .await;
    assert_eq!(resp.status(), 204);
    let body = api
        .get(
            "/api/social/is-following?target_kind=user&target_id=bob",
            &alice,
        )
        .await;
    assert_eq!(body["following"], true);
    let body = api.get("/api/social/counts/user/bob", &alice).await;
    assert_eq!(body["followers"], 1);

    // Carol follows too (auto-subscribes), then bob blocks her: her
    // subscription row survives, so suppression must come from the engine's
    // graph check, not from a missing subscription.
    let resp = api
        .post("/api/social/follow", &carol, Some(target("user", "bob")))
        .await;
    assert_eq!(resp.status(), 204);
    state
        .social()
        .block(
            &UserId::from("bob"),
            &EntityId::user(&UserId::from("carol")),
        )
        .await
        .unwrap();
    assert_eq!(
        state
            .kith()
            .subscriptions_for(&UserId::from("carol"))
            .await
            .unwrap()
            .len(),
        1,
        "carol's subscription survives the block"
    );

    // 2. Bob publishes through the real endpoints.
    let resp = api
        .post(
            "/api/collections",
            &bob,
            Some(serde_json::json!({ "name": "Orion Widefield" })),
        )
        .await;
    assert_eq!(resp.status(), 201);
    let collection: serde_json::Value = resp.json().await.unwrap();
    let collection_id = collection["id"].as_str().unwrap().to_string();

    let resp = api
        .post(
            &format!("/api/collections/{collection_id}/publish"),
            &bob,
            None,
        )
        .await;
    assert_eq!(resp.status(), 200);

    // 3. The fan-out is a detached task — poll alice's feed over HTTP.
    let mut feed = serde_json::Value::Null;
    for _ in 0..100 {
        feed = api.get("/api/social/notifications", &alice).await;
        if feed["total"] != 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert_eq!(feed["total"], 1, "alice got exactly one notification");
    let item = &feed["items"][0];
    assert_eq!(item["event"]["kind"], "NewContent");
    assert_eq!(item["event"]["source"], "bob");
    assert_eq!(item["event"]["payload"]["title"], "Orion Widefield");
    assert_eq!(item["event"]["payload"]["slug"], "orion-widefield");
    assert_eq!(item["event"]["payload"]["url"], "/@bobh/orion-widefield");
    let notif_id = item["id"].as_str().unwrap().to_string();

    let body = api
        .get("/api/social/notifications/unread-count", &alice)
        .await;
    assert_eq!(body["count"], 1);

    // Rows land in the real kith_notifications table (same pool the server
    // uses), not any in-memory adapter.
    let stored = state
        .kith()
        .notifications_for(&UserId::from("alice"), false)
        .await
        .unwrap();
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].id, notif_id);

    // 4. Mark read.
    let resp = api
        .post(
            &format!("/api/social/notifications/{notif_id}/read"),
            &alice,
            None,
        )
        .await;
    assert_eq!(resp.status(), 204);
    let body = api
        .get("/api/social/notifications/unread-count", &alice)
        .await;
    assert_eq!(body["count"], 0);

    // 5. Negatives. Alice unfollows (removes her auto-subscription); bob
    // subscribes to himself so the engine's self-suppression is exercised.
    let resp = api
        .delete_json("/api/social/follow", &alice, target("user", "bob"))
        .await;
    assert_eq!(resp.status(), 204);
    state
        .kith()
        .subscribe(
            &UserId::from("bob"),
            &EntityId::user(&UserId::from("bob")),
            Default::default(),
        )
        .await
        .unwrap();

    let resp = api
        .post(
            "/api/collections",
            &bob,
            Some(serde_json::json!({ "name": "Pleiades" })),
        )
        .await;
    assert_eq!(resp.status(), 201);
    let second: serde_json::Value = resp.json().await.unwrap();
    let resp = api
        .post(
            &format!("/api/collections/{}/publish", second["id"].as_str().unwrap()),
            &bob,
            None,
        )
        .await;
    assert_eq!(resp.status(), 200);

    // Give the fan-out task ample time, then assert nothing new landed:
    // alice unfollowed, carol is blocked by the source, bob is the source.
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    let feed = api.get("/api/social/notifications", &alice).await;
    assert_eq!(feed["total"], 1, "unfollowed alice: no new notification");
    let feed = api.get("/api/social/notifications", &carol).await;
    assert_eq!(feed["total"], 0, "blocked carol: never notified");
    let feed = api.get("/api/social/notifications", &bob).await;
    assert_eq!(feed["total"], 0, "self-suppression: bob never notified");

    shutdown_tx.send(()).expect("send shutdown");
    tokio::time::timeout(std::time::Duration::from_secs(15), server)
        .await
        .expect("shutdown timed out")
        .expect("server task panicked")
        .expect("serve returned error");
}
