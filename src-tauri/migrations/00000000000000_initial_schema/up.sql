-- Users table
CREATE TABLE users (
    id TEXT PRIMARY KEY NOT NULL,
    email TEXT UNIQUE,
    name TEXT,
    image TEXT,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    summary TEXT,
    bio TEXT,
    description TEXT,
    metadata TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Collections table
CREATE TABLE collections (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    description TEXT,
    visibility TEXT NOT NULL DEFAULT 'public',
    template TEXT,
    favorite BOOLEAN NOT NULL DEFAULT FALSE,
    tags TEXT,
    metadata TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_collections_user_id ON collections(user_id);
CREATE INDEX idx_collections_visibility ON collections(visibility);
CREATE INDEX idx_collections_template ON collections(template);

-- Images table
CREATE TABLE images (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    collection_id TEXT REFERENCES collections(id),
    filename TEXT NOT NULL,
    url TEXT,
    summary TEXT,
    description TEXT,
    content_type TEXT DEFAULT 'image/jpeg',
    favorite BOOLEAN NOT NULL DEFAULT FALSE,
    tags TEXT,
    visibility TEXT DEFAULT 'private',
    location TEXT,
    annotations TEXT,
    metadata TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_images_user_id ON images(user_id);
CREATE INDEX idx_images_collection_id ON images(collection_id);
CREATE INDEX idx_images_filename ON images(filename);

-- Astronomy Todos table
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

CREATE INDEX idx_astronomy_todos_user_id ON astronomy_todos(user_id);
CREATE INDEX idx_astronomy_todos_completed ON astronomy_todos(completed);
CREATE INDEX idx_astronomy_todos_flagged ON astronomy_todos(flagged);

-- Observation Schedules table
CREATE TABLE observation_schedules (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    description TEXT,
    scheduled_date TEXT,
    location TEXT,
    items TEXT NOT NULL DEFAULT '[]',
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_observation_schedules_user_id ON observation_schedules(user_id);
CREATE INDEX idx_observation_schedules_is_active ON observation_schedules(is_active);

-- Astro Objects (catalog cache)
CREATE TABLE astro_objects (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    object_type TEXT,
    seq INTEGER,
    aliases TEXT,
    notes TEXT,
    metadata TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_astro_objects_name ON astro_objects(name);

-- SIMBAD Cache table
CREATE TABLE simbad_cache (
    id TEXT PRIMARY KEY NOT NULL,
    object_name TEXT NOT NULL UNIQUE,
    data TEXT NOT NULL,
    cached_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_simbad_cache_object_name ON simbad_cache(object_name);

-- Create default local user for standalone mode
INSERT INTO users (id, name, email, username)
VALUES ('local-user', 'Local User', 'user@local', 'astronomer');
