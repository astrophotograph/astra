-- Magic-link sign-in for custodial viewers (kenning private store,
-- docs/private-store.md §3 and the 2026-10-30 review decisions).
--
-- magic_tokens: one-time sign-in links. Only the SHA-256 of the token in
-- the emailed URL is stored; a token is valid for 15 minutes and is marked
-- used on first redemption. Requesting a new link replaces the user's
-- outstanding one.
CREATE TABLE magic_tokens (
    token_hash TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    expires_at TIMESTAMP NOT NULL,
    used_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_magic_tokens_user_id ON magic_tokens(user_id);

-- viewer_sessions: server-side sessions established by a magic link. The
-- OIDC cookie stays stateless; these rows exist so a family member's
-- session can be 30 days *sliding* (expires_at moves forward on use) and
-- revocable by the admin. The astra_session cookie names the row by id.
CREATE TABLE viewer_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMP NOT NULL,
    expires_at TIMESTAMP NOT NULL
);

CREATE INDEX idx_viewer_sessions_user_id ON viewer_sessions(user_id);
