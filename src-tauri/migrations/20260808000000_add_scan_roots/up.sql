-- User-curated scan roots for the unimported-files scan.
-- Replaces the auto-derived "walk up 3 parents from each image URL" heuristic
-- with an explicit list the user controls.
CREATE TABLE scan_roots (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    path TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, path)
);

CREATE INDEX idx_scan_roots_user ON scan_roots(user_id);
