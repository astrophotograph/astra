-- Add blob_id column for HoardFS content-addressed storage
ALTER TABLE images ADD COLUMN blob_id TEXT;
CREATE INDEX idx_images_blob_id ON images(blob_id);
