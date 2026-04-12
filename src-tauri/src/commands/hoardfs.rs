//! HoardFS image storage commands.
//!
//! Import, variant serving, and content-addressed storage operations.

use base64::prelude::*;
use hoardfs_core::{ExternalLocationType, ExternalRef, Quality};
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::{models::{NewCollectionImage, NewImage}, repository};
use crate::state::AppState;

/// Result of a HoardFS import operation
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HoardfsImportResult {
    pub files_scanned: u32,
    pub files_imported: u32,
    pub files_skipped: u32,
    pub errors: Vec<String>,
}

/// Progress event emitted during import
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportProgressEvent {
    current: u32,
    total: u32,
    filename: String,
    status: String,
}

/// Import images from a directory as external references in HoardFS.
///
/// Originals stay on disk (NAS, external drive, etc.) — not duplicated.
/// Each imported image gets:
/// - An external reference in HoardFS (tracks location + content hash)
/// - Locally cached thumbnail and preview variants (always available)
/// - An Astra image record with blob_id set
/// - Optional collection association
///
/// When the source is offline, thumbnails and previews are still served
/// from the local HoardFS variant cache.
#[tauri::command]
pub async fn import_images_hoardfs(
    app: AppHandle,
    state: State<'_, AppState>,
    source_dir: String,
    collection_id: Option<String>,
    session_name: Option<String>,
) -> Result<HoardfsImportResult, String> {
    let hoardfs_arc = state.hoardfs.as_ref()
        .ok_or("HoardFS is not initialized. Image storage features are unavailable.")?
        .clone();

    let source = Path::new(&source_dir);
    if !source.is_dir() {
        return Err(format!("Source directory does not exist: {}", source_dir));
    }

    // Build HoardFS path prefix from session name and date
    let date_prefix = chrono::Local::now().format("%Y-%m").to_string();
    let session = session_name.unwrap_or_else(|| {
        source.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("import")
            .to_string()
    });
    let hfs_prefix = format!("/{}/{}", date_prefix, session);

    // Scan for image files
    let valid_extensions = ["jpg", "jpeg", "png", "tiff", "tif", "fit", "fits", "webp"];
    let mut image_files: Vec<std::path::PathBuf> = Vec::new();

    for entry in walkdir::WalkDir::new(source)
        .follow_links(true)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if path.is_file() {
            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                if valid_extensions.contains(&ext.to_lowercase().as_str()) {
                    image_files.push(path.to_path_buf());
                }
            }
        }
    }

    let total = image_files.len() as u32;
    let mut result = HoardfsImportResult {
        files_scanned: total,
        files_imported: 0,
        files_skipped: 0,
        errors: Vec::new(),
    };

    if total == 0 {
        return Ok(result);
    }

    let user_id = state.user_id.clone();

    for (idx, file_path) in image_files.iter().enumerate() {
        let filename = file_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();

        let _ = app.emit("hoardfs-import-progress", ImportProgressEvent {
            current: idx as u32 + 1,
            total,
            filename: filename.clone(),
            status: "importing".to_string(),
        });

        // Build destination path in HoardFS
        let relative = file_path.strip_prefix(source).unwrap_or(file_path);
        let hfs_path = format!("{}/{}", hfs_prefix, relative.to_string_lossy());

        // Register as external reference — original stays on disk, only variants cached locally.
        // Uses spawn_blocking because HoardFs contains rusqlite (not Send).
        let hfs_clone = hoardfs_arc.clone();
        let hfs_path_clone = hfs_path.clone();
        let abs_path = std::fs::canonicalize(file_path)
            .unwrap_or_else(|_| file_path.clone())
            .to_string_lossy()
            .to_string();
        let file_size = std::fs::metadata(file_path).map(|m| m.len()).unwrap_or(0);
        let rt = tokio::runtime::Handle::current();
        let put_result = tokio::task::spawn_blocking(move || {
            let external = ExternalRef {
                location: abs_path,
                location_type: ExternalLocationType::FilesystemPath,
                size: file_size,
                content_hash: None, // register_external computes the hash
            };
            let hfs = hfs_clone.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
            let (file_record, _variants) = rt.block_on(hfs.register_external(
                "default",
                &hfs_path_clone,
                &external,
                true, // generate variants
            )).map_err(|e| format!("{}", e))?;
            let blob_id = hfs.get_file_info("default", &hfs_path_clone)
                .ok()
                .map(|info| info.current_version.blob_id.clone());
            Ok::<_, String>((file_record, blob_id))
        }).await
            .map_err(|e| format!("Task panicked: {}", e))?;

        match put_result {
            Ok((file_record, blob_id)) => {

                // Detect content type
                let ext = file_path.extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                let content_type = match ext.as_str() {
                    "jpg" | "jpeg" => "image/jpeg",
                    "png" => "image/png",
                    "tiff" | "tif" => "image/tiff",
                    "webp" => "image/webp",
                    "fit" | "fits" => "image/fits",
                    _ => "application/octet-stream",
                };

                // Build summary from filename (strip extension, replace underscores)
                let stem = file_path.file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or(&filename);
                let summary = stem.replace('_', " ");

                // Build metadata JSON with HoardFS info
                let metadata = serde_json::json!({
                    "hoardfs": {
                        "blob_id": blob_id,
                        "hfs_path": hfs_path,
                        "file_id": file_record.id,
                        "imported_at": chrono::Utc::now().to_rfc3339(),
                    }
                });

                // Create Astra image record
                let mut conn = state.db.get().map_err(|e| e.to_string())?;
                let image_id = uuid::Uuid::new_v4().to_string();
                let new_image = NewImage {
                    id: image_id.clone(),
                    user_id: user_id.clone(),
                    collection_id: None,
                    filename: filename.clone(),
                    url: Some(file_path.to_string_lossy().to_string()), // Keep filesystem path as fallback
                    summary: Some(summary),
                    description: None,
                    content_type: Some(content_type.to_string()),
                    favorite: false,
                    tags: None,
                    visibility: Some("private".to_string()),
                    location: None,
                    annotations: None,
                    metadata: Some(metadata.to_string()),
                    thumbnail: None, // Will be served from HoardFS variant
                    fits_url: if ext == "fit" || ext == "fits" {
                        Some(file_path.to_string_lossy().to_string())
                    } else {
                        None
                    },
                    blob_id,
                };

                match repository::create_image(&mut conn, &new_image) {
                    Ok(image) => {
                        // Add to collection if specified
                        if let Some(ref coll_id) = collection_id {
                            let link = NewCollectionImage {
                                id: uuid::Uuid::new_v4().to_string(),
                                collection_id: coll_id.clone(),
                                image_id: image.id.clone(),
                            };
                            if let Err(e) = repository::add_image_to_collection(&mut conn, &link) {
                                log::warn!("Failed to add image to collection: {}", e);
                            }
                        }
                        result.files_imported += 1;
                    }
                    Err(e) => {
                        result.errors.push(format!("{}: DB error: {}", filename, e));
                    }
                }
            }
            Err(err_msg) => {
                let msg = format!("{}: {}", filename, err_msg);
                log::warn!("HoardFS import failed: {}", msg);
                result.errors.push(msg);
            }
        }
    }

    let _ = app.emit("hoardfs-import-progress", ImportProgressEvent {
        current: total,
        total,
        filename: "".to_string(),
        status: "done".to_string(),
    });

    log::info!(
        "HoardFS import complete: {}/{} imported, {} skipped, {} errors",
        result.files_imported, result.files_scanned, result.files_skipped, result.errors.len()
    );

    Ok(result)
}

/// Helper: resolve HoardFS path for an image from its metadata
fn resolve_hfs_path(image: &crate::db::models::Image) -> Option<String> {
    image.metadata.as_ref().and_then(|m| {
        serde_json::from_str::<serde_json::Value>(m).ok()
    }).and_then(|v| {
        v.get("hoardfs")?.get("hfs_path")?.as_str().map(String::from)
    })
}

/// Get a thumbnail for an image, preferring HoardFS variant with filesystem fallback.
/// Returns raw JPEG bytes.
#[tauri::command]
pub async fn get_image_thumbnail_hoardfs(
    state: State<'_, AppState>,
    image_id: String,
) -> Result<Vec<u8>, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    let image = repository::get_image_by_id(&mut conn, &image_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Image not found: {}", image_id))?;
    drop(conn);

    // Try HoardFS variant first
    if let (Some(ref hfs_arc), Some(hfs_path)) = (&state.hoardfs, resolve_hfs_path(&image)) {
        let hfs_arc = hfs_arc.clone();
        let rt = tokio::runtime::Handle::current();
        let result = tokio::task::spawn_blocking(move || {
            let hfs = hfs_arc.lock().map_err(|e| format!("Lock: {}", e))?;
            rt.block_on(hfs.get_file_quality("default", &hfs_path, Quality::Thumbnail))
                .map(|(data, _quality, _ct)| data)
                .map_err(|e| format!("{}", e))
        }).await.map_err(|e| format!("Task: {}", e))?;

        if let Ok(data) = result {
            return Ok(data);
        }
    }

    // Fall back to base64 thumbnail in DB
    if let Some(ref thumb) = image.thumbnail {
        if let Some(b64_data) = thumb.strip_prefix("data:image/jpeg;base64,") {
            if let Ok(bytes) = BASE64_STANDARD.decode(b64_data) {
                return Ok(bytes);
            }
        }
    }

    // Fall back to reading the file and generating a thumbnail
    if let Some(ref url) = image.url {
        let path = Path::new(url);
        if path.exists() {
            let data = std::fs::read(path).map_err(|e| format!("Read: {}", e))?;
            let img = image::load_from_memory(&data).map_err(|e| format!("Decode: {}", e))?;
            let thumb = img.resize(256, 256, image::imageops::FilterType::Lanczos3);
            let mut buf = std::io::Cursor::new(Vec::new());
            thumb.write_to(&mut buf, image::ImageFormat::Jpeg)
                .map_err(|e| format!("Encode: {}", e))?;
            return Ok(buf.into_inner());
        }
    }

    Err("No thumbnail available".into())
}

/// Get a preview-quality image, preferring HoardFS variant.
/// Returns raw image bytes (JPEG).
#[tauri::command]
pub async fn get_image_preview_hoardfs(
    state: State<'_, AppState>,
    image_id: String,
) -> Result<Vec<u8>, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    let image = repository::get_image_by_id(&mut conn, &image_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Image not found: {}", image_id))?;
    drop(conn);

    // Try HoardFS variant first
    if let (Some(ref hfs_arc), Some(hfs_path)) = (&state.hoardfs, resolve_hfs_path(&image)) {
        let hfs_arc = hfs_arc.clone();
        let rt = tokio::runtime::Handle::current();
        let result = tokio::task::spawn_blocking(move || {
            let hfs = hfs_arc.lock().map_err(|e| format!("Lock: {}", e))?;
            rt.block_on(hfs.get_file_quality("default", &hfs_path, Quality::Preview))
                .map(|(data, _quality, _ct)| data)
                .map_err(|e| format!("{}", e))
        }).await.map_err(|e| format!("Task: {}", e))?;

        if let Ok(data) = result {
            return Ok(data);
        }
    }

    // Fall back to filesystem path
    if let Some(ref url) = image.url {
        let path = Path::new(url);
        if path.exists() {
            return std::fs::read(path).map_err(|e| format!("Read: {}", e));
        }
    }

    Err("No preview available".into())
}

/// List available quality variants for an image.
#[tauri::command]
pub async fn get_image_variants_hoardfs(
    state: State<'_, AppState>,
    image_id: String,
) -> Result<Vec<String>, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    let image = repository::get_image_by_id(&mut conn, &image_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Image not found: {}", image_id))?;
    drop(conn);

    let mut variants = Vec::new();

    // Always has "original" if url or blob_id exists
    if image.url.is_some() || image.blob_id.is_some() {
        variants.push("original".to_string());
    }

    // Check HoardFS for quality variants
    if let (Some(ref hfs_arc), Some(hfs_path)) = (&state.hoardfs, resolve_hfs_path(&image)) {
        let hfs_arc = hfs_arc.clone();
        let result = tokio::task::spawn_blocking(move || {
            let hfs = hfs_arc.lock().map_err(|e| format!("Lock: {}", e))?;
            hfs.list_variants("default", &hfs_path)
                .map(|vs| vs.into_iter().map(|v| format!("{:?}", v.quality).to_lowercase()).collect::<Vec<_>>())
                .map_err(|e| format!("{}", e))
        }).await.map_err(|e| format!("Task: {}", e))?;

        if let Ok(hfs_variants) = result {
            variants.extend(hfs_variants);
        }
    }

    // Has legacy thumbnail?
    if image.thumbnail.is_some() && !variants.iter().any(|v| v == "thumbnail") {
        variants.push("thumbnail".to_string());
    }

    Ok(variants)
}

/// Result of the legacy migration operation
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReport {
    pub total: u32,
    pub migrated: u32,
    pub skipped: u32,
    pub unreachable: u32,
    pub errors: Vec<String>,
}

/// Migrate existing images to HoardFS as external references.
///
/// Walks all images where blob_id is NULL and url is set, registers each
/// as an external reference in HoardFS with variant generation. Idempotent —
/// images with blob_id already set are skipped. Unreachable files (NAS offline)
/// are skipped and can be retried later.
#[tauri::command]
pub async fn migrate_images_to_hoardfs(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<MigrationReport, String> {
    let hoardfs_arc = state.hoardfs.as_ref()
        .ok_or("HoardFS is not initialized.")?
        .clone();

    // Query all images without blob_id
    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    let all_images = repository::get_images_by_user(&mut conn, &state.user_id)
        .map_err(|e| e.to_string())?;
    drop(conn);

    let to_migrate: Vec<_> = all_images.into_iter()
        .filter(|img| img.blob_id.is_none() && (img.url.is_some() || img.fits_url.is_some()))
        .collect();

    let total = to_migrate.len() as u32;
    let mut report = MigrationReport {
        total,
        migrated: 0,
        skipped: 0,
        unreachable: 0,
        errors: Vec::new(),
    };

    if total == 0 {
        return Ok(report);
    }

    let user_id = state.user_id.clone();

    for (idx, image) in to_migrate.iter().enumerate() {
        let _ = app.emit("hoardfs-migration-progress", serde_json::json!({
            "current": idx + 1,
            "total": total,
            "filename": &image.filename,
            "status": "migrating",
        }));

        // Prefer fits_url (higher quality source), fall back to url
        let source_path = image.fits_url.as_ref()
            .or(image.url.as_ref());

        let Some(source_path) = source_path else {
            report.skipped += 1;
            continue;
        };

        let path = std::path::Path::new(source_path);
        if !path.exists() {
            report.unreachable += 1;
            log::info!("Migration: source unreachable, skipping: {}", source_path);
            continue;
        }

        // Build HoardFS path from image creation date + filename
        let date_prefix = image.created_at.format("%Y-%m").to_string();
        let hfs_path = format!("/{}/{}", date_prefix, image.filename);

        let abs_path = std::fs::canonicalize(path)
            .unwrap_or_else(|_| path.to_path_buf())
            .to_string_lossy()
            .to_string();
        let file_size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);

        let hfs_clone = hoardfs_arc.clone();
        let hfs_path_clone = hfs_path.clone();
        let rt = tokio::runtime::Handle::current();

        let result = tokio::task::spawn_blocking(move || {
            let external = ExternalRef {
                location: abs_path,
                location_type: ExternalLocationType::FilesystemPath,
                size: file_size,
                content_hash: None,
            };
            let hfs = hfs_clone.lock().map_err(|e| format!("Lock: {}", e))?;
            let (_file_record, _variants) = rt.block_on(hfs.register_external(
                "default",
                &hfs_path_clone,
                &external,
                true,
            )).map_err(|e| format!("{}", e))?;
            let blob_id = hfs.get_file_info("default", &hfs_path_clone)
                .ok()
                .map(|info| info.current_version.blob_id.clone());
            Ok::<_, String>(blob_id)
        }).await
            .map_err(|e| format!("Task: {}", e))?;

        match result {
            Ok(blob_id) => {
                // Update the Astra image record with blob_id and hfs metadata
                let mut conn = state.db.get().map_err(|e| e.to_string())?;

                let mut existing_meta: serde_json::Value = image.metadata.as_ref()
                    .and_then(|m| serde_json::from_str(m).ok())
                    .unwrap_or_else(|| serde_json::json!({}));

                existing_meta["hoardfs"] = serde_json::json!({
                    "blob_id": blob_id,
                    "hfs_path": hfs_path,
                    "migrated_at": chrono::Utc::now().to_rfc3339(),
                });

                let update = crate::db::models::UpdateImage {
                    blob_id,
                    metadata: Some(serde_json::to_string(&existing_meta).unwrap_or_default()),
                    ..Default::default()
                };
                if let Err(e) = repository::update_image(&mut conn, &image.id, &update) {
                    report.errors.push(format!("{}: DB update failed: {}", image.filename, e));
                } else {
                    report.migrated += 1;
                }
            }
            Err(e) => {
                report.errors.push(format!("{}: {}", image.filename, e));
            }
        }
    }

    let _ = app.emit("hoardfs-migration-progress", serde_json::json!({
        "current": total,
        "total": total,
        "filename": "",
        "status": "done",
    }));

    log::info!(
        "Migration complete: {}/{} migrated, {} unreachable, {} errors",
        report.migrated, report.total, report.unreachable, report.errors.len()
    );

    Ok(report)
}

// ============================================================================
// FUSE Mount (feature-gated)
// ============================================================================

/// Start a FUSE mount exposing HoardFS images as a regular filesystem.
/// The mount runs on a dedicated thread with its own HoardFS connection.
/// Only available when compiled with the `fuse` feature.
#[cfg(feature = "fuse")]
#[tauri::command]
pub async fn start_fuse_mount(
    app: AppHandle,
    _state: State<'_, AppState>,
    fuse_state: State<'_, FuseMountState>,
    mount_point: String,
) -> Result<(), String> {
    let mount_path = std::path::PathBuf::from(&mount_point);

    // Create mount point directory if needed
    std::fs::create_dir_all(&mount_path)
        .map_err(|e| format!("Failed to create mount point: {}", e))?;

    // Check if already mounted
    {
        let guard = fuse_state.handle.lock().unwrap();
        if guard.is_some() {
            return Err("FUSE mount is already active. Stop it first.".into());
        }
    }

    // Open a separate HoardFS instance for the FUSE thread
    let hoardfs_dir = app.path()
        .app_data_dir()
        .map(|d| d.join("hoardfs"))
        .map_err(|e| format!("App data dir: {}", e))?;

    let rt = tokio::runtime::Handle::current();
    let hfs = rt.block_on(async {
        hoardfs_volume::HoardFs::open(&hoardfs_dir).await
    }).map_err(|e| format!("Failed to open HoardFS for FUSE: {}", e))?;

    // Get volume ID
    let volumes = hfs.list_volumes().map_err(|e| format!("{}", e))?;
    let vol = volumes.iter().find(|v| v.name == "default")
        .ok_or("Default volume not found")?;
    let volume_id = vol.id.clone();

    // Spawn mount on a dedicated thread (mount() is blocking)
    let mount_path_clone = mount_path.clone();
    let handle = std::thread::spawn(move || {
        log::info!("FUSE mount starting at {}", mount_path_clone.display());
        if let Err(e) = hoardfs_fuse::mount(hfs, "default", &volume_id, &mount_path_clone, true) {
            log::error!("FUSE mount error: {}", e);
        }
        log::info!("FUSE mount stopped");
    });

    // Store the handle and mount point for later cleanup
    {
        let mut guard = fuse_state.handle.lock().unwrap();
        *guard = Some(FuseHandle {
            thread: handle,
            mount_point: mount_path,
        });
    }

    log::info!("FUSE mount started at {} (beta)", mount_point);
    Ok(())
}

/// Stop the FUSE mount.
#[cfg(feature = "fuse")]
#[tauri::command]
pub async fn stop_fuse_mount(
    fuse_state: State<'_, FuseMountState>,
) -> Result<(), String> {
    let handle = {
        let mut guard = fuse_state.handle.lock().unwrap();
        guard.take()
    };

    if let Some(fuse) = handle {
        // Unmount by calling fusermount -u (Linux) or umount (macOS)
        let unmount_result = if cfg!(target_os = "macos") {
            std::process::Command::new("umount")
                .arg(fuse.mount_point.to_string_lossy().as_ref())
                .output()
        } else {
            std::process::Command::new("fusermount")
                .arg("-u")
                .arg(fuse.mount_point.to_string_lossy().as_ref())
                .output()
        };

        match unmount_result {
            Ok(output) if output.status.success() => {
                log::info!("FUSE unmount successful");
            }
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                log::warn!("FUSE unmount returned error: {}", stderr);
            }
            Err(e) => {
                log::warn!("Failed to run unmount command: {}", e);
            }
        }

        // Wait for the mount thread to finish
        let _ = fuse.thread.join();
        Ok(())
    } else {
        Err("No FUSE mount is active".into())
    }
}

/// State for tracking the FUSE mount thread
#[cfg(feature = "fuse")]
pub struct FuseMountState {
    handle: std::sync::Mutex<Option<FuseHandle>>,
}

#[cfg(feature = "fuse")]
struct FuseHandle {
    thread: std::thread::JoinHandle<()>,
    mount_point: std::path::PathBuf,
}

#[cfg(feature = "fuse")]
impl FuseMountState {
    pub fn new() -> Self {
        Self {
            handle: std::sync::Mutex::new(None),
        }
    }
}
