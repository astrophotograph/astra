-- SQLite doesn't support DROP COLUMN directly
-- This migration cannot be fully reversed in SQLite
-- The column will remain but can be ignored
SELECT 1;
