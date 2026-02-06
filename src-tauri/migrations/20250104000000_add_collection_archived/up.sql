-- Add archived column to collections table
ALTER TABLE collections ADD COLUMN archived BOOLEAN NOT NULL DEFAULT FALSE;
