-- SQLite doesn't support DROP COLUMN directly
-- We need to recreate the table without the tags column
CREATE TABLE astronomy_todos_backup AS SELECT
    id, user_id, name, ra, dec, magnitude, size, object_type,
    added_at, completed, completed_at, goal_time, notes, flagged,
    last_updated, created_at, updated_at
FROM astronomy_todos;

DROP TABLE astronomy_todos;

CREATE TABLE astronomy_todos (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    ra TEXT NOT NULL,
    dec TEXT NOT NULL,
    magnitude TEXT NOT NULL,
    size TEXT NOT NULL,
    object_type TEXT,
    added_at TEXT NOT NULL,
    completed BOOLEAN NOT NULL DEFAULT FALSE,
    completed_at TEXT,
    goal_time TEXT,
    notes TEXT,
    flagged BOOLEAN NOT NULL DEFAULT FALSE,
    last_updated TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO astronomy_todos SELECT * FROM astronomy_todos_backup;
DROP TABLE astronomy_todos_backup;
