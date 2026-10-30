//! Signed publishing: `gallery.astra.*` records built from database rows,
//! validated against the lexicons under `lexicons/`, signed with the
//! daemon's app key (kenning envelope) and stored as `SignedRecord` JSON in
//! `published_records`, from where the public gallery routes serve them
//! verbatim.
//!
//! The record bodies mirror [`crate::share::manifest`] field for field: an
//! image row goes through [`manifest::manifest_image_from_row`] first, then
//! the floats are scaled to the integer sub-units the lexicons require
//! (`lexicons/README.md` is the authoritative table; `tests/lexicons.rs`
//! the executable spec). Optionals are omitted, never `null`; datetimes are
//! RFC 3339 UTC with millisecond precision and a `Z` suffix.
//!
//! Blob references carry a CIDv1 (`raw` codec 0x55, sha2-256) of the
//! HoardFS variant bytes — not the HoardFS blake3 blob id — so a record is
//! meaningful to any AT Protocol consumer. The daemon remembers each
//! variant's digest in `blob_digests`, which is also what resolves
//! `GET /blob/{cid}` back to a HoardFS blob + quality.
//!
//! A cached digest is only as good as the bytes it was taken from, and
//! processing can regenerate a rendition in place. Every variant write
//! goes through [`on_variant_written`] (drop the digests, re-sign the
//! containing published collections); each row also remembers the HoardFS
//! variant blob id it hashed, so a republish ([`variant_digest`]) and the
//! blob route ([`verify_blob_digest`]) can tell a stale row from a fresh
//! one with a metadata lookup and re-hash only when it has gone stale.
//!
//! Signing is optional: without `ASTRA_SIGNING_KEY_SOURCE` the daemon keeps
//! serving the legacy live manifest, and a user without a `users.did` keeps
//! publishing the legacy way too.
//!
//! # Circle collections (`visibility = circle:<name>`)
//!
//! The records of a circle collection are signed exactly like public ones
//! but stored with `published_records.private = 1`, so the public routes
//! serve them only after the kith ACL (`daemon::acl`). In their place the
//! owner's public collection `sh.kenning.private.stub` carries a signed
//! [`StubRecord`] at the same rkey (the slug): subject URI + CID, this
//! host's public URL (`ASTRA_PUBLIC_URL`) and the visibility. An image
//! that also sits in a public or unlisted published collection keeps a
//! public record — its bytes are public anyway. See
//! `kenning/docs/private-store.md`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use chrono::{DateTime, NaiveDateTime, SecondsFormat, Utc};
use diesel::prelude::*;
use hoardfs_core::Quality;
use ipld_core::cid::multihash::Multihash;
use ipld_core::cid::Cid;
use kenning::envelope::{sign, SignedRecord};
use kenning::keys::SigningKey;
use kenning::keystore::{load_signing_key, KeySource};
use kenning::lexicon::LexiconRegistry;
use kenning::private::{StubRecord, Visibility, STUB_NSID};
use kenning::record::{AtUri, BlobRef, Nsid, Record, Rkey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::commands::publish::{self, Access};
use crate::db::models::{BlobDigest, Collection, Image, PublishedCollection, PublishedRecord};
use crate::db::schema::{blob_digests, images, published_collections, published_records, users};
use crate::db::{repository, tenancy, DbPool};
use crate::share::manifest::{self, ManifestImage, ManifestObject, ManifestPlateSolve};

pub const COLLECTION_NSID: &str = "gallery.astra.collection";
pub const IMAGE_NSID: &str = "gallery.astra.image";

/// `ho:<name>` | `file:<path>` | `env:<VAR>` (kenning `KeySource`).
pub const SIGNING_KEY_SOURCE_ENV: &str = "ASTRA_SIGNING_KEY_SOURCE";
/// Verification method id in the author's DID document. Default `astra`.
pub const SIGNING_METHOD_ID_ENV: &str = "ASTRA_SIGNING_METHOD_ID";
/// Directory holding the `gallery.astra.*.json` lexicons.
pub const LEXICONS_DIR_ENV: &str = "ASTRA_LEXICONS_DIR";
/// This daemon's public base URL (`https://astra.gallery`), written into
/// the `host` of every private-record stub. Required to publish a circle
/// collection; nothing else reads it.
pub const PUBLIC_URL_ENV: &str = "ASTRA_PUBLIC_URL";
pub const DEFAULT_METHOD_ID: &str = "astra";

/// Multicodec `raw` — blob CIDs address the bytes themselves.
const RAW_CODEC: u64 = 0x55;
/// Multicodec `sha2-256`.
const SHA2_256_CODE: u64 = 0x12;

// ---------------------------------------------------------------------------
// Signer (daemon-wide signing context)
// ---------------------------------------------------------------------------

/// The daemon's signing identity plus the lexicons every record is
/// validated against before it is signed. Built once at startup.
pub struct Signer {
    pub key: SigningKey,
    pub method_id: String,
    pub lexicons: LexiconRegistry,
    /// `ASTRA_PUBLIC_URL`, the `host` a private-record stub points at.
    /// None → circle collections cannot be published (clear error).
    pub public_url: Option<String>,
}

impl Signer {
    pub fn new(key: SigningKey, method_id: impl Into<String>, lexicons: LexiconRegistry) -> Self {
        Self {
            key,
            method_id: method_id.into(),
            lexicons,
            public_url: None,
        }
    }

    /// Set the public base URL stubs advertise (trailing `/` dropped).
    pub fn with_public_url(mut self, url: impl Into<String>) -> Self {
        let url = url.into();
        let url = url.trim().trim_end_matches('/').to_string();
        self.public_url = (!url.is_empty()).then_some(url);
        self
    }

    /// Resolve the signer from the environment. `Ok(None)` when
    /// `ASTRA_SIGNING_KEY_SOURCE` is unset or empty (signed publishing
    /// disabled); `Err` when it is set but the key or the lexicons cannot
    /// be loaded — a misconfigured daemon must not start half-signed.
    pub fn from_env(data_dir: &Path) -> Result<Option<Self>, String> {
        let spec = match std::env::var(SIGNING_KEY_SOURCE_ENV) {
            Ok(s) if !s.trim().is_empty() => s,
            _ => return Ok(None),
        };
        let source = KeySource::parse(&spec)
            .map_err(|e| format!("{SIGNING_KEY_SOURCE_ENV}={spec:?}: {e}"))?;
        let key = load_signing_key(&source)
            .map_err(|e| format!("loading signing key from {source}: {e}"))?;
        let method_id = std::env::var(SIGNING_METHOD_ID_ENV)
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_METHOD_ID.to_string());
        let dir = resolve_lexicons_dir(data_dir)?;
        let lexicons = LexiconRegistry::from_dir(&dir)
            .map_err(|e| format!("loading lexicons from {}: {e}", dir.display()))?;
        for nsid in [COLLECTION_NSID, IMAGE_NSID, STUB_NSID] {
            if lexicons
                .get(&Nsid::new(nsid).expect("static NSID"))
                .is_none()
            {
                return Err(format!("lexicons dir {} has no {nsid}", dir.display()));
            }
        }
        log::info!(
            "signed publishing enabled (method #{method_id}, key {}, {} lexicons from {})",
            key.verifying_key().to_did_key(),
            lexicons.len(),
            dir.display()
        );
        let signer = Self::new(key, method_id, lexicons)
            .with_public_url(std::env::var(PUBLIC_URL_ENV).unwrap_or_default());
        match &signer.public_url {
            Some(url) => log::info!("private-record stubs will name this host as {url}"),
            None => log::warn!(
                "{PUBLIC_URL_ENV} not set — publishing a circle:<name> collection will fail \
                 until it is (public and unlisted publishing are unaffected)"
            ),
        }
        Ok(Some(signer))
    }
}

/// Where the lexicons live: `ASTRA_LEXICONS_DIR`, else `{data_dir}/lexicons`
/// (deployed next to the web bundle, see `docs/hosting.md`), else the
/// source tree's `lexicons/` when running from a checkout.
pub fn resolve_lexicons_dir(data_dir: &Path) -> Result<PathBuf, String> {
    if let Some(dir) = std::env::var_os(LEXICONS_DIR_ENV).filter(|v| !v.is_empty()) {
        let dir = PathBuf::from(dir);
        return if dir.is_dir() {
            Ok(dir)
        } else {
            Err(format!(
                "{LEXICONS_DIR_ENV}={} is not a directory",
                dir.display()
            ))
        };
    }
    let deployed = data_dir.join("lexicons");
    if deployed.is_dir() {
        return Ok(deployed);
    }
    let checkout = Path::new(env!("CARGO_MANIFEST_DIR")).join("../lexicons");
    if checkout.is_dir() {
        return Ok(checkout);
    }
    Err(format!(
        "no lexicons directory: set {LEXICONS_DIR_ENV} or install lexicons/ at {}",
        deployed.display()
    ))
}

// ---------------------------------------------------------------------------
// Record bodies
// ---------------------------------------------------------------------------

/// `{ uri, cid }` — `com.atproto.repo.strongRef` shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StrongRef {
    pub uri: String,
    pub cid: String,
}

/// `gallery.astra.collection` record body.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionBody {
    #[serde(rename = "$type")]
    pub r#type: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date_range_start: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date_range_end: Option<String>,
    pub images: Vec<StrongRef>,
    pub visibility: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover_image: Option<StrongRef>,
}

/// `gallery.astra.image` record body.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageBody {
    #[serde(rename = "$type")]
    pub r#type: String,
    pub filename: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    pub content_type: String,
    pub created_at: String,
    pub favorite: bool,
    pub catalog_ids: Vec<String>,
    pub preview: BlobRef,
    pub thumbnail: BlobRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plate_solve: Option<PlateSolveBody>,
    pub objects: Vec<CatalogObjectBody>,
}

/// `gallery.astra.image#plateSolve`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlateSolveBody {
    pub center_ra_micro_deg: i64,
    pub center_dec_micro_deg: i64,
    pub pixel_scale_milli_arcsec: i64,
    pub rotation_milli_deg: i64,
    pub width_milli_deg: i64,
    pub height_milli_deg: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_height: Option<u32>,
}

/// `gallery.astra.image#catalogObject`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogObjectBody {
    pub name: String,
    pub ra_micro_deg: i64,
    pub dec_micro_deg: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub magnitude_milli: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_arcsec_tenths: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pixel_x: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pixel_y: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radius_px: Option<i64>,
}

// ---------------------------------------------------------------------------
// Encodings (lexicons/README.md "Why integers everywhere")
// ---------------------------------------------------------------------------

/// Degrees to millionths of a degree.
pub fn micro_deg(deg: f64) -> i64 {
    (deg * 1e6).round() as i64
}

/// A quantity to thousandths of itself (degrees -> milli-degrees,
/// arcsec -> milli-arcsec, magnitudes -> milli-magnitudes).
pub fn milli(x: f64) -> i64 {
    (x * 1e3).round() as i64
}

/// Arcminutes to tenths of an arcsecond.
pub fn arcsec_tenths(arcmin: f64) -> i64 {
    (arcmin * 600.0).round() as i64
}

/// Pixel coordinate to the nearest whole pixel.
pub fn px(v: f64) -> i64 {
    v.round() as i64
}

/// Right ascension into `[0, 360)` before scaling: catalog data occasionally
/// carries `-0.0001` or `360.0`, both of which the lexicon range rejects.
fn ra_micro_deg(deg: f64) -> i64 {
    let wrapped = deg.rem_euclid(360.0);
    micro_deg(if wrapped >= 360.0 { 0.0 } else { wrapped })
}

/// Lexicon `datetime` form: RFC 3339, UTC, millisecond precision, `Z`.
pub fn datetime(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// A `NaiveDateTime` column (stored as UTC) in lexicon `datetime` form.
/// `NaiveDateTime::to_string()` gives `2026-01-15 20:00:00`, which is not
/// a valid lexicon datetime.
pub fn naive_datetime(at: NaiveDateTime) -> String {
    datetime(at.and_utc())
}

/// A manifest timestamp string into lexicon `datetime` form. Handles the
/// three shapes the manifest carries: RFC 3339, `NaiveDateTime` Display
/// (`YYYY-MM-DD HH:MM:SS[.frac]`, treated as UTC) and bare dates
/// (`YYYY-MM-DD`, widened to midnight UTC). Anything else passes through
/// and is caught by lexicon validation.
pub fn datetime_str(s: &str) -> String {
    let s = s.trim();
    if let Ok(date) = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return naive_datetime(date.and_hms_opt(0, 0, 0).expect("midnight"));
    }
    if let Ok(at) = DateTime::parse_from_rfc3339(s) {
        return datetime(at.with_timezone(&Utc));
    }
    for fmt in ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S%.f"] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(s, fmt) {
            return naive_datetime(naive);
        }
    }
    s.to_string()
}

// ---------------------------------------------------------------------------
// Blob digests
// ---------------------------------------------------------------------------

/// CIDv1 (`raw`, sha2-256) of some bytes plus the digest itself.
pub fn raw_cid(bytes: &[u8]) -> (Cid, [u8; 32]) {
    let digest: [u8; 32] = Sha256::digest(bytes).into();
    let mh = Multihash::<64>::wrap(SHA2_256_CODE, &digest).expect("32-byte digest fits");
    (Cid::new_v1(RAW_CODEC, mh), digest)
}

/// `blob_digests.quality` spelling for the two public renditions.
pub fn quality_name(quality: &Quality) -> Option<&'static str> {
    match quality {
        Quality::Preview => Some("preview"),
        Quality::Thumbnail => Some("thumbnail"),
        _ => None,
    }
}

pub fn quality_from_name(name: &str) -> Option<Quality> {
    match name {
        "preview" => Some(Quality::Preview),
        "thumbnail" => Some(Quality::Thumbnail),
        _ => None,
    }
}

impl BlobDigest {
    pub fn blob_ref(&self) -> Result<BlobRef, String> {
        let cid: Cid = self
            .cid
            .parse()
            .map_err(|e| format!("stored blob cid {}: {e}", self.cid))?;
        Ok(BlobRef::new(cid, self.mime.clone(), self.size as u64))
    }
}

/// The two renditions records reference and `/blob/{cid}` serves.
pub const PUBLIC_RENDITIONS: [Quality; 2] = [Quality::Preview, Quality::Thumbnail];

fn renditions_label(qualities: &[Quality]) -> String {
    qualities
        .iter()
        .filter_map(quality_name)
        .collect::<Vec<_>>()
        .join("+")
}

/// HoardFS's own identity for the bytes it serves as `quality` of a file:
/// the blob id (blake3) of the variant `get_file_quality` would pick —
/// the exact quality, else the first of its fallback chain — or of the
/// original when no rendition exists (small sources, see
/// `hoardfs_variant`). Metadata queries only; no bytes are read.
fn served_identity(
    hfs: &hoardfs_volume::HoardFs,
    volume: &str,
    hfs_path: &str,
    quality: &Quality,
) -> Result<String, String> {
    let variants = hfs
        .list_variants(volume, hfs_path)
        .map_err(|e| format!("variants of {hfs_path}: {e}"))?;
    for q in quality.fallback_chain() {
        if let Some(v) = variants.iter().find(|v| v.quality == q) {
            return Ok(v.variant_blob_id.clone());
        }
    }
    Ok(hfs
        .get_file_info(volume, hfs_path)
        .map_err(|e| format!("file info of {hfs_path}: {e}"))?
        .current_version
        .blob_id)
}

/// A cached digest row is trusted only while HoardFS still serves the
/// blob it was computed from. Rows from before `variant_blob_id` existed
/// (None) are never trusted blindly: they are hashed once and backfilled.
fn digest_is_current(row: &BlobDigest, current: &str) -> bool {
    row.variant_blob_id.as_deref() == Some(current)
}

/// Hash `bytes` into a `blob_digests` row for `(blob_id, quality)`.
fn digest_row(
    blob_id: &str,
    quality: &str,
    bytes: &[u8],
    mime: String,
    variant_blob_id: Option<String>,
) -> BlobDigest {
    let (cid, digest) = raw_cid(bytes);
    BlobDigest {
        blob_id: blob_id.to_string(),
        quality: quality.to_string(),
        cid: cid.to_string(),
        sha256: hex::encode(digest),
        size: bytes.len() as i64,
        mime,
        variant_blob_id,
    }
}

/// Digest of one variant's bytes, cached in `blob_digests` per
/// (blob, quality). The bytes are fetched from HoardFS and hashed
/// (blocking; `rt` drives the async HoardFS API) the first time a
/// rendition is published and again whenever the cached row no longer
/// names the variant blob HoardFS currently holds — i.e. after the
/// rendition was regenerated — so a republish always carries the CID of
/// the bytes `/blob/{cid}` will serve.
fn variant_digest(
    conn: &mut SqliteConnection,
    hoardfs: &Arc<Mutex<hoardfs_volume::HoardFs>>,
    rt: &tokio::runtime::Handle,
    volume: &str,
    hfs_path: &str,
    blob_id: &str,
    quality: Quality,
) -> Result<BlobDigest, String> {
    let name = quality_name(&quality).ok_or("quality is not a public rendition")?;
    let cached: Option<BlobDigest> = blob_digests::table
        .find((blob_id, name))
        .first(conn)
        .optional()
        .map_err(|e| e.to_string())?;

    let (bytes, mime, current) = {
        let hfs = hoardfs
            .lock()
            .map_err(|_| "HoardFS lock poisoned".to_string())?;
        let current = served_identity(&hfs, volume, hfs_path, &quality)?;
        if let Some(d) = cached {
            if digest_is_current(&d, &current) {
                return Ok(d);
            }
            log::info!(
                "blob digest for {blob_id} {name} is stale (variant {} -> {current}): re-hashing",
                d.variant_blob_id.as_deref().unwrap_or("unknown")
            );
        }
        let (bytes, _served, mime) = rt
            .block_on(hfs.get_file_quality(volume, hfs_path, quality))
            .map_err(|e| format!("variant {name} of {hfs_path}: {e}"))?;
        (bytes, mime, current)
    };
    let row = digest_row(blob_id, name, &bytes, mime, Some(current));
    diesel::replace_into(blob_digests::table)
        .values(&row)
        .execute(conn)
        .map_err(|e| e.to_string())?;
    Ok(row)
}

/// Outcome of [`verify_blob_digest`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DigestCheck {
    /// The bytes HoardFS serves for this rendition still hash to the row's
    /// CID (checked by variant identity, or by re-hashing when the row had
    /// no variant identity yet — it has one now).
    Fresh,
    /// The rendition was rewritten behind the digest: the row now carries
    /// the digest of the current bytes, and the old CID names nothing.
    Stale { new_cid: String },
}

/// Serving-time guard for `GET /blob/{cid}`: is `row` (a `blob_digests`
/// hit for the CID) still the digest of what HoardFS serves for that
/// rendition? Cheap path: the row's `variant_blob_id` equals the variant
/// blob HoardFS currently lists for the quality — one metadata query, no
/// bytes read, no hashing. Otherwise (regenerated variant, or a row from
/// before the column existed) the bytes are fetched and hashed once and
/// the row replaced; a changed hash is reported as [`DigestCheck::Stale`]
/// so the caller can 404 the old CID and trigger a re-sign.
pub fn verify_blob_digest(
    conn: &mut SqliteConnection,
    hoardfs: &Arc<Mutex<hoardfs_volume::HoardFs>>,
    rt: &tokio::runtime::Handle,
    volume: &str,
    hfs_path: &str,
    row: &BlobDigest,
    quality: &Quality,
) -> Result<DigestCheck, String> {
    let (bytes, mime, current) = {
        let hfs = hoardfs
            .lock()
            .map_err(|_| "HoardFS lock poisoned".to_string())?;
        let current = served_identity(&hfs, volume, hfs_path, quality)?;
        if digest_is_current(row, &current) {
            return Ok(DigestCheck::Fresh);
        }
        let (bytes, _served, mime) = rt
            .block_on(hfs.get_file_quality(volume, hfs_path, quality.clone()))
            .map_err(|e| format!("variant {} of {hfs_path}: {e}", row.quality))?;
        (bytes, mime, current)
    };
    let fresh = digest_row(&row.blob_id, &row.quality, &bytes, mime, Some(current));
    diesel::replace_into(blob_digests::table)
        .values(&fresh)
        .execute(conn)
        .map_err(|e| e.to_string())?;
    if fresh.cid == row.cid {
        Ok(DigestCheck::Fresh)
    } else {
        log::warn!(
            "blob digest for {} {} was stale: {} now digests to {}",
            row.blob_id,
            row.quality,
            row.cid,
            fresh.cid
        );
        Ok(DigestCheck::Stale { new_cid: fresh.cid })
    }
}

/// Forget the cached digests of `blob_id` for `qualities` (pass
/// [`PUBLIC_RENDITIONS`] for all). The next publish or `/blob/{cid}`
/// lookup re-hashes the bytes. This is the whole treatment on paths with
/// no daemon state (desktop Tauri commands): the daemon re-sign that
/// recomputes the digests happens on the next publish.
pub fn drop_variant_digests(
    conn: &mut SqliteConnection,
    blob_id: &str,
    qualities: &[Quality],
) -> Result<usize, String> {
    let names: Vec<&str> = qualities.iter().filter_map(quality_name).collect();
    if names.is_empty() {
        return Ok(0);
    }
    diesel::delete(
        blob_digests::table
            .filter(blob_digests::blob_id.eq(blob_id))
            .filter(blob_digests::quality.eq_any(&names)),
    )
    .execute(conn)
    .map_err(|e| e.to_string())
}

/// Re-sign every published collection containing an image whose asset is
/// `blob_id` (any owner), so the records' blob references follow the
/// bytes. `Ok(0)` without a signer. Blocking; needs a tokio runtime
/// (see [`publish_signed`]).
pub fn resign_for_blob(
    db: &DbPool,
    hoardfs: &Arc<Mutex<hoardfs_volume::HoardFs>>,
    signer: Option<&Signer>,
    blob_id: &str,
    reason: &str,
) -> Result<usize, String> {
    let Some(signer) = signer else {
        return Ok(0);
    };
    let owners: Vec<(String, String)> = {
        let mut conn = db.get().map_err(|e| e.to_string())?;
        images::table
            .filter(images::blob_id.eq(blob_id))
            .select((images::id, images::user_id))
            .load(&mut conn)
            .map_err(|e| e.to_string())?
    };
    let mut n = 0;
    for (image_id, user_id) in owners {
        let k = resign_collections_with_image(db, hoardfs, signer, &user_id, &image_id)?;
        if k > 0 {
            log::info!(
                "{reason} on blob {blob_id}: re-signed {k} published collection(s) containing image {image_id}"
            );
        }
        n += k;
    }
    Ok(n)
}

/// The one choke point for "a HoardFS rendition of `blob_id` was
/// (re)written": drop the cached digests for `qualities` and, with a
/// signer, re-sign every published collection containing an image backed
/// by the blob (which recomputes the digests and stores records carrying
/// the new CIDs). Returns the number of collections re-signed. Blocking;
/// call from `spawn_blocking` with the HoardFS lock released.
pub fn on_variant_written(
    db: &DbPool,
    hoardfs: &Arc<Mutex<hoardfs_volume::HoardFs>>,
    signer: Option<&Signer>,
    blob_id: &str,
    qualities: &[Quality],
) -> Result<usize, String> {
    {
        let mut conn = db.get().map_err(|e| e.to_string())?;
        drop_variant_digests(&mut conn, blob_id, qualities)?;
    }
    resign_for_blob(
        db,
        hoardfs,
        signer,
        blob_id,
        &format!("variant change ({})", renditions_label(qualities)),
    )
}

/// `blob_digests` rows whose CID is `cid` (as a record's `ref.$link`
/// carries it), each with its parsed quality. Usually one; two when a
/// small original yields byte-identical preview and thumbnail renditions.
/// Empty for unknown CIDs. Preview sorts first.
pub fn lookup_blob_cid_rows(
    conn: &mut SqliteConnection,
    cid: &str,
) -> Result<Vec<(BlobDigest, Quality)>, String> {
    let hits: Vec<BlobDigest> = blob_digests::table
        .filter(blob_digests::cid.eq(cid))
        .order(blob_digests::quality.asc())
        .load(conn)
        .map_err(|e| e.to_string())?;
    Ok(hits
        .into_iter()
        .filter_map(|d| quality_from_name(&d.quality).map(|q| (d, q)))
        .collect())
}

// ---------------------------------------------------------------------------
// Body builders (pure)
// ---------------------------------------------------------------------------

fn plate_solve_body(ps: &ManifestPlateSolve) -> PlateSolveBody {
    PlateSolveBody {
        center_ra_micro_deg: ra_micro_deg(ps.center_ra),
        center_dec_micro_deg: micro_deg(ps.center_dec),
        pixel_scale_milli_arcsec: milli(ps.pixel_scale),
        rotation_milli_deg: milli(ps.rotation),
        width_milli_deg: milli(ps.width_deg),
        height_milli_deg: milli(ps.height_deg),
        image_width: ps.image_width,
        image_height: ps.image_height,
    }
}

fn catalog_object_body(obj: &ManifestObject) -> CatalogObjectBody {
    CatalogObjectBody {
        name: obj.name.clone(),
        ra_micro_deg: ra_micro_deg(obj.ra),
        dec_micro_deg: micro_deg(obj.dec),
        magnitude_milli: obj.magnitude.map(milli),
        size_arcsec_tenths: obj.size_arcmin.map(arcsec_tenths),
        pixel_x: obj.pixel_x.map(px),
        pixel_y: obj.pixel_y.map(px),
        radius_px: obj.radius_px.map(px),
    }
}

/// One `gallery.astra.image` body from a manifest image plus the blob
/// references for its two public renditions. `original` is not published
/// in this version.
pub fn image_body(img: &ManifestImage, preview: BlobRef, thumbnail: BlobRef) -> ImageBody {
    ImageBody {
        r#type: IMAGE_NSID.to_string(),
        filename: img.filename.clone(),
        summary: img.summary.clone(),
        content_type: img.content_type.clone(),
        created_at: datetime_str(&img.created_at),
        favorite: img.favorite,
        catalog_ids: img.catalog_ids.clone(),
        preview,
        thumbnail,
        plate_solve: img.plate_solve.as_ref().map(plate_solve_body),
        objects: img.objects.iter().map(catalog_object_body).collect(),
    }
}

/// The `gallery.astra.collection` body: collection row + publish record +
/// the already-signed image references in display order.
pub fn collection_body(
    collection: &Collection,
    published: &PublishedCollection,
    images: Vec<StrongRef>,
    updated_at: DateTime<Utc>,
) -> CollectionBody {
    let date_range = collection.metadata.as_ref().and_then(|meta| {
        let parsed: serde_json::Value = serde_json::from_str(meta).ok()?;
        let df = parsed.get("dateFilter")?;
        let start = df.get("start")?.as_str()?.to_string();
        let end = df.get("end")?.as_str()?.to_string();
        Some((start, end))
    });
    CollectionBody {
        r#type: COLLECTION_NSID.to_string(),
        title: collection.name.clone(),
        description: collection.description.clone(),
        template: collection.template.clone(),
        created_at: naive_datetime(collection.created_at),
        updated_at: datetime(updated_at),
        date_range_start: date_range.as_ref().map(|(s, _)| datetime_str(s)),
        date_range_end: date_range.as_ref().map(|(_, e)| datetime_str(e)),
        cover_image: images.first().cloned(),
        images,
        visibility: published.visibility.clone(),
    }
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum SignError {
    /// A body failed lexicon validation; the publish is aborted (400).
    Invalid { uri: String, errors: Vec<String> },
    /// Anything else (DB, HoardFS, signing).
    Other(String),
}

impl std::fmt::Display for SignError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid { uri, errors } => {
                write!(f, "record {uri} failed validation: {}", errors.join("; "))
            }
            Self::Other(e) => f.write_str(e),
        }
    }
}

impl From<String> for SignError {
    fn from(e: String) -> Self {
        Self::Other(e)
    }
}

impl From<diesel::result::Error> for SignError {
    fn from(e: diesel::result::Error) -> Self {
        Self::Other(e.to_string())
    }
}

/// What a signed publish produced.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedPublish {
    pub uri: String,
    pub cid: String,
    pub image_count: usize,
    /// Images that were left out because they have no HoardFS asset yet
    /// (their `preview`/`thumbnail` blobs cannot exist). They join the
    /// record on the next re-sign — the asset upload path triggers one.
    pub skipped_images: usize,
}

/// A record body validated and signed: the stored row plus its parts.
struct Signed {
    row: PublishedRecord,
}

fn sign_and_store<T: Serialize>(
    signer: &Signer,
    uri: AtUri,
    body: T,
    collection_id: &str,
    user_id: &str,
    now: NaiveDateTime,
    private: bool,
) -> Result<Signed, SignError> {
    let uri_string = uri.to_string();
    let record = Record::new(uri, body).map_err(|e| e.to_string())?;
    if let Err(errors) = signer.lexicons.validate_record(&record) {
        return Err(SignError::Invalid {
            uri: uri_string,
            errors: errors.into_iter().map(|e| e.to_string()).collect(),
        });
    }
    let signed: SignedRecord<T> =
        sign(record, &signer.method_id, &signer.key).map_err(|e| e.to_string())?;
    let signed_json = serde_json::to_string(&signed).map_err(|e| e.to_string())?;
    Ok(Signed {
        row: PublishedRecord {
            uri: uri_string,
            collection_id: collection_id.to_string(),
            user_id: user_id.to_string(),
            collection: signed.record.uri.collection.to_string(),
            rkey: signed.record.uri.rkey.to_string(),
            cid: signed.cid.to_string(),
            signed_json,
            updated_at: now,
            private,
        },
    })
}

/// The user's DID, if linked.
pub fn user_did(conn: &mut SqliteConnection, user_id: &str) -> Result<Option<String>, String> {
    users::table
        .find(user_id)
        .select(users::did)
        .first::<Option<String>>(conn)
        .optional()
        .map(Option::flatten)
        .map_err(|e| e.to_string())
}

/// Build, validate, sign and store the records for a published collection.
///
/// Returns `Ok(None)` when the user has no DID (legacy publish stays in
/// effect) and `Err(Other)` when the collection has no publish record.
/// For a `circle:` collection the collection record and the records of
/// images not otherwise public are stored private, and a public stub is
/// stored beside them (requires [`Signer::public_url`]). Blocking: call
/// from `spawn_blocking` inside a tokio runtime — HoardFS variant fetches
/// are driven through `Handle::current()`.
pub fn publish_signed(
    db: &DbPool,
    hoardfs: &Arc<Mutex<hoardfs_volume::HoardFs>>,
    signer: &Signer,
    user_id: &str,
    collection_id: &str,
) -> Result<Option<SignedPublish>, SignError> {
    let rt = tokio::runtime::Handle::current();
    let mut conn = db.get().map_err(|e| e.to_string())?;

    let Some(did) = user_did(&mut conn, user_id)? else {
        return Ok(None);
    };

    let published: PublishedCollection = published_collections::table
        .filter(published_collections::collection_id.eq(collection_id))
        .filter(published_collections::user_id.eq(user_id))
        .first(&mut conn)
        .optional()?
        .ok_or_else(|| format!("collection {collection_id} is not published"))?;
    let collection: Collection = crate::db::schema::collections::table
        .find(collection_id)
        .first(&mut conn)?;
    let rows: Vec<Image> = repository::get_images_in_collection(&mut conn, collection_id)?;

    let visibility: Visibility = published
        .visibility
        .parse()
        .map_err(|e| format!("publish {} visibility: {e}", published.id))?;
    let private = visibility.is_private();
    if private && signer.public_url.is_none() {
        return Err(SignError::Other(format!(
            "{PUBLIC_URL_ENV} must be set to publish a {visibility} collection (the stub names this host)"
        )));
    }

    let now = Utc::now();
    let now_naive = now.naive_utc();
    let volume = tenancy::volume_name(user_id);
    let image_nsid = Nsid::new(IMAGE_NSID).expect("static NSID");
    let collection_nsid = Nsid::new(COLLECTION_NSID).expect("static NSID");

    let mut signed_images: Vec<Signed> = Vec::with_capacity(rows.len());
    let mut refs: Vec<StrongRef> = Vec::with_capacity(rows.len());
    let mut skipped = 0usize;
    for image in &rows {
        let (Some(blob_id), Some(hfs_path)) = (
            image.blob_id.as_deref(),
            crate::commands::hoardfs::resolve_hfs_path(image),
        ) else {
            log::info!(
                "signed publish: image {} has no HoardFS asset yet — left out of {}",
                image.id,
                published.slug
            );
            skipped += 1;
            continue;
        };
        let preview = variant_digest(
            &mut conn,
            hoardfs,
            &rt,
            &volume,
            &hfs_path,
            blob_id,
            Quality::Preview,
        )?
        .blob_ref()?;
        let thumbnail = variant_digest(
            &mut conn,
            hoardfs,
            &rt,
            &volume,
            &hfs_path,
            blob_id,
            Quality::Thumbnail,
        )?
        .blob_ref()?;

        let rkey = match image.rkey.as_deref() {
            Some(r) => Rkey::new(r).map_err(|e| e.to_string())?,
            None => {
                let r = Rkey::tid();
                diesel::update(images::table.find(&image.id))
                    .set(images::rkey.eq(Some(r.as_str())))
                    .execute(&mut conn)?;
                r
            }
        };
        let uri = AtUri::new(did.clone(), image_nsid.clone(), rkey).map_err(|e| e.to_string())?;
        let body = image_body(
            &manifest::manifest_image_from_row(image),
            preview,
            thumbnail,
        );
        // An image also carried by a public/unlisted publish stays public:
        // its bytes are, so hiding its record would only break that gallery.
        let image_private = private && !publish::image_in_public_collection(&mut conn, image)?;
        let signed = sign_and_store(
            signer,
            uri,
            body,
            collection_id,
            user_id,
            now_naive,
            image_private,
        )?;
        refs.push(StrongRef {
            uri: signed.row.uri.clone(),
            cid: signed.row.cid.clone(),
        });
        signed_images.push(signed);
    }

    let collection_uri = AtUri::new(
        did.clone(),
        collection_nsid,
        Rkey::new(&published.slug).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let body = collection_body(&collection, &published, refs, now);
    let signed_collection = sign_and_store(
        signer,
        collection_uri.clone(),
        body,
        collection_id,
        user_id,
        now_naive,
        private,
    )?;

    // The public stand-in for a private collection: same rkey, public
    // collection `sh.kenning.private.stub`, pointing at this host.
    let stub = if private {
        let host = signer.public_url.as_deref().expect("checked above");
        let subject_cid: Cid = signed_collection
            .row
            .cid
            .parse()
            .map_err(|e| format!("collection cid: {e}"))?;
        let stub_uri = AtUri::new(
            did.clone(),
            StubRecord::nsid(),
            Rkey::new(&published.slug).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        let body = StubRecord::new(collection_uri, &subject_cid, host, visibility.clone());
        Some(sign_and_store(
            signer,
            stub_uri,
            body,
            collection_id,
            user_id,
            now_naive,
            false,
        )?)
    } else {
        None
    };

    let result = SignedPublish {
        uri: signed_collection.row.uri.clone(),
        cid: signed_collection.row.cid.clone(),
        image_count: signed_images.len(),
        skipped_images: skipped,
    };

    conn.transaction::<_, diesel::result::Error, _>(|conn| {
        // Prune records of images no longer in the collection (and the old
        // collection record if its slug changed), then upsert the new set.
        let keep: Vec<&str> = signed_images
            .iter()
            .chain(std::iter::once(&signed_collection))
            .chain(stub.iter())
            .map(|s| s.row.uri.as_str())
            .collect();
        diesel::delete(
            published_records::table
                .filter(published_records::collection_id.eq(collection_id))
                .filter(published_records::uri.ne_all(&keep)),
        )
        .execute(conn)?;
        for s in signed_images
            .iter()
            .chain(std::iter::once(&signed_collection))
            .chain(stub.iter())
        {
            diesel::replace_into(published_records::table)
                .values(&s.row)
                .execute(conn)?;
        }
        Ok(())
    })?;

    log::info!(
        "signed publish: {} ({} images, {} skipped{}) cid {}",
        result.uri,
        result.image_count,
        result.skipped_images,
        if private { ", private + stub" } else { "" },
        result.cid
    );
    Ok(Some(result))
}

/// Re-sign every published collection (of this user) that contains the
/// image — the asset-upload and sync paths call this so records follow the
/// bytes. Best-effort per collection: a failure is logged and skipped.
pub fn resign_collections_with_image(
    db: &DbPool,
    hoardfs: &Arc<Mutex<hoardfs_volume::HoardFs>>,
    signer: &Signer,
    user_id: &str,
    image_id: &str,
) -> Result<usize, String> {
    use crate::db::schema::collection_images;
    let mut conn = db.get().map_err(|e| e.to_string())?;
    let member_of = collection_images::table
        .filter(collection_images::image_id.eq(image_id))
        .select(collection_images::collection_id);
    let targets: Vec<String> = published_collections::table
        .filter(published_collections::user_id.eq(user_id))
        .filter(published_collections::collection_id.eq_any(member_of))
        .select(published_collections::collection_id)
        .load(&mut conn)
        .map_err(|e| e.to_string())?;
    drop(conn);
    let mut n = 0;
    for collection_id in targets {
        match publish_signed(db, hoardfs, signer, user_id, &collection_id) {
            Ok(Some(_)) => n += 1,
            Ok(None) => {}
            Err(e) => log::warn!("re-sign of collection {collection_id} failed: {e}"),
        }
    }
    Ok(n)
}

// ---------------------------------------------------------------------------
// Stored-record reads (what the public routes serve)
// ---------------------------------------------------------------------------

/// The stored collection record for a published collection, if signed.
pub fn stored_collection_record(
    conn: &mut SqliteConnection,
    collection_id: &str,
) -> QueryResult<Option<PublishedRecord>> {
    published_records::table
        .filter(published_records::collection_id.eq(collection_id))
        .filter(published_records::collection.eq(COLLECTION_NSID))
        .first(conn)
        .optional()
}

/// A stored record by owner + NSID + rkey (the `records/{rkey}` and
/// handle-based `getRecord` lookups).
pub fn stored_record(
    conn: &mut SqliteConnection,
    user_id: &str,
    collection: &str,
    rkey: &str,
) -> QueryResult<Option<PublishedRecord>> {
    published_records::table
        .filter(published_records::user_id.eq(user_id))
        .filter(published_records::collection.eq(collection))
        .filter(published_records::rkey.eq(rkey))
        .first(conn)
        .optional()
}

/// A stored record by its full `at://` URI (DID-based `getRecord`).
pub fn stored_record_by_uri(
    conn: &mut SqliteConnection,
    uri: &str,
) -> QueryResult<Option<PublishedRecord>> {
    published_records::table.find(uri).first(conn).optional()
}

/// Who may read a stored record. Public rows (`private = 0`, including
/// every stub) → anyone. A private collection record follows its publish
/// record; a private image record is readable by anyone allowed for *any*
/// circle collection of the owner containing the image (the image record
/// is the same bytes whichever gallery it is reached through).
pub fn access_for_record(
    conn: &mut SqliteConnection,
    record: &PublishedRecord,
) -> Result<Access, String> {
    if !record.private {
        return Ok(Access::Public);
    }
    match record.collection.as_str() {
        COLLECTION_NSID => {
            let published: Option<PublishedCollection> = published_collections::table
                .filter(published_collections::collection_id.eq(&record.collection_id))
                .filter(published_collections::user_id.eq(&record.user_id))
                .first(conn)
                .optional()
                .map_err(|e| e.to_string())?;
            match published {
                Some(p) => publish::access_for_published(conn, &p),
                None => Ok(Access::Circles(Vec::new())),
            }
        }
        IMAGE_NSID => {
            let image: Option<Image> = images::table
                .filter(images::user_id.eq(&record.user_id))
                .filter(images::rkey.eq(&record.rkey))
                .first(conn)
                .optional()
                .map_err(|e| e.to_string())?;
            match image {
                Some(image) => publish::access_for_image(conn, &image),
                None => Ok(Access::Circles(Vec::new())),
            }
        }
        // Unknown private NSID: nobody.
        _ => Ok(Access::Circles(Vec::new())),
    }
}

/// `{ "collection": <SignedRecord>, "images": [<SignedRecord>, ...] }` with
/// every member spliced in as its stored bytes (never re-serialized), in
/// the collection record's `images[]` order. Images whose record is
/// missing are skipped.
pub fn bundle_json(
    conn: &mut SqliteConnection,
    collection_record: &PublishedRecord,
) -> Result<String, String> {
    let value: serde_json::Value =
        serde_json::from_str(&collection_record.signed_json).map_err(|e| e.to_string())?;
    let uris: Vec<&str> = value
        .pointer("/record/images")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|r| r.get("uri").and_then(|u| u.as_str()))
                .collect()
        })
        .unwrap_or_default();
    let mut out = String::with_capacity(collection_record.signed_json.len() * (uris.len() + 2));
    out.push_str("{\"collection\":");
    out.push_str(&collection_record.signed_json);
    out.push_str(",\"images\":[");
    let mut first = true;
    for uri in uris {
        if let Some(row) = stored_record_by_uri(conn, uri).map_err(|e| e.to_string())? {
            if !first {
                out.push(',');
            }
            first = false;
            out.push_str(&row.signed_json);
        }
    }
    out.push_str("]}");
    Ok(out)
}

/// Drop every stored record of a collection (unpublish).
pub fn delete_records_for_collection(
    conn: &mut SqliteConnection,
    collection_id: &str,
) -> QueryResult<usize> {
    diesel::delete(
        published_records::table.filter(published_records::collection_id.eq(collection_id)),
    )
    .execute(conn)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::OnceLock;

    const DID: &str = "did:plc:z72i7hdynmk6r22z27h6tvur";

    fn registry() -> &'static LexiconRegistry {
        static REG: OnceLock<LexiconRegistry> = OnceLock::new();
        REG.get_or_init(|| {
            LexiconRegistry::from_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../lexicons"))
                .expect("lexicons load")
        })
    }

    fn blob(mime: &str, size: u64) -> BlobRef {
        let (cid, _) = raw_cid(&[1, 2, 3]);
        BlobRef::new(cid, mime, size)
    }

    fn sample_image() -> ManifestImage {
        ManifestImage {
            id: "img-1".into(),
            filename: "m42.jpg".into(),
            summary: Some("M42 and the Running Man".into()),
            content_type: "image/jpeg".into(),
            image_path: "images/img-1.jpg".into(),
            thumb_path: "thumbs/img-1.jpg".into(),
            created_at: "2026-01-15 20:00:00".into(),
            favorite: true,
            catalog_ids: vec!["M42".into(), "NGC1976".into()],
            plate_solve: Some(ManifestPlateSolve {
                center_ra: 83.822,
                center_dec: -5.391,
                pixel_scale: 1.5,
                rotation: 0.5,
                width_deg: 1.2,
                height_deg: 0.8,
                image_width: Some(4096),
                image_height: Some(2160),
            }),
            objects: vec![
                ManifestObject {
                    name: "M 42".into(),
                    ra: 83.822,
                    dec: -5.391,
                    magnitude: Some(4.0),
                    size_arcmin: Some(85.0),
                    pixel_x: Some(2048.4),
                    pixel_y: Some(1079.6),
                    radius_px: Some(500.0),
                },
                ManifestObject {
                    name: "NGC 1977".into(),
                    ra: 83.8458,
                    dec: -4.8125,
                    magnitude: None,
                    size_arcmin: Some(20.0),
                    pixel_x: Some(2030.0),
                    pixel_y: Some(-12.0),
                    radius_px: Some(118.2),
                },
            ],
        }
    }

    #[test]
    fn encodings_match_the_readme_table() {
        assert_eq!(micro_deg(83.822), 83_822_000);
        assert_eq!(milli(1.2), 1200);
        assert_eq!(milli(1.5), 1500);
        assert_eq!(milli(-1.46), -1460);
        assert_eq!(arcsec_tenths(85.0), 51_000);
        assert_eq!(px(2048.4), 2048);
        assert_eq!(px(2048.5), 2049);
        assert_eq!(ra_micro_deg(-0.0001), 359_999_900);
        assert_eq!(ra_micro_deg(360.0), 0);
    }

    #[test]
    fn datetimes_are_rfc3339_utc_millis() {
        assert_eq!(datetime_str("2026-01-01"), "2026-01-01T00:00:00.000Z");
        assert_eq!(
            datetime_str("2026-01-15 20:00:00"),
            "2026-01-15T20:00:00.000Z"
        );
        assert_eq!(
            datetime_str("2026-01-15 20:00:00.123456"),
            "2026-01-15T20:00:00.123Z"
        );
        assert_eq!(
            datetime_str("2026-01-20T03:12:45.117Z"),
            "2026-01-20T03:12:45.117Z"
        );
        assert_eq!(
            datetime_str("2026-01-20T04:12:45+01:00"),
            "2026-01-20T03:12:45.000Z"
        );
        let naive = chrono::NaiveDate::from_ymd_opt(2026, 1, 15)
            .unwrap()
            .and_hms_opt(20, 0, 0)
            .unwrap();
        assert_eq!(naive_datetime(naive), "2026-01-15T20:00:00.000Z");
    }

    #[test]
    fn image_body_mirrors_manifest_and_validates() {
        let body = image_body(
            &sample_image(),
            blob("image/jpeg", 338_807),
            blob("image/jpeg", 24_120),
        );
        let json = serde_json::to_value(&body).unwrap();
        assert_eq!(json["$type"], IMAGE_NSID);
        assert_eq!(json["createdAt"], "2026-01-15T20:00:00.000Z");
        assert_eq!(json["plateSolve"]["centerRaMicroDeg"], 83_822_000);
        assert_eq!(json["plateSolve"]["centerDecMicroDeg"], -5_391_000);
        assert_eq!(json["plateSolve"]["pixelScaleMilliArcsec"], 1500);
        assert_eq!(json["plateSolve"]["imageWidth"], 4096);
        assert_eq!(json["objects"][0]["magnitudeMilli"], 4000);
        assert_eq!(json["objects"][0]["sizeArcsecTenths"], 51_000);
        assert_eq!(json["objects"][0]["pixelX"], 2048);
        assert_eq!(json["objects"][1]["pixelY"], -12);
        assert!(json["objects"][1].get("magnitudeMilli").is_none());
        assert_eq!(json["preview"]["$type"], "blob");
        assert!(json["preview"]["ref"]["$link"]
            .as_str()
            .unwrap()
            .starts_with("bafkrei"));
        // No nulls anywhere: optionals are omitted.
        assert!(!serde_json::to_string(&body).unwrap().contains("null"));

        let uri: AtUri = format!("at://{DID}/{IMAGE_NSID}/3myx7vphq3s2j")
            .parse()
            .unwrap();
        let record = Record::new(uri, body.clone()).unwrap();
        registry().validate_record(&record).unwrap();

        // Round trip through serde keeps the body identical.
        let back: ImageBody = serde_json::from_value(json).unwrap();
        assert_eq!(back, body);
    }

    #[test]
    fn image_without_solve_or_summary_validates() {
        let mut img = sample_image();
        img.summary = None;
        img.plate_solve = None;
        img.objects.clear();
        img.catalog_ids.clear();
        img.created_at = "2026-01-16T21:30:00Z".into();
        let body = image_body(&img, blob("image/jpeg", 1), blob("image/jpeg", 1));
        let json = serde_json::to_value(&body).unwrap();
        assert!(json.get("summary").is_none());
        assert!(json.get("plateSolve").is_none());
        assert_eq!(json["objects"], serde_json::json!([]));
        let uri: AtUri = format!("at://{DID}/{IMAGE_NSID}/3myx7vphq3s2k")
            .parse()
            .unwrap();
        registry()
            .validate_record(&Record::new(uri, body).unwrap())
            .unwrap();
    }

    #[test]
    fn collection_body_widens_dates_and_refs_images() {
        let now = chrono::NaiveDate::from_ymd_opt(2026, 1, 10)
            .unwrap()
            .and_hms_opt(18, 0, 0)
            .unwrap();
        let collection = Collection {
            id: "c1".into(),
            user_id: "alice".into(),
            name: "Orion Session".into(),
            description: Some("Winter imaging".into()),
            visibility: "private".into(),
            template: None,
            favorite: false,
            tags: None,
            metadata: Some(r#"{"dateFilter":{"start":"2026-01-01","end":"2026-01-31"}}"#.into()),
            created_at: now,
            updated_at: now,
            archived: false,
        };
        let published = PublishedCollection {
            id: "p1".into(),
            collection_id: "c1".into(),
            user_id: "alice".into(),
            slug: "orion-session".into(),
            title: "Orion Session".into(),
            visibility: "unlisted".into(),
            published_at: now,
            updated_at: now,
            view_count: 0,
        };
        let refs = vec![StrongRef {
            uri: format!("at://{DID}/{IMAGE_NSID}/3myx7vphq3s2j"),
            cid: "bafyreibaaieigry2etw7p6k74hvdz53i5x6myssdqhlcaoyd3edalgiuzm".into(),
        }];
        let body = collection_body(&collection, &published, refs.clone(), Utc::now());
        let json = serde_json::to_value(&body).unwrap();
        assert_eq!(json["createdAt"], "2026-01-10T18:00:00.000Z");
        assert_eq!(json["dateRangeStart"], "2026-01-01T00:00:00.000Z");
        assert_eq!(json["dateRangeEnd"], "2026-01-31T00:00:00.000Z");
        assert_eq!(json["visibility"], "unlisted");
        assert!(json.get("template").is_none());
        assert_eq!(json["coverImage"]["uri"], refs[0].uri);
        assert!(json["updatedAt"].as_str().unwrap().ends_with('Z'));

        let uri: AtUri = format!("at://{DID}/{COLLECTION_NSID}/orion-session")
            .parse()
            .unwrap();
        registry()
            .validate_record(&Record::new(uri, body).unwrap())
            .unwrap();
    }

    #[test]
    fn raw_cid_is_cidv1_raw_sha256() {
        let (cid, digest) = raw_cid(b"hello");
        assert_eq!(cid.codec(), RAW_CODEC);
        assert_eq!(cid.hash().code(), SHA2_256_CODE);
        assert_eq!(cid.hash().digest(), &digest[..]);
        assert_eq!(
            hex::encode(digest),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
        assert!(cid.to_string().starts_with("bafkrei"));
    }

    #[test]
    fn signer_from_env_disabled_when_unset() {
        // Only meaningful when the test process itself has no signing
        // source configured (the var is process-global).
        if std::env::var(SIGNING_KEY_SOURCE_ENV).is_err() {
            let tmp = tempfile::tempdir().unwrap();
            assert!(Signer::from_env(tmp.path()).unwrap().is_none());
        }
    }

    #[test]
    fn signer_loads_key_from_file_source() {
        let tmp = tempfile::tempdir().unwrap();
        let key = SigningKey::generate(kenning::keys::KeyAlgo::Secp256k1);
        let key_file = tmp.path().join("astra.key");
        std::fs::write(&key_file, key.to_multibase()).unwrap();
        let source = KeySource::parse(&format!("file:{}", key_file.display())).unwrap();
        let loaded = load_signing_key(&source).unwrap();
        assert_eq!(
            loaded.verifying_key().to_did_key(),
            key.verifying_key().to_did_key()
        );
        // Lexicons resolve from the checkout when nothing is deployed.
        let dir = resolve_lexicons_dir(tmp.path()).unwrap();
        assert!(dir.join("gallery.astra.image.json").is_file());
    }
}
