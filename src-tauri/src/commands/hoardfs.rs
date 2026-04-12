//! HoardFS-based image import commands.
//!
//! Imports images into HoardFS content-addressed storage with automatic
//! variant generation (thumbnail + preview) and EXIF metadata extraction.

use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::{AppHandle, Emitter, State};

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

/// Import images from a directory into HoardFS with automatic variant generation.
///
/// Each imported image gets:
/// - A blob in HoardFS (content-addressed, deduplicated)
/// - Thumbnail and preview variants (auto-generated)
/// - An Astra image record with blob_id set
/// - Optional collection association
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

        // Import into HoardFS with variant generation
        // Use spawn_blocking because HoardFs is not Send (rusqlite::Connection).
        // Inside the blocking task, use a tokio runtime handle for async HoardFS ops.
        let hfs_clone = hoardfs_arc.clone();
        let hfs_path_clone = hfs_path.clone();
        let file_path_clone = file_path.clone();
        let rt = tokio::runtime::Handle::current();
        let put_result = tokio::task::spawn_blocking(move || {
            let hfs = hfs_clone.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
            let result = rt.block_on(hfs.put_file_from_path_with_variants(
                "default",
                &hfs_path_clone,
                &file_path_clone,
                true,
            )).map_err(|e| format!("{}", e))?;
            let blob_id = hfs.get_file_info("default", &hfs_path_clone)
                .ok()
                .map(|info| info.current_version.blob_id.clone());
            Ok::<_, String>((result.0, blob_id))
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
