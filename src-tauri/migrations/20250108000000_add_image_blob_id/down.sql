DROP INDEX IF EXISTS idx_images_blob_id;
-- SQLite doesn't support DROP COLUMN before 3.35.0
-- For older versions, this is a no-op (blob_id column remains but is unused)
ALTER TABLE images DROP COLUMN blob_id;
