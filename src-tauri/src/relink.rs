//! Re-link relocated image sources.
//!
//! The "fix" half pairing with the per-image verification scan's "detect"
//! half: when a library image's source file is no longer where the DB says
//! (mount moved, tree restructured), find the moved original and re-point
//! `url`/`fits_url` — verified, never by name alone — then update the
//! HoardFS external reference so variants and future reads follow.
//!
//! Strategies, confidence-ordered:
//! 1. Prefix remap (`--remap OLD=NEW`): bulk fix for a moved mount.
//! 2. Auto-search: walk candidate roots for the basename, disambiguating by
//!    recorded size and blake3 content hash (the image's `blob_id` IS the
//!    content hash for migrated images).
//!
//! Anything ambiguous or unfound is reported, not guessed.

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::commands::hoardfs::resolve_hfs_path;
use crate::db::models::{Image, UpdateImage};
use crate::db::repository;
use crate::db::DbPool;

/// A `--remap OLD=NEW` prefix rewrite rule.
#[derive(Debug, Clone)]
pub struct RemapRule {
    pub old_prefix: String,
    pub new_prefix: String,
}

impl RemapRule {
    /// Parse "OLD=NEW".
    pub fn parse(s: &str) -> Result<Self, String> {
        let (old, new) = s
            .split_once('=')
            .ok_or_else(|| format!("--remap expects OLD=NEW, got: {s}"))?;
        if old.is_empty() || new.is_empty() {
            return Err(format!("--remap OLD and NEW must be non-empty: {s}"));
        }
        Ok(Self {
            old_prefix: old.to_string(),
            new_prefix: new.to_string(),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RelinkField {
    Url,
    FitsUrl,
}

impl std::fmt::Display for RelinkField {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RelinkField::Url => write!(f, "url"),
            RelinkField::FitsUrl => write!(f, "fits_url"),
        }
    }
}

/// One verified, appliable relink.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposedRelink {
    pub image_id: String,
    pub filename: String,
    pub field: RelinkField,
    pub old_path: String,
    pub new_path: String,
    /// "remap" or "search"
    pub method: &'static str,
    /// How the candidate was verified, for the report
    pub verification: String,
}

/// Multiple verified candidates — refused, listed for manual action.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AmbiguousRelink {
    pub image_id: String,
    pub filename: String,
    pub field: RelinkField,
    pub old_path: String,
    pub candidates: Vec<String>,
}

/// No candidate found — the original is lost (or roots don't cover it).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LostSource {
    pub image_id: String,
    pub filename: String,
    pub field: RelinkField,
    pub old_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelinkReport {
    pub images_checked: u32,
    /// Images with at least one missing source path
    pub unreachable_images: u32,
    pub proposed: Vec<ProposedRelink>,
    pub ambiguous: Vec<AmbiguousRelink>,
    pub lost: Vec<LostSource>,
    /// DB rows rewritten (0 on dry runs)
    pub applied: u32,
    /// HoardFS external refs re-registered at the new location
    pub hoardfs_updated: u32,
    pub errors: Vec<String>,
    pub dry_run: bool,
}

#[derive(Debug, Default)]
pub struct RelinkOptions {
    pub remaps: Vec<RemapRule>,
    pub search_roots: Vec<PathBuf>,
    pub dry_run: bool,
}

/// What we know the original should look like, for candidate verification.
struct Expectation {
    size: Option<u64>,
    /// Full blob-id string, e.g. "blake3:<hex>"
    content_hash: Option<String>,
}

/// blake3-hash a file in the HoardFS blob-id string format ("blake3:<hex>").
fn hash_file(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|e| format!("open {path:?}: {e}"))?;
    let mut hasher = blake3::Hasher::new();
    std::io::copy(&mut file, &mut hasher).map_err(|e| format!("read {path:?}: {e}"))?;
    Ok(hoardfs_core::BlobId::from_hash(hasher.finalize()).to_string())
}

/// Verify a candidate against expectations. Returns a human-readable
/// description of the strongest check that passed, or None if any fails.
fn verify_candidate(path: &Path, expect: &Expectation) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    if let Some(size) = expect.size {
        if meta.len() != size {
            return None;
        }
    }
    if let Some(hash) = &expect.content_hash {
        match hash_file(path) {
            Ok(actual) if &actual == hash => return Some("content hash verified".to_string()),
            _ => return None,
        }
    }
    if expect.size.is_some() {
        Some(format!("size verified ({} bytes)", meta.len()))
    } else {
        Some("exists (no recorded size/hash)".to_string())
    }
}

/// Index every file under the given roots by basename. Walked once.
fn index_search_roots(roots: &[PathBuf]) -> HashMap<String, Vec<PathBuf>> {
    let mut index: HashMap<String, Vec<PathBuf>> = HashMap::new();
    for root in roots {
        for entry in walkdir::WalkDir::new(root)
            .follow_links(true)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            if !entry.path().is_file() {
                continue;
            }
            if let Some(name) = entry.file_name().to_str() {
                index
                    .entry(name.to_string())
                    .or_default()
                    .push(entry.path().to_path_buf());
            }
        }
    }
    index
}

/// What HoardFS recorded for a migrated image's registered source.
fn hoardfs_expectation(
    hoardfs: Option<&Arc<Mutex<hoardfs_volume::HoardFs>>>,
    image: &Image,
) -> Expectation {
    let mut expect = Expectation {
        size: None,
        // For migrated images the blob id IS the content hash.
        content_hash: image.blob_id.clone(),
    };
    if let (Some(hfs_arc), Some(hfs_path)) = (hoardfs, resolve_hfs_path(image)) {
        if let Ok(hfs) = hfs_arc.lock() {
            if let Ok(info) = hfs.get_file_info("default", &hfs_path) {
                expect.size = info.current_version.external_size;
            }
        }
    }
    expect
}

/// Find and (unless dry-run) apply relinks for every image whose recorded
/// source paths no longer exist. Sync + blocking.
pub fn relink_library_core(
    db: &DbPool,
    hoardfs: Option<&Arc<Mutex<hoardfs_volume::HoardFs>>>,
    user_id: &str,
    options: &RelinkOptions,
    mut on_progress: impl FnMut(u32, u32, &str),
) -> Result<RelinkReport, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;
    let images = repository::get_images_by_user(&mut conn, user_id).map_err(|e| e.to_string())?;
    drop(conn);

    let mut report = RelinkReport {
        images_checked: images.len() as u32,
        unreachable_images: 0,
        proposed: Vec::new(),
        ambiguous: Vec::new(),
        lost: Vec::new(),
        applied: 0,
        hoardfs_updated: 0,
        errors: Vec::new(),
        dry_run: options.dry_run,
    };

    // Basename index over the search roots, built lazily on first need.
    let mut search_index: Option<HashMap<String, Vec<PathBuf>>> = None;

    let total = images.len() as u32;
    for (idx, image) in images.iter().enumerate() {
        on_progress(idx as u32 + 1, total, &image.filename);

        // The registered source is fits_url when present (migration prefers
        // it); expectations only apply to that field.
        let primary_field = if image.fits_url.is_some() {
            RelinkField::FitsUrl
        } else {
            RelinkField::Url
        };

        let missing: Vec<(RelinkField, String)> = [
            (RelinkField::Url, image.url.clone()),
            (RelinkField::FitsUrl, image.fits_url.clone()),
        ]
        .into_iter()
        .filter_map(|(field, path)| path.map(|p| (field, p)))
        .filter(|(_, p)| !Path::new(p).exists())
        .collect();

        if missing.is_empty() {
            continue;
        }
        report.unreachable_images += 1;

        let mut updates = UpdateImage::default();
        let mut primary_relinked: Option<String> = None;

        for (field, old_path) in missing {
            let expect = if field == primary_field {
                hoardfs_expectation(hoardfs, image)
            } else {
                // Secondary fields (e.g. a preview JPEG alongside the FITS)
                // were never registered — existence is all we can check.
                Expectation {
                    size: None,
                    content_hash: None,
                }
            };

            // Strategy 1: prefix remap.
            let remapped = options.remaps.iter().find_map(|rule| {
                let rest = old_path.strip_prefix(&rule.old_prefix)?;
                let candidate = format!("{}{}", rule.new_prefix, rest);
                verify_candidate(Path::new(&candidate), &expect)
                    .map(|verification| (candidate, verification))
            });

            let resolved = if let Some((new_path, verification)) = remapped {
                Some((new_path, "remap", verification))
            } else if !options.search_roots.is_empty() {
                // Strategy 2: auto-search by basename, verified.
                let index = search_index
                    .get_or_insert_with(|| index_search_roots(&options.search_roots));
                let basename = Path::new(&old_path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("");
                let mut verified: Vec<(String, String)> = index
                    .get(basename)
                    .map(|candidates| {
                        candidates
                            .iter()
                            .filter_map(|c| {
                                verify_candidate(c, &expect).map(|v| {
                                    (c.to_string_lossy().to_string(), v)
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                verified.sort();

                if expect.content_hash.is_some() && verified.len() > 1 {
                    // Hash-verified duplicates are byte-identical copies —
                    // any is correct; take the lexicographically first.
                    verified.truncate(1);
                    verified[0].1 =
                        "content hash verified (identical copies exist)".to_string();
                }

                match verified.len() {
                    0 => None,
                    1 => {
                        let (new_path, verification) = verified.remove(0);
                        Some((new_path, "search", verification))
                    }
                    _ => {
                        report.ambiguous.push(AmbiguousRelink {
                            image_id: image.id.clone(),
                            filename: image.filename.clone(),
                            field,
                            old_path: old_path.clone(),
                            candidates: verified.into_iter().map(|(p, _)| p).collect(),
                        });
                        continue;
                    }
                }
            } else {
                None
            };

            match resolved {
                Some((new_path, method, verification)) => {
                    report.proposed.push(ProposedRelink {
                        image_id: image.id.clone(),
                        filename: image.filename.clone(),
                        field,
                        old_path: old_path.clone(),
                        new_path: new_path.clone(),
                        method,
                        verification,
                    });
                    match field {
                        RelinkField::Url => updates.url = Some(new_path.clone()),
                        RelinkField::FitsUrl => updates.fits_url = Some(new_path.clone()),
                    }
                    if field == primary_field {
                        primary_relinked = Some(new_path);
                    }
                }
                None => {
                    report.lost.push(LostSource {
                        image_id: image.id.clone(),
                        filename: image.filename.clone(),
                        field,
                        old_path: old_path.clone(),
                    });
                }
            }
        }

        if options.dry_run {
            continue;
        }
        if updates.url.is_none() && updates.fits_url.is_none() {
            continue;
        }

        // Apply: rewrite the DB row.
        let mut conn = db.get().map_err(|e| e.to_string())?;
        if let Err(e) = repository::update_image(&mut conn, &image.id, &updates) {
            report.errors.push(format!("{}: DB update failed: {e}", image.filename));
            continue;
        }
        report.applied += 1;
        drop(conn);

        // Update the HoardFS external ref for migrated images whose
        // registered source moved. Content was hash-verified, so the blob
        // (and its cached variants) are unchanged.
        if let (Some(new_path), Some(hfs_arc), true) =
            (primary_relinked, hoardfs, image.blob_id.is_some())
        {
            let Some(hfs_path) = resolve_hfs_path(image) else {
                continue;
            };
            let result = (|| {
                let hfs = hfs_arc.lock().map_err(|e| format!("Lock: {e}"))?;
                hfs.relocate_external("default", &hfs_path, &new_path)
                    .map_err(|e| format!("{e}"))
            })();
            match result {
                Ok(()) => report.hoardfs_updated += 1,
                Err(e) => report.errors.push(format!(
                    "{}: HoardFS external-ref update failed: {e}",
                    image.filename
                )),
            }
        }
    }

    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::images::{create_image_core, CreateImageInput};
    use crate::db::test_support::{insert_user, test_pool};
    use tempfile::TempDir;

    fn make_image(db: &DbPool, user_id: &str, filename: &str, url: Option<String>) -> String {
        let image = create_image_core(
            db,
            user_id,
            CreateImageInput {
                collection_id: None,
                filename: filename.to_string(),
                url,
                summary: None,
                description: None,
                content_type: None,
                tags: None,
                visibility: None,
                location: None,
                annotations: None,
                metadata: None,
                thumbnail: None,
            },
        )
        .unwrap();
        image.id
    }

    fn get_image(db: &DbPool, id: &str) -> Image {
        let mut conn = db.get().unwrap();
        repository::get_image_by_id(&mut conn, id).unwrap().unwrap()
    }

    #[test]
    fn remap_rule_parsing() {
        let rule = RemapRule::parse("/mnt/asiair=/mnt/mouseion/astronomy/ASIAir").unwrap();
        assert_eq!(rule.old_prefix, "/mnt/asiair");
        assert_eq!(rule.new_prefix, "/mnt/mouseion/astronomy/ASIAir");
        assert!(RemapRule::parse("no-equals").is_err());
        assert!(RemapRule::parse("=/x").is_err());
    }

    #[test]
    fn prefix_remap_relinks_and_dry_run_never_writes() {
        let pool = test_pool();
        insert_user(&pool, "u1");
        let tmp = TempDir::new().unwrap();

        // The file now lives under new/, DB still points at old/.
        let new_dir = tmp.path().join("new/Live/M31");
        std::fs::create_dir_all(&new_dir).unwrap();
        std::fs::write(new_dir.join("stack.fits"), b"data").unwrap();
        let old_path = tmp.path().join("old/Live/M31/stack.fits");

        let id = make_image(
            &pool,
            "u1",
            "stack.fits",
            Some(old_path.to_string_lossy().to_string()),
        );

        let options = RelinkOptions {
            remaps: vec![RemapRule {
                old_prefix: tmp.path().join("old").to_string_lossy().to_string(),
                new_prefix: tmp.path().join("new").to_string_lossy().to_string(),
            }],
            search_roots: vec![],
            dry_run: true,
        };

        // Dry run: proposes, never writes.
        let report =
            relink_library_core(&pool, None, "u1", &options, |_, _, _| {}).unwrap();
        assert_eq!(report.unreachable_images, 1);
        assert_eq!(report.proposed.len(), 1);
        assert_eq!(report.proposed[0].method, "remap");
        assert_eq!(report.applied, 0);
        assert_eq!(
            get_image(&pool, &id).url.unwrap(),
            old_path.to_string_lossy()
        );

        // Wet run: applies.
        let options = RelinkOptions {
            dry_run: false,
            ..options
        };
        let report =
            relink_library_core(&pool, None, "u1", &options, |_, _, _| {}).unwrap();
        assert_eq!(report.applied, 1);
        let relinked = get_image(&pool, &id).url.unwrap();
        assert!(relinked.ends_with("new/Live/M31/stack.fits"));

        // Idempotent: nothing unreachable on a re-run.
        let report =
            relink_library_core(&pool, None, "u1", &options, |_, _, _| {}).unwrap();
        assert_eq!(report.unreachable_images, 0);
        assert_eq!(report.applied, 0);
    }

    #[test]
    fn auto_search_refuses_ambiguity_without_verification() {
        let pool = test_pool();
        insert_user(&pool, "u1");
        let tmp = TempDir::new().unwrap();

        // Two same-named files in different target dirs — the Seestar case.
        for target in ["M31", "M42"] {
            let dir = tmp.path().join("nas").join(target);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("Stack_16bits.fits"), target.as_bytes()).unwrap();
        }

        make_image(
            &pool,
            "u1",
            "Stack_16bits.fits",
            Some(tmp.path().join("gone/Stack_16bits.fits").to_string_lossy().to_string()),
        );

        let options = RelinkOptions {
            remaps: vec![],
            search_roots: vec![tmp.path().join("nas")],
            dry_run: false,
        };
        let report =
            relink_library_core(&pool, None, "u1", &options, |_, _, _| {}).unwrap();
        assert!(report.proposed.is_empty());
        assert_eq!(report.ambiguous.len(), 1);
        assert_eq!(report.ambiguous[0].candidates.len(), 2);
        assert_eq!(report.applied, 0);
    }

    #[test]
    fn auto_search_single_match_relinks_and_lost_is_reported() {
        let pool = test_pool();
        insert_user(&pool, "u1");
        let tmp = TempDir::new().unwrap();

        let dir = tmp.path().join("nas/M42");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("unique.fits"), b"x").unwrap();

        let found = make_image(
            &pool,
            "u1",
            "unique.fits",
            Some(tmp.path().join("gone/unique.fits").to_string_lossy().to_string()),
        );
        make_image(
            &pool,
            "u1",
            "vanished.fits",
            Some(tmp.path().join("gone/vanished.fits").to_string_lossy().to_string()),
        );

        let options = RelinkOptions {
            remaps: vec![],
            search_roots: vec![tmp.path().join("nas")],
            dry_run: false,
        };
        let report =
            relink_library_core(&pool, None, "u1", &options, |_, _, _| {}).unwrap();
        assert_eq!(report.proposed.len(), 1);
        assert_eq!(report.proposed[0].method, "search");
        assert_eq!(report.lost.len(), 1);
        assert_eq!(report.lost[0].filename, "vanished.fits");
        assert_eq!(report.applied, 1);
        assert!(get_image(&pool, &found)
            .url
            .unwrap()
            .ends_with("nas/M42/unique.fits"));
    }

    #[test]
    fn content_hash_disambiguates_same_named_stacks() {
        let pool = test_pool();
        insert_user(&pool, "u1");
        let tmp = TempDir::new().unwrap();

        // Real HoardFS volume so the image has a blob_id (= content hash).
        let rt = tokio::runtime::Runtime::new().unwrap();
        let hfs = rt
            .block_on(hoardfs_volume::HoardFs::init(&tmp.path().join("hoardfs")))
            .unwrap();

        // Register the original at its old location.
        let old_dir = tmp.path().join("atlas/SharpCap/M31");
        std::fs::create_dir_all(&old_dir).unwrap();
        let old_path = old_dir.join("Stack_16bits.fits");
        std::fs::write(&old_path, b"the real M31 stack").unwrap();
        let external = hoardfs_core::ExternalRef {
            location: old_path.to_string_lossy().to_string(),
            location_type: hoardfs_core::ExternalLocationType::FilesystemPath,
            size: 18,
            content_hash: None,
        };
        rt.block_on(hfs.register_external("default", "/2026-06/stack.fits", &external, false))
            .unwrap();
        let blob_id = hfs
            .get_file_info("default", "/2026-06/stack.fits")
            .unwrap()
            .current_version
            .blob_id
            .clone();
        let hoardfs = Arc::new(Mutex::new(hfs));

        let id = make_image(
            &pool,
            "u1",
            "Stack_16bits.fits",
            Some(old_path.to_string_lossy().to_string()),
        );
        {
            let mut conn = pool.get().unwrap();
            repository::update_image(
                &mut conn,
                &id,
                &UpdateImage {
                    blob_id: Some(blob_id),
                    metadata: Some(
                        serde_json::json!({
                            "hoardfs": { "hfs_path": "/2026-06/stack.fits" }
                        })
                        .to_string(),
                    ),
                    ..Default::default()
                },
            )
            .unwrap();
        }

        // The tree gets restructured: same content moves to the NAS, and a
        // same-named DIFFERENT stack exists for another target.
        let nas_m31 = tmp.path().join("nas/imager/sharpcap/M31");
        let nas_m42 = tmp.path().join("nas/imager/sharpcap/M42");
        std::fs::create_dir_all(&nas_m31).unwrap();
        std::fs::create_dir_all(&nas_m42).unwrap();
        std::fs::rename(&old_path, nas_m31.join("Stack_16bits.fits")).unwrap();
        std::fs::write(nas_m42.join("Stack_16bits.fits"), b"a different target").unwrap();

        let options = RelinkOptions {
            remaps: vec![],
            search_roots: vec![tmp.path().join("nas")],
            dry_run: false,
        };
        let report =
            relink_library_core(&pool, Some(&hoardfs), "u1", &options, |_, _, _| {}).unwrap();

        // Name collides, but the hash picks the true copy — never ambiguous.
        assert_eq!(report.ambiguous.len(), 0, "errors: {:?}", report.errors);
        assert_eq!(report.proposed.len(), 1);
        assert!(report.proposed[0].verification.contains("hash"));
        assert!(report.proposed[0].new_path.contains("M31"));
        assert_eq!(report.applied, 1);
        assert_eq!(report.hoardfs_updated, 1);

        // HoardFS now points at the new location too.
        let hfs = hoardfs.lock().unwrap();
        let info = hfs.get_file_info("default", "/2026-06/stack.fits").unwrap();
        assert!(info
            .current_version
            .external_location
            .unwrap()
            .contains("nas/imager/sharpcap/M31"));
    }
}
