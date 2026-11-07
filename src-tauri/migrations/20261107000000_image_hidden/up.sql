-- images.hidden: the owner's "don't show this in my library" flag for the
-- duds a bulk import drags in. Purely a listing preference: hidden images
-- stay in their collections, keep their assets and publish like any other.
ALTER TABLE images ADD COLUMN hidden BOOLEAN NOT NULL DEFAULT 0;
