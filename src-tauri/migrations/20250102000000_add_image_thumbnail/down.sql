-- SQLite doesn't support DROP COLUMN directly
-- We need to recreate the table without the thumbnail column
CREATE TABLE images_backup AS SELECT
    id, user_id, collection_id, filename, url, summary, description,
    content_type, favorite, tags, visibility, location, annotations,
    metadata, is_synced, created_at, updated_at
FROM images;

DROP TABLE images;

CREATE TABLE images (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    collection_id TEXT REFERENCES collections(id),
    filename TEXT NOT NULL,
    url TEXT,
    summary TEXT,
    description TEXT,
    content_type TEXT,
    favorite BOOLEAN NOT NULL DEFAULT FALSE,
    tags TEXT,
    visibility TEXT,
    location TEXT,
    annotations TEXT,
    metadata TEXT,
    is_synced BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO images SELECT * FROM images_backup;
DROP TABLE images_backup;
