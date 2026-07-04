-- Publishing as daemon state: a collection owned by a user is public (or
-- unlisted) at @username/slug. Replaces the Cloudflare worker's
-- shares/{id} + user-shares/ KV records.
CREATE TABLE published_collections (
    id TEXT PRIMARY KEY NOT NULL,
    collection_id TEXT NOT NULL UNIQUE REFERENCES collections(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'public',
    published_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    view_count INTEGER NOT NULL DEFAULT 0,
    UNIQUE (user_id, slug)
);

CREATE INDEX idx_published_collections_user_id ON published_collections(user_id);
