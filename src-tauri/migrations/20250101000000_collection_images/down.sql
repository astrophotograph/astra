-- Drop collection_images join table
DROP INDEX IF EXISTS idx_collection_images_collection_id;
DROP INDEX IF EXISTS idx_collection_images_image_id;
DROP TABLE IF EXISTS collection_images;
