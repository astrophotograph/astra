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
use kith::storage::{GraphStore, NotificationSink, NotificationStore, SubscriptionStore};
use kith::types::{
    Edge, EdgeKind, EntityId, EntityKind, Event, Notification, Subscription, SubscriptionFilter,
    SubscriptionId, UserId,
};

use crate::db::schema::{kith_edges, kith_notifications, kith_subscriptions};
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
            created_at: parse_rfc3339(&self.created_at)?,
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

/// One `kith_subscriptions` row. Field order matches the `table!` declaration.
#[derive(Queryable)]
struct SubscriptionRow {
    id: String,
    actor_id: String,
    topic_kind: String,
    topic_id: String,
    filter_json: Option<String>,
    created_at: String,
}

impl SubscriptionRow {
    fn into_subscription(self) -> Result<Subscription> {
        Ok(Subscription {
            id: SubscriptionId(self.id),
            actor: UserId(self.actor_id),
            topic: EntityId::new(decode_entity_kind(&self.topic_kind)?, self.topic_id),
            filter: match self.filter_json.as_deref() {
                None | Some("") => SubscriptionFilter::default(),
                Some(json) => serde_json::from_str(json)
                    .map_err(|e| storage_err(format!("bad filter_json: {e}")))?,
            },
            created_at: parse_rfc3339(&self.created_at)?,
        })
    }
}

/// One `kith_notifications` row. Field order matches the `table!` declaration.
#[derive(Queryable)]
struct NotificationRow {
    id: String,
    recipient_id: String,
    source_id: String,
    entity_kind: String,
    entity_id: String,
    event_kind: String,
    payload_json: Option<String>,
    created_at: String,
    read: i32,
}

impl NotificationRow {
    fn into_notification(self) -> Result<Notification> {
        Ok(Notification {
            id: self.id,
            recipient: UserId(self.recipient_id),
            event: Event {
                source: UserId(self.source_id),
                entity: EntityId::new(decode_entity_kind(&self.entity_kind)?, self.entity_id),
                kind: serde_json::from_str(&self.event_kind)
                    .map_err(|e| storage_err(format!("bad event_kind {:?}: {e}", self.event_kind)))?,
                payload: match self.payload_json.as_deref() {
                    None | Some("") => Default::default(),
                    Some(json) => serde_json::from_str(json)
                        .map_err(|e| storage_err(format!("bad event payload: {e}")))?,
                },
            },
            created_at: parse_rfc3339(&self.created_at)?,
            read: self.read != 0,
        })
    }
}

fn parse_rfc3339(s: &str) -> Result<DateTime<Utc>> {
    Ok(DateTime::parse_from_rfc3339(s)
        .map_err(|e| storage_err(format!("bad created_at {s:?}: {e}")))?
        .with_timezone(&Utc))
}

#[async_trait]
impl SubscriptionStore for AstraKithStore {
    async fn subscribe(
        &self,
        actor: &UserId,
        topic: &EntityId,
        filter: SubscriptionFilter,
    ) -> Result<SubscriptionId> {
        // UUID rather than SqliteStore's counters-table sequence — the
        // kith_social schema has no counters, and opaque IDs are all the
        // trait promises.
        let id = SubscriptionId(format!("sub_{}", uuid::Uuid::new_v4()));

        let pool = self.pool.clone();
        let row_id = id.0.clone();
        let actor = actor.0.clone();
        let topic_kind = encode_entity_kind(&topic.kind)?;
        let topic_id = topic.id.clone();
        let filter_json = serde_json::to_string(&filter).map_err(storage_err)?;
        let created_at = Utc::now().to_rfc3339();

        run_blocking(move || {
            let mut conn = pool.get().map_err(storage_err)?;
            diesel::insert_into(kith_subscriptions::table)
                .values((
                    kith_subscriptions::id.eq(row_id),
                    kith_subscriptions::actor_id.eq(actor),
                    kith_subscriptions::topic_kind.eq(topic_kind),
                    kith_subscriptions::topic_id.eq(topic_id),
                    kith_subscriptions::filter_json.eq(filter_json),
                    kith_subscriptions::created_at.eq(created_at),
                ))
                .execute(&mut conn)
                .map_err(storage_err)?;
            Ok(())
        })
        .await?;
        Ok(id)
    }

    async fn unsubscribe(&self, id: &SubscriptionId) -> Result<()> {
        let pool = self.pool.clone();
        let id = id.0.clone();
        run_blocking(move || {
            let mut conn = pool.get().map_err(storage_err)?;
            diesel::delete(kith_subscriptions::table.filter(kith_subscriptions::id.eq(id)))
                .execute(&mut conn)
                .map_err(storage_err)?;
            Ok(())
        })
        .await
    }

    async fn subscriptions_for(&self, actor: &UserId) -> Result<Vec<Subscription>> {
        let pool = self.pool.clone();
        let actor = actor.0.clone();
        run_blocking(move || {
            let mut conn = pool.get().map_err(storage_err)?;
            kith_subscriptions::table
                .filter(kith_subscriptions::actor_id.eq(actor))
                .order(kith_subscriptions::created_at.asc())
                .load::<SubscriptionRow>(&mut conn)
                .map_err(storage_err)?
                .into_iter()
                .map(SubscriptionRow::into_subscription)
                .collect()
        })
        .await
    }

    async fn subscribers_of(&self, topic: &EntityId) -> Result<Vec<Subscription>> {
        let pool = self.pool.clone();
        let topic_kind = encode_entity_kind(&topic.kind)?;
        let topic_id = topic.id.clone();
        run_blocking(move || {
            let mut conn = pool.get().map_err(storage_err)?;
            kith_subscriptions::table
                .filter(kith_subscriptions::topic_kind.eq(topic_kind))
                .filter(kith_subscriptions::topic_id.eq(topic_id))
                .order(kith_subscriptions::created_at.asc())
                .load::<SubscriptionRow>(&mut conn)
                .map_err(storage_err)?
                .into_iter()
                .map(SubscriptionRow::into_subscription)
                .collect()
        })
        .await
    }
}

#[async_trait]
impl NotificationStore for AstraKithStore {
    async fn store_notification(&self, notification: &Notification) -> Result<()> {
        let pool = self.pool.clone();
        let id = notification.id.clone();
        let recipient = notification.recipient.0.clone();
        let source = notification.event.source.0.clone();
        let entity_kind = encode_entity_kind(&notification.event.entity.kind)?;
        let entity_id = notification.event.entity.id.clone();
        let event_kind = serde_json::to_string(&notification.event.kind).map_err(storage_err)?;
        let payload_json = serde_json::to_string(&notification.event.payload).map_err(storage_err)?;
        let created_at = notification.created_at.to_rfc3339();
        let read = notification.read as i32;

        run_blocking(move || {
            let mut conn = pool.get().map_err(storage_err)?;
            diesel::replace_into(kith_notifications::table)
                .values((
                    kith_notifications::id.eq(id),
                    kith_notifications::recipient_id.eq(recipient),
                    kith_notifications::source_id.eq(source),
                    kith_notifications::entity_kind.eq(entity_kind),
                    kith_notifications::entity_id.eq(entity_id),
                    kith_notifications::event_kind.eq(event_kind),
                    kith_notifications::payload_json.eq(payload_json),
                    kith_notifications::created_at.eq(created_at),
                    kith_notifications::read.eq(read),
                ))
                .execute(&mut conn)
                .map_err(storage_err)?;
            Ok(())
        })
        .await
    }

    async fn notifications_for(
        &self,
        user: &UserId,
        unread_only: bool,
    ) -> Result<Vec<Notification>> {
        let pool = self.pool.clone();
        let user = user.0.clone();
        run_blocking(move || {
            let mut conn = pool.get().map_err(storage_err)?;
            let mut query = kith_notifications::table
                .filter(kith_notifications::recipient_id.eq(user))
                .order(kith_notifications::created_at.desc())
                .into_boxed();
            if unread_only {
                query = query.filter(kith_notifications::read.eq(0));
            }
            query
                .load::<NotificationRow>(&mut conn)
                .map_err(storage_err)?
                .into_iter()
                .map(NotificationRow::into_notification)
                .collect()
        })
        .await
    }

    async fn mark_read(&self, notification_id: &str) -> Result<()> {
        let pool = self.pool.clone();
        let id = notification_id.to_owned();
        run_blocking(move || {
            let mut conn = pool.get().map_err(storage_err)?;
            let updated =
                diesel::update(kith_notifications::table.filter(kith_notifications::id.eq(&id)))
                    .set(kith_notifications::read.eq(1))
                    .execute(&mut conn)
                    .map_err(storage_err)?;
            if updated == 0 {
                return Err(KithError::NotFound(format!("notification {id}")));
            }
            Ok(())
        })
        .await
    }

    async fn mark_all_read(&self, user: &UserId) -> Result<()> {
        let pool = self.pool.clone();
        let user = user.0.clone();
        run_blocking(move || {
            let mut conn = pool.get().map_err(storage_err)?;
            diesel::update(
                kith_notifications::table.filter(kith_notifications::recipient_id.eq(user)),
            )
            .set(kith_notifications::read.eq(1))
            .execute(&mut conn)
            .map_err(storage_err)?;
            Ok(())
        })
        .await
    }

    async fn unread_count(&self, user: &UserId) -> Result<u64> {
        let pool = self.pool.clone();
        let user = user.0.clone();
        run_blocking(move || {
            let mut conn = pool.get().map_err(storage_err)?;
            let count: i64 = kith_notifications::table
                .filter(kith_notifications::recipient_id.eq(user))
                .filter(kith_notifications::read.eq(0))
                .count()
                .get_result(&mut conn)
                .map_err(storage_err)?;
            Ok(count as u64)
        })
        .await
    }

    async fn delete_notification(&self, notification_id: &str) -> Result<()> {
        let pool = self.pool.clone();
        let id = notification_id.to_owned();
        run_blocking(move || {
            let mut conn = pool.get().map_err(storage_err)?;
            let deleted =
                diesel::delete(kith_notifications::table.filter(kith_notifications::id.eq(&id)))
                    .execute(&mut conn)
                    .map_err(storage_err)?;
            if deleted == 0 {
                return Err(KithError::NotFound(format!("notification {id}")));
            }
            Ok(())
        })
        .await
    }
}

impl AstraKithStore {
    /// Who a notification belongs to, or `None` if the id is unknown.
    ///
    /// Not part of any Kith trait: `NotificationStore::mark_read` takes only
    /// an id, so route-level ownership checks ("mark only your own") need
    /// this lookup — recorded as trait-surface friction on the epic.
    pub async fn notification_recipient(&self, notification_id: &str) -> Result<Option<String>> {
        let pool = self.pool.clone();
        let id = notification_id.to_owned();
        run_blocking(move || {
            let mut conn = pool.get().map_err(storage_err)?;
            kith_notifications::table
                .filter(kith_notifications::id.eq(id))
                .select(kith_notifications::recipient_id)
                .first::<String>(&mut conn)
                .optional()
                .map_err(storage_err)
        })
        .await
    }
}

/// Parity with Kith's `SqliteStore`: the store itself can act as a delivery
/// sink, so an engine with no external channels still persists in-app
/// notifications.
#[async_trait]
impl NotificationSink for AstraKithStore {
    async fn send(&self, notification: &Notification) -> Result<()> {
        self.store_notification(notification).await
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

    // -- SubscriptionStore --

    #[tokio::test]
    async fn subscription_round_trip_and_unsubscribe() {
        let store = store();

        let id = store
            .subscribe(&alice(), &m42(), SubscriptionFilter::default())
            .await
            .unwrap();
        assert!(id.0.starts_with("sub_"));

        let subs = store.subscriptions_for(&alice()).await.unwrap();
        assert_eq!(subs.len(), 1);
        assert_eq!(subs[0].id, id);
        assert_eq!(subs[0].actor, alice());
        assert_eq!(subs[0].topic, m42());

        let subscribers = store.subscribers_of(&m42()).await.unwrap();
        assert_eq!(subscribers.len(), 1);
        // A different topic has no subscribers.
        assert!(store
            .subscribers_of(&EntityId::object("NGC 7000"))
            .await
            .unwrap()
            .is_empty());

        store.unsubscribe(&id).await.unwrap();
        assert!(store.subscriptions_for(&alice()).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn subscription_filter_survives_round_trip() {
        let store = store();
        let filter = SubscriptionFilter {
            event_kinds: Some(vec![
                kith::types::EventKind::NewContent,
                kith::types::EventKind::Mentioned,
            ]),
            metadata_match: Some(
                [("telescope".to_string(), "seestar".to_string())]
                    .into_iter()
                    .collect(),
            ),
        };

        store
            .subscribe(&alice(), &m42(), filter.clone())
            .await
            .unwrap();

        let subs = store.subscriptions_for(&alice()).await.unwrap();
        assert_eq!(subs[0].filter, filter);
    }

    // -- NotificationStore --

    fn notification(id: &str, recipient: &UserId, minutes_ago: i64) -> Notification {
        Notification {
            id: id.to_string(),
            recipient: recipient.clone(),
            event: Event {
                source: bob(),
                entity: m42(),
                kind: kith::types::EventKind::NewContent,
                payload: [("collection".to_string(), "orion".to_string())]
                    .into_iter()
                    .collect(),
            },
            created_at: Utc::now() - chrono::Duration::minutes(minutes_ago),
            read: false,
        }
    }

    #[tokio::test]
    async fn notifications_ordering_and_unread_filter() {
        let store = store();
        store
            .store_notification(&notification("n_old", &alice(), 30))
            .await
            .unwrap();
        store
            .store_notification(&notification("n_new", &alice(), 1))
            .await
            .unwrap();
        // Someone else's notification stays out of alice's feed.
        store
            .store_notification(&notification("n_other", &carol(), 5))
            .await
            .unwrap();

        let all = store.notifications_for(&alice(), false).await.unwrap();
        assert_eq!(
            all.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(),
            ["n_new", "n_old"],
            "newest first"
        );
        // Event fields round-trip through the decomposed columns.
        assert_eq!(all[0].event.source, bob());
        assert_eq!(all[0].event.entity, m42());
        assert_eq!(all[0].event.kind, kith::types::EventKind::NewContent);
        assert_eq!(
            all[0].event.payload.get("collection").map(String::as_str),
            Some("orion")
        );

        store.mark_read("n_old").await.unwrap();
        let unread = store.notifications_for(&alice(), true).await.unwrap();
        assert_eq!(unread.len(), 1);
        assert_eq!(unread[0].id, "n_new");
    }

    #[tokio::test]
    async fn read_state_and_delete_lifecycle() {
        let store = store();
        store
            .store_notification(&notification("n1", &alice(), 3))
            .await
            .unwrap();
        store
            .store_notification(&notification("n2", &alice(), 2))
            .await
            .unwrap();
        store
            .store_notification(&notification("n3", &alice(), 1))
            .await
            .unwrap();
        assert_eq!(store.unread_count(&alice()).await.unwrap(), 3);

        store.mark_read("n1").await.unwrap();
        assert_eq!(store.unread_count(&alice()).await.unwrap(), 2);

        store.mark_all_read(&alice()).await.unwrap();
        assert_eq!(store.unread_count(&alice()).await.unwrap(), 0);

        store.delete_notification("n2").await.unwrap();
        let remaining = store.notifications_for(&alice(), false).await.unwrap();
        assert_eq!(
            remaining.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(),
            ["n3", "n1"]
        );

        // Missing IDs surface NotFound, matching kith's SqliteStore.
        assert!(matches!(
            store.mark_read("nope").await,
            Err(KithError::NotFound(_))
        ));
        assert!(matches!(
            store.delete_notification("n2").await,
            Err(KithError::NotFound(_))
        ));
    }

    #[tokio::test]
    async fn notifications_page_sanity() {
        let store = store();
        for i in 0..5 {
            store
                .store_notification(&notification(&format!("n{i}"), &alice(), 10 - i))
                .await
                .unwrap();
        }

        let page = store
            .notifications_for_page(&alice(), false, &PageRequest::new(2))
            .await
            .unwrap();
        assert_eq!(page.total, Some(5));
        assert_eq!(
            page.items.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(),
            ["n4", "n3"],
            "newest first"
        );
        assert!(page.next_cursor.is_some());
    }

    // -- SubscriptionEngine integration --

    #[tokio::test]
    async fn engine_delivers_new_content_and_suppresses_blocked() {
        use kith::subscribe::SubscriptionEngine;
        use kith::types::EventKind;

        let store = store();
        // No external sinks; persistence goes through the notification store.
        // `with_graph_store` only exists on the unparameterized engine, so
        // the second attachment must use the `_on` variant.
        let engine = SubscriptionEngine::new(store.clone(), Vec::<AstraKithStore>::new())
            .with_notification_store(store.clone())
            .with_graph_store_on(store.clone());

        // Alice and Carol both subscribe to M42; Carol has blocked Bob.
        engine
            .subscribe(&alice(), &m42(), SubscriptionFilter::default())
            .await
            .unwrap();
        engine
            .subscribe(&carol(), &m42(), SubscriptionFilter::default())
            .await
            .unwrap();
        store
            .add_edge(&Edge::new(carol(), bob_entity(), EdgeKind::Block))
            .await
            .unwrap();

        let event = Event {
            source: bob(),
            entity: m42(),
            kind: EventKind::NewContent,
            payload: Default::default(),
        };
        let sent = engine.emit(&event).await.unwrap();

        // Only Alice is notified: Carol's block suppresses delivery.
        assert_eq!(sent, 1);
        let notifs = store.notifications_for(&alice(), true).await.unwrap();
        assert_eq!(notifs.len(), 1);
        assert_eq!(notifs[0].event.kind, EventKind::NewContent);
        assert_eq!(notifs[0].event.source, bob());
        assert!(store
            .notifications_for(&carol(), false)
            .await
            .unwrap()
            .is_empty());
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
