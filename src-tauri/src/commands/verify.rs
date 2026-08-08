//! Per-image library verification: source reachable, size undrifted,
//! HoardFS variant cache intact.
//!
//! The ongoing companion to the one-shot post-migration check in
//! `hoardfs::verify_variants_core`: this walks every image, every time,
//! and reports per-image findings the Admin UI can act on. Detection only —
//! the fix half (relinking moved sources) is the re-link tooling.

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

use crate::commands::hoardfs::resolve_hfs_path;
use crate::db::repository;
use crate::db::DbPool;
use crate::state::AppState;

static VERIFY_CANCELLED: AtomicBool = AtomicBool::new(false);

const VERIFY_EMIT_INTERVAL: u32 = 25;

/// One flagged image with the reason it was flagged.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlaggedImage {
    pub image_id: String,
    pub filename: String,
    /// The source path the finding refers to, when one exists
    pub path: Option<String>,
    pub detail: String,
}

/// Grouped result of a full library verification pass.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationReport {
    pub total: u32,
    pub ok_count: u32,
    /// Source file missing on disk (mount offline, file moved/deleted)
    pub unreachable: Vec<FlaggedImage>,
    /// Source file exists but its size no longer matches what HoardFS recorded
    pub drifted: Vec<FlaggedImage>,
    /// Migrated image whose HoardFS thumbnail variant doesn't resolve
    pub variants_missing: Vec<FlaggedImage>,
    pub cancelled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VerifyProgressEvent {
    checked: u32,
    total: u32,
    current_file: String,
    unreachable: usize,
    drifted: usize,
    variants_missing: usize,
}

/// What HoardFS knows about an image's source, when it's migrated.
struct RecordedSource {
    location: Option<String>,
    size: Option<u64>,
    has_thumbnail_variant: Option<bool>,
    lookup_error: Option<String>,
}

/// Query HoardFS for the external location, recorded size, and thumbnail
/// variant of a migrated image. Sync — callers hold no lock.
fn recorded_source(
    hoardfs: &Arc<Mutex<hoardfs_volume::HoardFs>>,
    hfs_path: &str,
) -> RecordedSource {
    let hfs = match hoardfs.lock() {
        Ok(h) => h,
        Err(e) => {
            return RecordedSource {
                location: None,
                size: None,
                has_thumbnail_variant: None,
                lookup_error: Some(format!("lock poisoned: {e}")),
            }
        }
    };

    let (location, size, mut lookup_error) = match hfs.get_file_info("default", hfs_path) {
        Ok(info) => (
            info.current_version.external_location,
            info.current_version.external_size,
            None,
        ),
        Err(e) => (None, None, Some(format!("get_file_info failed: {e}"))),
    };

    let has_thumbnail_variant = match hfs.list_variants("default", hfs_path) {
        Ok(variants) => Some(
            variants
                .iter()
                .any(|v| matches!(v.quality, hoardfs_core::Quality::Thumbnail)),
        ),
        Err(e) => {
            if lookup_error.is_none() {
                lookup_error = Some(format!("list_variants failed: {e}"));
            }
            None
        }
    };

    RecordedSource {
        location,
        size,
        has_thumbnail_variant,
        lookup_error,
    }
}

/// Walk every image of a user and verify source reachability, recorded size,
/// and HoardFS variant presence. Sync + blocking; run off the async executor.
/// `on_progress(checked, total, filename, (unreachable, drifted,
/// variants_missing))` fires after each image with running counts.
pub fn verify_library_core(
    db: &DbPool,
    hoardfs: Option<&Arc<Mutex<hoardfs_volume::HoardFs>>>,
    user_id: &str,
    mut on_progress: impl FnMut(u32, u32, &str, (usize, usize, usize)),
) -> Result<VerificationReport, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;
    let images = repository::get_images_by_user(&mut conn, user_id).map_err(|e| e.to_string())?;
    drop(conn);

    let total = images.len() as u32;
    let mut report = VerificationReport {
        total,
        ok_count: 0,
        unreachable: Vec::new(),
        drifted: Vec::new(),
        variants_missing: Vec::new(),
        cancelled: false,
    };

    for (idx, image) in images.iter().enumerate() {
        if VERIFY_CANCELLED.load(Ordering::SeqCst) {
            report.cancelled = true;
            break;
        }

        let mut flagged = false;

        // What HoardFS recorded for this image, if it's migrated.
        let recorded = match (image.blob_id.as_ref(), hoardfs, resolve_hfs_path(image)) {
            (Some(_), Some(hfs), Some(hfs_path)) => Some(recorded_source(hfs, &hfs_path)),
            _ => None,
        };

        // The source of truth for "where should the original be": HoardFS's
        // external location for migrated images, the DB row otherwise.
        let source_path: Option<String> = recorded
            .as_ref()
            .and_then(|r| r.location.clone())
            .or_else(|| image.fits_url.clone())
            .or_else(|| image.url.clone());

        // 1. Reachability
        let on_disk_size: Option<u64> = match &source_path {
            Some(p) if Path::new(p).exists() => std::fs::metadata(p).map(|m| m.len()).ok(),
            Some(p) => {
                report.unreachable.push(FlaggedImage {
                    image_id: image.id.clone(),
                    filename: image.filename.clone(),
                    path: Some(p.clone()),
                    detail: "source file missing on disk".to_string(),
                });
                flagged = true;
                None
            }
            None => {
                report.unreachable.push(FlaggedImage {
                    image_id: image.id.clone(),
                    filename: image.filename.clone(),
                    path: None,
                    detail: "no source path recorded".to_string(),
                });
                flagged = true;
                None
            }
        };

        // 2. Size drift vs what HoardFS recorded at registration
        if let (Some(actual), Some(recorded_size)) = (
            on_disk_size,
            recorded.as_ref().and_then(|r| r.size),
        ) {
            if actual != recorded_size {
                report.drifted.push(FlaggedImage {
                    image_id: image.id.clone(),
                    filename: image.filename.clone(),
                    path: source_path.clone(),
                    detail: format!(
                        "size on disk {actual} bytes != recorded {recorded_size} bytes"
                    ),
                });
                flagged = true;
            }
        }

        // 3. Variant cache integrity for migrated images
        if image.blob_id.is_some() {
            match &recorded {
                Some(r) => {
                    if let Some(err) = &r.lookup_error {
                        report.variants_missing.push(FlaggedImage {
                            image_id: image.id.clone(),
                            filename: image.filename.clone(),
                            path: source_path.clone(),
                            detail: err.clone(),
                        });
                        flagged = true;
                    } else if r.has_thumbnail_variant == Some(false) {
                        report.variants_missing.push(FlaggedImage {
                            image_id: image.id.clone(),
                            filename: image.filename.clone(),
                            path: source_path.clone(),
                            detail: "no thumbnail variant cached".to_string(),
                        });
                        flagged = true;
                    }
                }
                None if hoardfs.is_some() => {
                    report.variants_missing.push(FlaggedImage {
                        image_id: image.id.clone(),
                        filename: image.filename.clone(),
                        path: source_path.clone(),
                        detail: "blob_id set but no hoardfs.hfs_path in metadata".to_string(),
                    });
                    flagged = true;
                }
                // HoardFS unavailable — can't judge variants, don't flag.
                None => {}
            }
        }

        if !flagged {
            report.ok_count += 1;
        }

        on_progress(
            idx as u32 + 1,
            total,
            &image.filename,
            (
                report.unreachable.len(),
                report.drifted.len(),
                report.variants_missing.len(),
            ),
        );
    }

    Ok(report)
}

/// Verify every library image's source file and variant cache.
#[tauri::command]
pub async fn verify_library_sources(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<VerificationReport, String> {
    VERIFY_CANCELLED.store(false, Ordering::SeqCst);

    let db = state.db.clone();
    let hoardfs = state.hoardfs.clone();
    let user_id = state.user_id.clone();
    let progress_app = app.clone();

    let report = tokio::task::spawn_blocking(move || {
        verify_library_core(
            &db,
            hoardfs.as_ref(),
            &user_id,
            |checked, total, filename, (u, d, v)| {
                if checked % VERIFY_EMIT_INTERVAL == 0 || checked == total {
                    let _ = progress_app.emit(
                        "library-verification-progress",
                        VerifyProgressEvent {
                            checked,
                            total,
                            current_file: filename.to_string(),
                            unreachable: u,
                            drifted: d,
                            variants_missing: v,
                        },
                    );
                }
            },
        )
    })
    .await
    .map_err(|e| format!("Task panicked: {e}"))??;

    let _ = app.emit(
        "library-verification-progress",
        VerifyProgressEvent {
            checked: report.total,
            total: report.total,
            current_file: String::new(),
            unreachable: report.unreachable.len(),
            drifted: report.drifted.len(),
            variants_missing: report.variants_missing.len(),
        },
    );

    Ok(report)
}

/// Request cancellation of an in-flight library verification.
#[tauri::command]
pub fn cancel_library_verification() -> Result<(), String> {
    VERIFY_CANCELLED.store(true, Ordering::SeqCst);
    Ok(())
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

    #[test]
    fn verify_flags_unreachable_and_counts_ok() {
        let pool = test_pool();
        insert_user(&pool, "u1");
        let tmp = TempDir::new().unwrap();

        // Reachable image
        let good = tmp.path().join("good.fits");
        std::fs::write(&good, b"data").unwrap();
        make_image(
            &pool,
            "u1",
            "good.fits",
            Some(good.to_string_lossy().to_string()),
        );

        // Missing file
        make_image(
            &pool,
            "u1",
            "gone.fits",
            Some(tmp.path().join("gone.fits").to_string_lossy().to_string()),
        );

        // No source path at all
        make_image(&pool, "u1", "pathless", None);

        let report = verify_library_core(&pool, None, "u1", |_, _, _, _| {}).unwrap();
        assert_eq!(report.total, 3);
        assert_eq!(report.ok_count, 1);
        assert_eq!(report.unreachable.len(), 2);
        assert!(report.drifted.is_empty());
        assert!(report.variants_missing.is_empty());

        let details: Vec<&str> = report
            .unreachable
            .iter()
            .map(|f| f.detail.as_str())
            .collect();
        assert!(details.contains(&"source file missing on disk"));
        assert!(details.contains(&"no source path recorded"));
    }

    #[test]
    fn verify_is_tenant_scoped() {
        let pool = test_pool();
        insert_user(&pool, "u1");
        insert_user(&pool, "u2");

        make_image(&pool, "u2", "other-user.fits", Some("/nonexistent".into()));

        let report = verify_library_core(&pool, None, "u1", |_, _, _, _| {}).unwrap();
        assert_eq!(report.total, 0);
        assert!(report.unreachable.is_empty());
    }

    #[test]
    fn verify_with_hoardfs_checks_drift_and_variants() {
        let pool = test_pool();
        insert_user(&pool, "u1");
        let tmp = TempDir::new().unwrap();

        // A real HoardFS volume with one registered external file.
        let rt = tokio::runtime::Runtime::new().unwrap();
        let hfs_dir = tmp.path().join("hoardfs");
        let hfs = rt
            .block_on(hoardfs_volume::HoardFs::init(&hfs_dir))
            .unwrap();

        let source = tmp.path().join("m31.fits");
        std::fs::write(&source, vec![0u8; 128]).unwrap();
        let external = hoardfs_core::ExternalRef {
            location: source.to_string_lossy().to_string(),
            location_type: hoardfs_core::ExternalLocationType::FilesystemPath,
            size: 128,
            content_hash: None,
        };
        // No variant generation: a bare FITS blob won't produce a thumbnail
        // here, which lets the test also assert the variants_missing path.
        rt.block_on(hfs.register_external("default", "/2026-08/m31.fits", &external, false))
            .unwrap();
        let blob_id = hfs
            .get_file_info("default", "/2026-08/m31.fits")
            .unwrap()
            .current_version
            .blob_id
            .clone();
        let hoardfs = Arc::new(Mutex::new(hfs));

        let image_id = make_image(
            &pool,
            "u1",
            "m31.fits",
            Some(source.to_string_lossy().to_string()),
        );
        let mut conn = pool.get().unwrap();
        repository::update_image(
            &mut conn,
            &image_id,
            &crate::db::models::UpdateImage {
                blob_id: Some(blob_id),
                metadata: Some(
                    serde_json::json!({
                        "hoardfs": { "hfs_path": "/2026-08/m31.fits" }
                    })
                    .to_string(),
                ),
                ..Default::default()
            },
        )
        .unwrap();
        drop(conn);

        // Size matches what was registered → no drift; but no thumbnail
        // variant was generated → variants_missing.
        let report = verify_library_core(&pool, Some(&hoardfs), "u1", |_, _, _, _| {}).unwrap();
        assert_eq!(report.total, 1);
        assert!(report.unreachable.is_empty());
        assert!(report.drifted.is_empty());
        assert_eq!(report.variants_missing.len(), 1);
        assert_eq!(
            report.variants_missing[0].detail,
            "no thumbnail variant cached"
        );

        // Overwrite the source with a different size → drift flagged.
        std::fs::write(&source, vec![0u8; 999]).unwrap();
        let report = verify_library_core(&pool, Some(&hoardfs), "u1", |_, _, _, _| {}).unwrap();
        assert_eq!(report.drifted.len(), 1);
        assert!(report.drifted[0].detail.contains("999"));
        assert!(report.drifted[0].detail.contains("128"));

        // Delete the source → unreachable (drift can no longer be judged).
        std::fs::remove_file(&source).unwrap();
        let report = verify_library_core(&pool, Some(&hoardfs), "u1", |_, _, _, _| {}).unwrap();
        assert_eq!(report.unreachable.len(), 1);
        assert!(report.drifted.is_empty());
    }
}
