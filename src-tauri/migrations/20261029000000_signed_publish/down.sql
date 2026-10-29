DROP INDEX IF EXISTS idx_blob_digests_cid;
DROP TABLE blob_digests;
DROP INDEX IF EXISTS idx_published_records_user_rkey;
DROP INDEX IF EXISTS idx_published_records_collection_id;
DROP TABLE published_records;
ALTER TABLE images DROP COLUMN rkey;
DROP INDEX IF EXISTS idx_users_did;
ALTER TABLE users DROP COLUMN did;
