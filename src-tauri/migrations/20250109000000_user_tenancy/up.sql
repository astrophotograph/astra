-- Multi-tenancy: external identity, role, and status on users.
-- Allowed values are enforced in code (src/db/tenancy.rs) because SQLite
-- cannot add CHECK constraints via ALTER TABLE.
ALTER TABLE users ADD COLUMN external_subject TEXT;
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member';
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';

-- Unique identity handles. NULL rows are exempt (SQLite unique indexes
-- ignore NULLs), so users without an external identity or handle coexist.
CREATE UNIQUE INDEX idx_users_external_subject ON users(external_subject);
CREATE UNIQUE INDEX idx_users_username ON users(username);

-- The desktop's local user is the instance owner; align the @handle with
-- the existing astra.gallery profile.
UPDATE users SET role = 'owner', username = 'erewhon' WHERE id = 'local-user';
