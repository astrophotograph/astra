-- Kith social graph schema for astra.gallery
-- D1 (SQLite at the edge)

-- Social graph edges (follow, block, mute, circle membership)
CREATE TABLE IF NOT EXISTS edges (
    actor_id TEXT NOT NULL,
    target_kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    edge_kind TEXT NOT NULL,
    weight REAL NOT NULL DEFAULT 1.0,
    metadata TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (actor_id, target_kind, target_id, edge_kind)
);

CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_kind, target_id, edge_kind);
CREATE INDEX IF NOT EXISTS idx_edges_actor ON edges(actor_id, edge_kind);

-- Subscriptions (for notification matching)
CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL,
    topic_kind TEXT NOT NULL,
    topic_id TEXT NOT NULL,
    filter_json TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subs_actor ON subscriptions(actor_id);
CREATE INDEX IF NOT EXISTS idx_subs_topic ON subscriptions(topic_kind, topic_id);

-- Notifications
CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    recipient_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    entity_kind TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    event_kind TEXT NOT NULL,
    payload_json TEXT,
    created_at TEXT NOT NULL,
    read INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_notifs_recipient ON notifications(recipient_id, created_at DESC);

-- Curated lists
CREATE TABLE IF NOT EXISTS lists (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    public INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lists_owner ON lists(owner_id);

-- List items
CREATE TABLE IF NOT EXISTS list_items (
    id TEXT PRIMARY KEY,
    list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    entity_kind TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    title TEXT,
    note TEXT,
    position INTEGER NOT NULL,
    added_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_list_items_list ON list_items(list_id, position);

-- Comments (Astra-specific, not part of Kith core)
CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    gallery_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    author_username TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    edited_at TEXT,
    deleted INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_comments_gallery ON comments(gallery_id, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_author ON comments(author_id, created_at DESC);
