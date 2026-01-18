-- Add equipment_id column to observation_schedules table
-- This allows associating schedules with specific equipment setups
-- NULL means no equipment association (backwards compatible)
ALTER TABLE observation_schedules ADD COLUMN equipment_id TEXT;
