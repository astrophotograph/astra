//! AstraKithStore — Kith storage traits over the daemon's Diesel pool.
//!
//! First real Rust consumer of Kith's storage traits backed by a store Kith
//! does not own. Column shapes and value encodings mirror Kith's reference
//! `SqliteStore` (kith/src/sqlite.rs): `edge_kind` and `target_kind` are
//! serde-JSON strings, `metadata` is a JSON object, `created_at` is RFC3339
//! TEXT — so rows stay portable between the two stores.
//!
//! Every method runs its Diesel work inside `tokio::task::spawn_blocking`:
//! pooled r2d2 connections must not be held across await points.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use diesel::prelude::*;
use kith::error::{KithError, Result};
use kith::storage::GraphStore;
use kith::types::{Edge, EdgeKind, EntityId, EntityKind, UserId};

use crate::db::schema::kith_edges;
use crate::db::DbPool;

/// Kith storage adapter over the daemon's SQLite pool (WAL, 5s busy timeout).
#[derive(Clone)]
pub struct AstraKithStore {
    pool: DbPool,
}

impl AstraKithStore {
    pub fn new(pool: DbPool) -> Self {
        Self { pool }
    }
}

fn storage_err(e: impl std::fmt::Display) -> KithError {
    KithError::StorageError(e.to_string())
}

/// Run Diesel work on the blocking pool, flattening join errors into
/// `KithError::StorageError`.
async fn run_blocking<T, F>(f: F) -> Result<T>
where
    F: FnOnce() -> Result<T> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| storage_err(format!("blocking task join: {e}")))?
}

/// Serde-JSON encoding of kind enums, exactly as Kith's `SqliteStore` writes
/// them (e.g. `"Follow"`, `{"Circle":"friends"}`, `{"Vouch":{"axis":"Identity"}}`).
fn encode_edge_kind(kind: &EdgeKind) -> Result<String> {
    serde_json::to_string(kind).map_err(storage_err)
}

fn decode_edge_kind(s: &str) -> Result<EdgeKind> {
    serde_json::from_str(s).map_err(|e| storage_err(format!("bad edge_kind {s:?}: {e}")))
}

fn encode_entity_kind(kind: &EntityKind) -> Result<String> {
    serde_json::to_string(kind).map_err(storage_err)
}

fn decode_entity_kind(s: &str) -> Result<EntityKind> {
    serde_json::from_str(s).map_err(|e| storage_err(format!("bad target_kind {s:?}: {e}")))
}

/// One `kith_edges` row. Field order matches the `table!` declaration.
#[derive(Queryable)]
struct EdgeRow {
    actor_id: String,
    target_kind: String,
    target_id: String,
    edge_kind: String,
    weight: f64,
    metadata: Option<String>,
    created_at: String,
}

impl EdgeRow {
    fn into_edge(self) -> Result<Edge> {
        Ok(Edge {
            actor: UserId(self.actor_id),
            target: EntityId::new(decode_entity_kind(&self.target_kind)?, self.target_id),
            kind: decode_edge_kind(&self.edge_kind)?,
            weight: self.weight as f32,
            metadata: match self.metadata.as_deref() {
                None | Some("") => Default::default(),
                Some(json) => serde_json::from_str(json)
                    .map_err(|e| storage_err(format!("bad edge metadata: {e}")))?,
            },
            created_at: DateTime::parse_from_rfc3339(&self.created_at)
                .map_err(|e| storage_err(format!("bad created_at {:?}: {e}", self.created_at)))?
                .with_timezone(&Utc),
        })
    }
}

#[async_trait]
impl GraphStore for AstraKithStore {
    async fn add_edge(&self, edge: &Edge) -> Result<()> {
        let pool = self.pool.clone();
        let actor = edge.actor.0.clone();
        let target_kind = encode_entity_kind(&edge.target.kind)?;
        let target_id = edge.target.id.clone();
        let edge_kind = encode_edge_kind(&edge.kind)?;
        let weight = edge.weight as f64;
        let metadata = serde_json::to_string(&edge.metadata).map_err(storage_err)?;
        let created_at = edge.created_at.to_rfc3339();

        run_blocking(move || {
            let mut conn = pool.get().map_err(storage_err)?;
            diesel::replace_into(kith_edges::table)
                .values((
                    kith_edges::actor_id.eq(actor),
                    kith_edges::target_kind.eq(target_kind),
                    kith_edges::target_id.eq(target_id),
                    kith_edges::edge_kind.eq(edge_kind),
                    kith_edges::weight.eq(weight),
                    kith_edges::metadata.eq(metadata),
                    kith_edges::created_at.eq(created_at),
                ))
                .execute(&mut conn)
                .map_err(storage_err)?;
            Ok(())
        })
        .await
    }

    async fn remove_edge(&self, actor: &UserId, target: &EntityId, kind: &EdgeKind) -> Result<()> {
        let pool = self.pool.clone();
        let actor = actor.0.clone();
        let target_kind = encode_entity_kind(&target.kind)?;
        let target_id = target.id.clone();
        let edge_kind = encode_edge_kind(kind)?;

        run_blocking(move || {
            let mut conn = pool.get().map_err(storage_err)?;
            diesel::delete(
                kith_edges::table
                    .filter(kith_edges::actor_id.eq(actor))
                    .filter(kith_edges::target_kind.eq(target_kind))
                    .filter(kith_edges::target_id.eq(target_id))
                    .filter(kith_edges::edge_kind.eq(edge_kind)),
            )
            .execute(&mut conn)
            .map_err(storage_err)?;
            Ok(())
        })
        .await
    }

    async fn edge_exists(
        &self,
        actor: &UserId,
        target: &EntityId,
        kind: &EdgeKind,
    ) -> Result<bool> {
        let pool = self.pool.clone();
        let actor = actor.0.clone();
        let target_kind = encode_entity_kind(&target.kind)?;
        let target_id = target.id.clone();
        let edge_kind = encode_edge_kind(kind)?;

        run_blocking(move || {
            let mut conn = pool.get().map_err(storage_err)?;
            let count: i64 = kith_edges::table
                .filter(kith_edges::actor_id.eq(actor))
                .filter(kith_edges::target_kind.eq(target_kind))
                .filter(kith_edges::target_id.eq(target_id))
                .filter(kith_edges::edge_kind.eq(edge_kind))
                .count()
                .get_result(&mut conn)
                .map_err(storage_err)?;
            Ok(count > 0)
        })
        .await
    }

    async fn followers(&self, target: &EntityId, kind: &EdgeKind) -> Result<Vec<Edge>> {
        let pool = self.pool.clone();
        let target_kind = encode_entity_kind(&target.kind)?;
        let target_id = target.id.clone();
        let edge_kind = encode_edge_kind(kind)?;

        run_blocking(move || {
            let mut conn = pool.get().map_err(storage_err)?;
            kith_edges::table
                .filter(kith_edges::target_kind.eq(target_kind))
                .filter(kith_edges::target_id.eq(target_id))
                .filter(kith_edges::edge_kind.eq(edge_kind))
                .order(kith_edges::created_at.asc())
                .load::<EdgeRow>(&mut conn)
                .map_err(storage_err)?
                .into_iter()
                .map(EdgeRow::into_edge)
                .collect()
        })
        .await
    }

    async fn following(&self, actor: &UserId, kind: &EdgeKind) -> Result<Vec<Edge>> {
        let pool = self.pool.clone();
        let actor = actor.0.clone();
        let edge_kind = encode_edge_kind(kind)?;

        run_blocking(move || {
            let mut conn = pool.get().map_err(storage_err)?;
            kith_edges::table
                .filter(kith_edges::actor_id.eq(actor))
                .filter(kith_edges::edge_kind.eq(edge_kind))
                .order(kith_edges::created_at.asc())
                .load::<EdgeRow>(&mut conn)
                .map_err(storage_err)?
                .into_iter()
                .map(EdgeRow::into_edge)
                .collect()
        })
        .await
    }

    async fn mutual(&self, a: &UserId, b: &UserId) -> Result<bool> {
        let a_follows_b = self
            .edge_exists(a, &EntityId::user(b), &EdgeKind::Follow)
            .await?;
        if !a_follows_b {
            return Ok(false);
        }
        self.edge_exists(b, &EntityId::user(a), &EdgeKind::Follow)
            .await
    }

    async fn count_followers(&self, target: &EntityId) -> Result<u64> {
        let pool = self.pool.clone();
        let target_kind = encode_entity_kind(&target.kind)?;
        let target_id = target.id.clone();
        let edge_kind = encode_edge_kind(&EdgeKind::Follow)?;

        run_blocking(move || {
            let mut conn = pool.get().map_err(storage_err)?;
            let count: i64 = kith_edges::table
                .filter(kith_edges::target_kind.eq(target_kind))
                .filter(kith_edges::target_id.eq(target_id))
                .filter(kith_edges::edge_kind.eq(edge_kind))
                .count()
                .get_result(&mut conn)
                .map_err(storage_err)?;
            Ok(count as u64)
        })
        .await
    }

    async fn count_following(&self, actor: &UserId) -> Result<u64> {
        let pool = self.pool.clone();
        let actor = actor.0.clone();
        let edge_kind = encode_edge_kind(&EdgeKind::Follow)?;

        run_blocking(move || {
            let mut conn = pool.get().map_err(storage_err)?;
            let count: i64 = kith_edges::table
                .filter(kith_edges::actor_id.eq(actor))
                .filter(kith_edges::edge_kind.eq(edge_kind))
                .count()
                .get_result(&mut conn)
                .map_err(storage_err)?;
            Ok(count as u64)
        })
        .await
    }

    async fn circles_for(&self, actor: &UserId) -> Result<Vec<String>> {
        let pool = self.pool.clone();
        let actor = actor.0.clone();

        run_blocking(move || {
            let mut conn = pool.get().map_err(storage_err)?;
            // Same shape as Kith's SqliteStore: the JSON encoding of
            // EdgeKind::Circle is `{"Circle":"name"}`, so a LIKE prefilter
            // narrows the DISTINCT scan and decode confirms.
            let kinds: Vec<String> = kith_edges::table
                .filter(kith_edges::actor_id.eq(actor))
                .filter(kith_edges::edge_kind.like("%Circle%"))
                .select(kith_edges::edge_kind)
                .distinct()
                .load(&mut conn)
                .map_err(storage_err)?;
            let mut names: Vec<String> = kinds
                .iter()
                .map(|s| decode_edge_kind(s))
                .filter_map(|r| match r {
                    Ok(EdgeKind::Circle(name)) => Some(Ok(name)),
                    Ok(_) => None,
                    Err(e) => Some(Err(e)),
                })
                .collect::<Result<_>>()?;
            names.sort();
            Ok(names)
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kith::graph::SocialGraph;
    use kith::types::PageRequest;

    use crate::db::test_support::test_pool;

    fn store() -> AstraKithStore {
        AstraKithStore::new(test_pool())
    }

    fn alice() -> UserId {
        UserId::from("alice")
    }
    fn bob() -> UserId {
        UserId::from("bob")
    }
    fn carol() -> UserId {
        UserId::from("carol")
    }
    fn alice_entity() -> EntityId {
        EntityId::user(&alice())
    }
    fn bob_entity() -> EntityId {
        EntityId::user(&bob())
    }
    fn m42() -> EntityId {
        EntityId::object("M42")
    }

    #[tokio::test]
    async fn follow_unfollow_round_trip() {
        let store = store();
        let edge = Edge::new(alice(), bob_entity(), EdgeKind::Follow);

        store.add_edge(&edge).await.unwrap();
        assert!(store
            .edge_exists(&alice(), &bob_entity(), &EdgeKind::Follow)
            .await
            .unwrap());

        store
            .remove_edge(&alice(), &bob_entity(), &EdgeKind::Follow)
            .await
            .unwrap();
        assert!(!store
            .edge_exists(&alice(), &bob_entity(), &EdgeKind::Follow)
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn duplicate_add_edge_is_idempotent() {
        let store = store();
        let edge = Edge::new(alice(), bob_entity(), EdgeKind::Follow);

        store.add_edge(&edge).await.unwrap();
        store.add_edge(&edge).await.unwrap();

        let followers = store
            .followers(&bob_entity(), &EdgeKind::Follow)
            .await
            .unwrap();
        assert_eq!(followers.len(), 1);
    }

    #[tokio::test]
    async fn followers_and_following() {
        let store = store();
        store
            .add_edge(&Edge::new(alice(), bob_entity(), EdgeKind::Follow))
            .await
            .unwrap();
        store
            .add_edge(&Edge::new(carol(), bob_entity(), EdgeKind::Follow))
            .await
            .unwrap();
        store
            .add_edge(&Edge::new(alice(), m42(), EdgeKind::Follow))
            .await
            .unwrap();

        let bob_followers = store
            .followers(&bob_entity(), &EdgeKind::Follow)
            .await
            .unwrap();
        assert_eq!(bob_followers.len(), 2);

        let alice_following = store.following(&alice(), &EdgeKind::Follow).await.unwrap();
        assert_eq!(alice_following.len(), 2);
    }

    #[tokio::test]
    async fn edge_fields_round_trip() {
        let store = store();
        let edge = Edge::new(
            alice(),
            m42(),
            EdgeKind::Vouch {
                axis: kith::types::VouchAxis::Identity,
            },
        )
        .with_weight(0.9)
        .with_metadata("via", "gallery");
        store.add_edge(&edge).await.unwrap();

        let loaded = store
            .following(&alice(), &edge.kind)
            .await
            .unwrap()
            .pop()
            .expect("edge loaded back");
        assert_eq!(loaded.actor, edge.actor);
        assert_eq!(loaded.target, edge.target);
        assert_eq!(loaded.kind, edge.kind);
        assert_eq!(loaded.weight, 0.9);
        assert_eq!(loaded.metadata.get("via").map(String::as_str), Some("gallery"));
        // RFC3339 TEXT keeps sub-second precision through the round trip.
        assert_eq!(loaded.created_at, edge.created_at);
    }

    #[tokio::test]
    async fn mutual_requires_both_directions() {
        let store = store();
        store
            .add_edge(&Edge::new(alice(), bob_entity(), EdgeKind::Follow))
            .await
            .unwrap();
        assert!(!store.mutual(&alice(), &bob()).await.unwrap());

        store
            .add_edge(&Edge::new(bob(), alice_entity(), EdgeKind::Follow))
            .await
            .unwrap();
        assert!(store.mutual(&alice(), &bob()).await.unwrap());
    }

    #[tokio::test]
    async fn follower_and_following_counts() {
        let store = store();
        store
            .add_edge(&Edge::new(alice(), bob_entity(), EdgeKind::Follow))
            .await
            .unwrap();
        store
            .add_edge(&Edge::new(carol(), bob_entity(), EdgeKind::Follow))
            .await
            .unwrap();
        // Non-follow edges don't count.
        store
            .add_edge(&Edge::new(alice(), bob_entity(), EdgeKind::Mute))
            .await
            .unwrap();

        assert_eq!(store.count_followers(&bob_entity()).await.unwrap(), 2);
        assert_eq!(store.count_following(&alice()).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn remove_nonexistent_edge_is_noop() {
        let store = store();
        store
            .remove_edge(&alice(), &bob_entity(), &EdgeKind::Follow)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn circles_for_distinct_sorted_names() {
        let store = store();
        assert!(store.circles_for(&alice()).await.unwrap().is_empty());

        for (target, circle) in [
            (bob_entity(), "friends"),
            (EntityId::user(&carol()), "friends"),
            (bob_entity(), "astro"),
        ] {
            store
                .add_edge(&Edge::new(
                    alice(),
                    target,
                    EdgeKind::Circle(circle.to_string()),
                ))
                .await
                .unwrap();
        }
        // Someone else's circles don't leak in.
        store
            .add_edge(&Edge::new(
                bob(),
                alice_entity(),
                EdgeKind::Circle("other".to_string()),
            ))
            .await
            .unwrap();

        assert_eq!(store.circles_for(&alice()).await.unwrap(), ["astro", "friends"]);
    }

    #[tokio::test]
    async fn followers_page_paginates() {
        let store = store();
        for follower in ["u1", "u2", "u3", "u4", "u5"] {
            store
                .add_edge(&Edge::new(
                    UserId::from(follower),
                    bob_entity(),
                    EdgeKind::Follow,
                ))
                .await
                .unwrap();
        }

        let mut seen = Vec::new();
        let mut page = PageRequest::new(2);
        loop {
            let resp = store
                .followers_page(&bob_entity(), &EdgeKind::Follow, &page)
                .await
                .unwrap();
            assert_eq!(resp.total, Some(5));
            assert!(resp.items.len() <= 2);
            seen.extend(resp.items.into_iter().map(|e| e.actor.0));
            match resp.next_cursor {
                Some(cursor) => page.cursor = Some(cursor),
                None => break,
            }
        }
        seen.sort();
        assert_eq!(seen, ["u1", "u2", "u3", "u4", "u5"]);
    }

    #[tokio::test]
    async fn social_graph_follow_block_mutual() {
        let graph = SocialGraph::new(store());

        graph.follow(&alice(), &bob_entity()).await.unwrap();
        graph.follow(&bob(), &alice_entity()).await.unwrap();
        assert!(graph.is_mutual(&alice(), &bob()).await.unwrap());

        // Block severs follows in both directions.
        graph.block(&alice(), &bob_entity()).await.unwrap();
        assert!(!graph.is_following(&alice(), &bob_entity()).await.unwrap());
        assert!(!graph.is_following(&bob(), &alice_entity()).await.unwrap());
        assert!(graph.is_blocked(&alice(), &bob_entity()).await.unwrap());

        // Following a blocked entity is rejected.
        assert!(graph.follow(&alice(), &bob_entity()).await.is_err());
    }
}
