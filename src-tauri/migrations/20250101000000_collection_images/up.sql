-- Create collection_images join table for many-to-many relationship
CREATE TABLE collection_images (
    id TEXT PRIMARY KEY NOT NULL,
    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    image_id TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(collection_id, image_id)
);

CREATE INDEX idx_collection_images_collection_id ON collection_images(collection_id);
CREATE INDEX idx_collection_images_image_id ON collection_images(image_id);

-- Migrate existing collection_id data to the join table
INSERT INTO collection_images (id, collection_id, image_id, created_at)
SELECT
    lower(hex(randomblob(16))),
    collection_id,
    id,
    created_at
FROM images
WHERE collection_id IS NOT NULL;
