-- Add fits_url column to images table to store FITS file path separately
ALTER TABLE images ADD COLUMN fits_url TEXT;
