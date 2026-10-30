-- blob_digests.variant_blob_id: the HoardFS blob id (blake3) of the bytes
-- the sha256/CID in this row was computed from — the variant blob, or the
-- original when the file has no rendition at that quality. A cheap
-- freshness check: HoardFS's blob id changes exactly when the served bytes
-- do, so comparing it against the variant listing tells stale from fresh
-- without re-reading or re-hashing the bytes. NULL on rows computed before this column existed: those are
-- hashed once on first use and backfilled.
ALTER TABLE blob_digests ADD COLUMN variant_blob_id TEXT;
