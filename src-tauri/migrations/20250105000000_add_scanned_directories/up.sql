-- Table to cache scanned directories and their last modification times
-- This allows skipping directories that haven't changed since last import
CREATE TABLE scanned_directories (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    path TEXT NOT NULL,
    -- Filesystem modification time (as Unix timestamp)
    fs_modified_at INTEGER NOT NULL,
    -- When we last scanned this directory
    last_scanned_at TEXT NOT NULL DEFAULT (datetime('now')),
    -- Number of image files found in this directory
    image_count INTEGER NOT NULL DEFAULT 0,
    -- Unique constraint on user_id + path
    UNIQUE(user_id, path)
);

-- Index for fast lookup by path
CREATE INDEX idx_scanned_directories_path ON scanned_directories(user_id, path);
