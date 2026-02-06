-- Add tags column to astronomy_todos table
-- Stores JSON array of tags, e.g., ["location:backyard", "equipment:seestar", "dark-sky"]
ALTER TABLE astronomy_todos ADD COLUMN tags TEXT;
