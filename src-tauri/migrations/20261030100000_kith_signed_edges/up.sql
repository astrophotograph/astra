-- Signed edges (kith `kenning` feature, kith/src/signed.rs).
--
-- A follow or circle membership made by a user with a DID is signed as an
-- `sh.kith.graph.edge` record and the whole envelope is kept beside the
-- row so it can be re-verified or served to an indexer. Nullable: rows
-- written before this migration, and edges by users without a DID, stay
-- unsigned. Same additive-ALTER pattern as kith's own SqliteStore
-- (`edges.signed_json`). The row keys stay local `users.id`; the DIDs live
-- only inside the envelope (see daemon/kith_store.rs).
ALTER TABLE kith_edges ADD COLUMN signed_json TEXT NULL;
