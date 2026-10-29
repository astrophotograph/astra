-- Signed publishing (kenning records).
--
-- users.did: the author's AT Protocol DID (did:plc / did:web), set out of
-- band via PUT /api/me/did. Records are published under at://<did>/...
ALTER TABLE users ADD COLUMN did TEXT;
CREATE UNIQUE INDEX idx_users_did ON users(did) WHERE did IS NOT NULL;

-- images.rkey: the gallery.astra.image record key (a TID), minted at first
-- publish and reused on every republish so the record URI stays stable.
ALTER TABLE images ADD COLUMN rkey TEXT;

-- Stored SignedRecord JSON, served verbatim by the public gallery routes.
-- `uri` is at://<did>/<collection>/<rkey>; `collection` is the NSID.
CREATE TABLE published_records (
    uri TEXT PRIMARY KEY NOT NULL,
    collection_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    collection TEXT NOT NULL,
    rkey TEXT NOT NULL,
    cid TEXT NOT NULL,
    signed_json TEXT NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_published_records_collection_id ON published_records(collection_id);
CREATE INDEX idx_published_records_user_rkey ON published_records(user_id, collection, rkey);

-- Digests of HoardFS variant bytes: a blob's preview/thumbnail rendition as
-- the atproto blob reference carries it (CIDv1 raw + sha256, size, mime).
-- Computed once per (blob, quality) at publish time; also the index behind
-- GET /blob/{cid}.
CREATE TABLE blob_digests (
    blob_id TEXT NOT NULL,
    quality TEXT NOT NULL,
    cid TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size BIGINT NOT NULL,
    mime TEXT NOT NULL,
    PRIMARY KEY (blob_id, quality)
);
CREATE INDEX idx_blob_digests_cid ON blob_digests(cid);
