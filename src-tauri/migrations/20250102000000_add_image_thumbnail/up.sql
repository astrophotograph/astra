-- Add thumbnail column to images table
-- Stores base64-encoded JPEG thumbnail for quick display
ALTER TABLE images ADD COLUMN thumbnail TEXT;
