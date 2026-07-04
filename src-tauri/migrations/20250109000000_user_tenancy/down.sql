DROP INDEX IF EXISTS idx_users_username;
DROP INDEX IF EXISTS idx_users_external_subject;
ALTER TABLE users DROP COLUMN status;
ALTER TABLE users DROP COLUMN role;
ALTER TABLE users DROP COLUMN external_subject;
