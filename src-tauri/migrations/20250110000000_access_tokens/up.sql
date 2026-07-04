-- Personal access tokens: bearer credentials for non-browser clients
-- (desktop push, CLI). Only the SHA-256 hash of the token is stored —
-- the plaintext is shown once at mint time and never persisted or logged.
CREATE TABLE access_tokens (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP,
    revoked_at TIMESTAMP
);

CREATE INDEX idx_access_tokens_user_id ON access_tokens(user_id);
