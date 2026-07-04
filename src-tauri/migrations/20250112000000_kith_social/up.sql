-- Kith-owned social tables (graph edges, subscriptions, notifications) for
-- the AstraKithStore adapter. Shapes mirror kith's reference schema in
-- kith/src/sqlite.rs — RFC3339 TEXT timestamps, JSON TEXT metadata — with
-- kith's Event decomposed into queryable columns on notifications.
-- Trust/curation tables are out of scope for this slice.

CREATE TABLE kith_edges (
    actor_id TEXT NOT NULL,
    target_kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    edge_kind TEXT NOT NULL,
    weight REAL NOT NULL DEFAULT 1.0,
    metadata TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (actor_id, target_kind, target_id, edge_kind)
);

CREATE INDEX idx_kith_edges_target ON kith_edges(target_kind, target_id, edge_kind);
CREATE INDEX idx_kith_edges_actor ON kith_edges(actor_id, edge_kind);

CREATE TABLE kith_subscriptions (
    id TEXT PRIMARY KEY NOT NULL,
    actor_id TEXT NOT NULL,
    topic_kind TEXT NOT NULL,
    topic_id TEXT NOT NULL,
    filter_json TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX idx_kith_subscriptions_actor ON kith_subscriptions(actor_id);
CREATE INDEX idx_kith_subscriptions_topic ON kith_subscriptions(topic_kind, topic_id);

CREATE TABLE kith_notifications (
    id TEXT PRIMARY KEY NOT NULL,
    recipient_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    entity_kind TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    event_kind TEXT NOT NULL,
    payload_json TEXT,
    created_at TEXT NOT NULL,
    read INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_kith_notifications_recipient ON kith_notifications(recipient_id, created_at DESC);
