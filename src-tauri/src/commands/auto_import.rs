//! Auto-import: periodically scan configured directories for new FITS images

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::watch;
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoImportProgress {
    pub step: String,
    pub detail: String,
    pub image_name: Option<String>,
    pub current: usize,
    pub total: usize,
}

use crate::db::models::{NewCollection, NewCollectionImage, NewImage, UpdateImage};
use crate::db::repository;
use crate::python::image_process as py_image;
use crate::python::plate_solve as py_plate_solve;
use crate::state::{AppState, AutoImportStatus};

use super::scan::{
    generate_fits_thumbnail, generate_thumbnail, parse_fits_metadata, FitsMetadata,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSource {
    pub name: String,
    pub watch_folder: String,
    pub library_path: Option<String>,
    pub copy_subframes: Option<bool>,
    pub copy_calibration: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoImportConfig {
    pub sources: Vec<ImportSource>,
    pub poll_interval_secs: u64,
    pub enabled: bool,
    pub plate_solve: Option<bool>,
    pub plate_solve_solver: Option<String>,
    pub plate_solve_api_key: Option<String>,
    pub plate_solve_api_url: Option<String>,
    pub stretch_bg_percent: Option<f64>,
    pub stretch_sigma: Option<f64>,
    /// Legacy fields for backward compatibility
    pub watch_folders: Option<Vec<String>>,
    pub library_path: Option<String>,
}

/// Check if a file is a FITS file
fn is_fits(path: &Path) -> bool {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    ext == "fit" || ext == "fits"
}

/// Check if a file is a subframe (Light frame)
fn is_subframe(path: &Path) -> bool {
    if !is_fits(path) { return false; }
    let path_str = path.to_string_lossy().to_lowercase();
    let file_name = path.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    // ASI Air: Light_*.fit in /Light/ directories
    // SharpCap: frame_*.fits in /rawframes/ directories
    ((path_str.contains("/light/") || file_name.starts_with("light_"))
        || (path_str.contains("/rawframes/") || file_name.starts_with("frame_")))
        && !is_stacked_fits(path)
}

/// Check if a file is a calibration frame (Dark, Flat, Bias)
fn is_calibration(path: &Path) -> bool {
    if !is_fits(path) { return false; }
    let path_str = path.to_string_lossy().to_lowercase();
    let file_name = path.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    path_str.contains("/dark/") || file_name.starts_with("dark_")
        || path_str.contains("/flat/") || file_name.starts_with("flat_")
        || path_str.contains("/bias/") || file_name.starts_with("bias_")
        || file_name.starts_with("master_")
}

/// Check if a file path matches stacked image patterns
fn is_stacked_fits(path: &Path) -> bool {
    let path_str = path.to_string_lossy().to_lowercase();
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    // Must be a FITS file
    if !file_name.ends_with(".fit") && !file_name.ends_with(".fits") {
        return false;
    }

    // Exclude calibration frames and raw subframes
    if is_calibration(path) {
        return false;
    }
    if file_name.starts_with("light_") || file_name.starts_with("dark_")
        || file_name.starts_with("flat_") || file_name.starts_with("bias_")
        || file_name.starts_with("master_")
        || file_name.starts_with("frame_")  // SharpCap raw subframes
    {
        return false;
    }
    // Exclude files in calibration/light directories unless they're stacked
    // (ASI Air puts Stacked_*.fit directly in /Live/Light/<target>/)
    // Exclude files in raw/calibration directories unless they're stacked
    if (path_str.contains("/light/") || path_str.contains("/dark/")
        || path_str.contains("/flat/") || path_str.contains("/bias/")
        || path_str.contains("/rawframes/"))  // SharpCap raw subframes
        && !path_str.contains("/stacked/")
        && !file_name.starts_with("stack_")
        && !file_name.starts_with("stacked")
    {
        return false;
    }

    // Match stacked patterns:
    // - Files in a "Stacked" directory
    // - Files with "Stack_" or "Stacked_" prefix
    // - Files with "stacked" in the name
    path_str.contains("/stacked/")
        || file_name.starts_with("stack_")
        || file_name.starts_with("stacked_")
        || file_name.contains("stacked")
}

/// Extract target name from directory path or FITS metadata
fn extract_target_name(path: &Path, metadata: &FitsMetadata) -> Option<String> {
    // Prefer FITS OBJECT header
    if let Some(obj) = &metadata.object_name {
        if !obj.is_empty() {
            // Clean up SharpCap-style names: "M101 (NGC 5457,Pinwheel Galaxy)" → "M101"
            let name = if let Some(paren_pos) = obj.find('(') {
                obj[..paren_pos].trim().to_string()
            } else {
                obj.clone()
            };
            return Some(name);
        }
    }

    // Fall back to parent directory name (ASI Air uses target name as dir)
    // e.g., /mnt/asiair/Autorun/Light/M42/Stacked/Stack_xxx.fit -> "M42"
    let mut current = path.parent();
    while let Some(dir) = current {
        let dir_name = dir.file_name()?.to_string_lossy().to_string();
        let lower = dir_name.to_lowercase();
        // Skip generic directory names
        if ["stacked", "light", "autorun", "plan", "live", "dark", "flat", "bias",
            "rawframes", "processed", "sharpcap"]
            .contains(&lower.as_str())
        {
            current = dir.parent();
            continue;
        }
        // Skip timestamp-like dirs (HH_MM_SS) and date-like dirs (YYYY-MM-DD)
        if lower.len() <= 10 && (
            lower.chars().all(|c| c.is_ascii_digit() || c == '_' || c == '-')
        ) {
            current = dir.parent();
            continue;
        }
        // Found a meaningful directory name — use it as target
        // For SharpCap, extract just the primary name from "M101 (NGC 5457,Pinwheel Galaxy)"
        let name = if let Some(paren_pos) = dir_name.find('(') {
            dir_name[..paren_pos].trim().to_string()
        } else {
            dir_name
        };
        return Some(name);
        current = dir.parent();
    }
    None
}

/// Copy supporting files (subframes, calibration) to library
fn copy_supporting_files(
    source: &ImportSource,
    progress_tx: Option<&mpsc::Sender<AutoImportProgress>>,
) {
    let Some(lib_path) = &source.library_path else { return };
    let lib_base = PathBuf::from(lib_path);

    let copy_subs = source.copy_subframes.unwrap_or(false);
    let copy_cal = source.copy_calibration.unwrap_or(false);
    if !copy_subs && !copy_cal { return; }

    let watch = PathBuf::from(&source.watch_folder);
    if !watch.exists() { return; }

    let emit = |detail: &str| {
        if let Some(tx) = progress_tx {
            let _ = tx.send(AutoImportProgress {
                step: "copying".to_string(),
                detail: detail.to_string(),
                image_name: None,
                current: 0,
                total: 0,
            });
        }
    };

    let mut copied = 0usize;
    let mut skipped = 0usize;

    for entry in WalkDir::new(&watch)
        .follow_links(true)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if !path.is_file() { continue; }

        let should_copy = (copy_subs && is_subframe(path)) || (copy_cal && is_calibration(path));
        if !should_copy { continue; }

        // Determine destination: preserve relative path structure
        let rel_path = path.strip_prefix(&watch).unwrap_or(path);
        let dest = lib_base.join(rel_path);

        if dest.exists() {
            skipped += 1;
            continue;
        }

        if let Some(parent) = dest.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        match std::fs::copy(path, &dest) {
            Ok(_) => {
                copied += 1;
                if copied % 50 == 0 {
                    emit(&format!("Copied {} files to library...", copied));
                }
            }
            Err(e) => {
                log::warn!("Failed to copy {}: {}", path.display(), e);
            }
        }
    }

    if copied > 0 {
        log::info!("Copied {} supporting files to library ({} skipped)", copied, skipped);
        emit(&format!("Copied {} files to library", copied));
    }
}

/// Run a single scan cycle
fn run_scan_cycle(
    db_pool: &crate::db::DbPool,
    user_id: &str,
    config: &AutoImportConfig,
    preview_dir: &Path,
    progress_tx: Option<&mpsc::Sender<AutoImportProgress>>,
) -> Result<(usize, Vec<String>), String> {
    let emit = |step: &str, detail: &str, name: Option<&str>, current: usize, total: usize| {
        if let Some(tx) = progress_tx {
            let _ = tx.send(AutoImportProgress {
                step: step.to_string(),
                detail: detail.to_string(),
                image_name: name.map(|s| s.to_string()),
                current,
                total,
            });
        }
    };
    // Build effective sources list (support legacy watchFolders format)
    let sources: Vec<ImportSource> = if !config.sources.is_empty() {
        config.sources.clone()
    } else if let Some(folders) = &config.watch_folders {
        folders.iter().map(|f| ImportSource {
            name: f.split('/').last().unwrap_or("source").to_string(),
            watch_folder: f.clone(),
            library_path: config.library_path.clone(),
            copy_subframes: None,
            copy_calibration: None,
        }).collect()
    } else {
        vec![]
    };

    let mut imported = 0;
    let mut errors = Vec::new();

    // Load existing image URLs for dedup
    let mut conn = db_pool.get().map_err(|e| e.to_string())?;
    let existing_urls: HashSet<String> = repository::get_all_image_urls(&mut conn, user_id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .collect();
    let existing_fits: HashSet<String> = repository::get_all_fits_urls(&mut conn, user_id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .collect();
    drop(conn);

    // Track session collections: session_date_string → collection_id
    let mut session_collections: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    emit("scanning", "Scanning sources...", None, 0, 0);

    for source in &sources {
        let folder_path = PathBuf::from(&source.watch_folder);
        if !folder_path.exists() || std::fs::read_dir(&folder_path).is_err() {
            log::info!("Source {} unavailable ({}), skipping", source.name, source.watch_folder);
            emit("skipped", &format!("{} not mounted, skipping", source.name), None, 0, 0);
            continue;
        }

        emit("scanning", &format!("Scanning {}...", source.name), None, 0, 0);

        // Copy supporting files (subframes, calibration) to library
        copy_supporting_files(source, progress_tx);

        // Walk directory looking for stacked FITS files
        for entry in WalkDir::new(&folder_path)
            .follow_links(true)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            let path = entry.path();
            if !path.is_file() || !is_stacked_fits(path) {
                continue;
            }

            let path_str = path.to_string_lossy().to_string();

            // Skip already imported — check original path, library path, and filename
            if existing_urls.contains(&path_str) || existing_fits.contains(&path_str) {
                continue;
            }
            // Also check if the library destination path already exists in DB
            // (the FITS was copied to library on a previous import)
            if let Some(lib_path) = &source.library_path {
                let file_name_str = path.file_name().unwrap_or_default().to_string_lossy();
                let lib_check = existing_fits.iter().any(|f| f.ends_with(file_name_str.as_ref()));
                if lib_check {
                    continue;
                }
            }

            let file_name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            emit("found", &format!("Found: {}", file_name), Some(&file_name), imported + 1, 0);

            // Parse FITS metadata
            let metadata = match parse_fits_metadata(path) {
                Ok(m) => m,
                Err(e) => {
                    errors.push(format!("{}: {}", path.display(), e));
                    continue;
                }
            };

            // Generate thumbnail (try JPEG companion first, then FITS stretch)
            let jpeg_companion = path.with_extension("jpg");
            let thumbnail = if jpeg_companion.exists() {
                generate_thumbnail(&jpeg_companion).ok()
            } else {
                generate_fits_thumbnail(path).ok()
            };

            // Extract target name
            let target = extract_target_name(path, &metadata);
            let summary = target
                .clone()
                .or_else(|| Some(path.file_stem()?.to_string_lossy().to_string()));

            // Build description
            // Try to extract frame count from filename if not in FITS headers
            // SharpCap: Stack_16bits_13frames_130s.fits → 13 frames
            let stacked_frames = metadata.stacked_frames.or_else(|| {
                let fname = file_name.to_lowercase();
                if let Some(pos) = fname.find("frames") {
                    let before = &fname[..pos];
                    let num_str: String = before.chars().rev()
                        .take_while(|c| c.is_ascii_digit())
                        .collect::<String>()
                        .chars().rev().collect();
                    num_str.parse::<i32>().ok()
                } else {
                    None
                }
            });

            let mut desc_parts = Vec::new();
            if let Some(exp) = metadata.exposure {
                desc_parts.push(format!("{:.1}s exposure", exp));
            }
            if let Some(frames) = stacked_frames {
                desc_parts.push(format!("{} frames stacked", frames));
            }
            if let Some(filter) = &metadata.filter {
                desc_parts.push(format!("Filter: {}", filter));
            }
            let description = if desc_parts.is_empty() {
                None
            } else {
                Some(desc_parts.join(", "))
            };

            // Build metadata JSON
            let meta_json = serde_json::to_string(&metadata.raw_headers).ok();

            // Copy FITS to library if configured for this source
            let fits_final_path = if let Some(lib_path) = &source.library_path {
                let lib_base = PathBuf::from(lib_path);

                // Organize: {library}/{YYYY-MM-DD}/{target}/filename.fit
                let date_dir = metadata.date_obs.as_ref()
                    .and_then(|d| d.split('T').next())
                    .unwrap_or("unknown-date");
                let target_dir = target.as_deref().unwrap_or("unknown");
                // Sanitize directory names
                let target_dir = target_dir.replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_");

                let dest_dir = lib_base.join(date_dir).join(&target_dir);
                if let Err(e) = std::fs::create_dir_all(&dest_dir) {
                    log::warn!("Failed to create library dir {}: {}", dest_dir.display(), e);
                    path_str.clone()
                } else {
                    let dest_file = dest_dir.join(path.file_name().unwrap_or_default());
                    if dest_file.exists() {
                        // Already copied
                        dest_file.to_string_lossy().to_string()
                    } else {
                        emit("copying", &format!("Copying to library: {}", file_name), Some(&file_name), imported + 1, 0);
                        match std::fs::copy(path, &dest_file) {
                            Ok(bytes) => {
                                log::info!("Copied {} to library ({} bytes)", file_name, bytes);
                                dest_file.to_string_lossy().to_string()
                            }
                            Err(e) => {
                                log::warn!("Failed to copy to library: {}", e);
                                path_str.clone()
                            }
                        }
                    }
                }
            } else {
                path_str.clone()
            };

            // Create image record
            let image_id = uuid::Uuid::new_v4().to_string();
            let new_image = NewImage {
                id: image_id.clone(),
                user_id: user_id.to_string(),
                collection_id: None,
                filename: path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string(),
                url: Some(path_str.clone()),
                summary,
                description,
                content_type: Some("image/fits".to_string()),
                favorite: false,
                tags: None,
                visibility: Some("private".to_string()),
                location: None,
                annotations: None,
                metadata: meta_json,
                thumbnail,
                fits_url: Some(fits_final_path),
            };

            let fits_path_str = new_image.fits_url.clone().unwrap_or_default();

            let mut conn = db_pool.get().map_err(|e| e.to_string())?;
            match repository::create_image(&mut conn, &new_image) {
                Ok(_) => {
                    imported += 1;
                    log::info!("Auto-imported: {}", new_image.filename);

                    // Add to session collection (one per observing night)
                    if let Some(date_obs) = &metadata.date_obs {
                        if let Some(session_date) = super::scan::get_session_date(date_obs) {
                            let session_key = session_date.to_string();
                            let session_coll_id = if let Some(id) = session_collections.get(&session_key) {
                                id.clone()
                            } else {
                                let coll_name = super::scan::generate_collection_name(&session_date, None);
                                match repository::get_collection_by_name(&mut conn, user_id, &coll_name) {
                                    Ok(Some(existing)) => {
                                        session_collections.insert(session_key.clone(), existing.id.clone());
                                        existing.id
                                    }
                                    _ => {
                                        let coll_id = uuid::Uuid::new_v4().to_string();
                                        let new_coll = NewCollection {
                                            id: coll_id.clone(),
                                            user_id: user_id.to_string(),
                                            name: coll_name,
                                            description: Some(format!("Observing session {}", session_key)),
                                            visibility: "private".to_string(),
                                            template: Some("astrolog".to_string()),
                                            favorite: false,
                                            tags: Some("session,auto-import".to_string()),
                                            metadata: Some(serde_json::json!({
                                                "session_date": session_key,
                                                "auto_imported": true,
                                                "source": source.name,
                                            }).to_string()),
                                            archived: false,
                                        };
                                        match repository::create_collection(&mut conn, &new_coll) {
                                            Ok(c) => {
                                                log::info!("Created session collection: {} ({})", c.name, session_key);
                                                session_collections.insert(session_key.clone(), c.id.clone());
                                                c.id
                                            }
                                            Err(e) => {
                                                log::warn!("Failed to create session collection: {}", e);
                                                String::new()
                                            }
                                        }
                                    }
                                }
                            };

                            // Add image to session collection
                            if !session_coll_id.is_empty() {
                                let entry = NewCollectionImage {
                                    id: uuid::Uuid::new_v4().to_string(),
                                    collection_id: session_coll_id,
                                    image_id: image_id.clone(),
                                };
                                let _ = repository::add_image_to_collection(&mut conn, &entry);
                            }
                        }
                    }

                    // Generate a full-size preview JPEG via Python stretch
                    // Save preview locally (not on remote mount) using image ID
                    let preview_path = preview_dir.join(
                        format!("{}.jpg", image_id)
                    );
                    let preview_path_str = preview_path.to_string_lossy().to_string();

                    emit("stretching", &format!("Stretching: {}", new_image.filename), Some(&new_image.filename), imported, 0);
                    match py_image::quick_preview(&fits_path_str, &preview_path_str, config.stretch_bg_percent, config.stretch_sigma) {
                        Ok(output_path) => {
                            log::info!("Generated preview: {}", output_path);
                            // Update the image URL to point to the preview JPEG
                            let update = UpdateImage {
                                url: Some(output_path.clone()),
                                ..Default::default()
                            };
                            if let Err(e) = repository::update_image(&mut conn, &image_id, &update) {
                                log::warn!("Failed to update image URL: {}", e);
                            }
                            // Also generate a proper thumbnail from the preview
                            if let Ok(thumb) = generate_thumbnail(Path::new(&output_path)) {
                                let thumb_update = UpdateImage {
                                    thumbnail: Some(thumb),
                                    ..Default::default()
                                };
                                let _ = repository::update_image(&mut conn, &image_id, &thumb_update);
                            }
                        }
                        Err(e) => {
                            log::warn!("Failed to generate preview for {}: {}", new_image.filename, e);
                        }
                    }

                    // Plate solve if enabled
                    if config.plate_solve.unwrap_or(false) {
                        let solver = config.plate_solve_solver.as_deref().unwrap_or("local");
                        emit("plate-solving", &format!("Plate solving: {}", new_image.filename), Some(&new_image.filename), imported, 0);
                        log::info!("Auto plate-solving: {} with {}", new_image.filename, solver);
                        match py_plate_solve::solve_image(
                            &fits_path_str,
                            solver,
                            config.plate_solve_api_key.as_deref(),
                            config.plate_solve_api_url.as_deref(),
                            None, None, Some(120), None, None, None,
                        ) {
                            Ok(result) if result.success => {
                                log::info!("Plate solved {}: RA={:.4} Dec={:.4}", new_image.filename, result.center_ra, result.center_dec);

                                // Query catalog objects in FOV
                                let objects = py_plate_solve::query_objects_in_fov(
                                    result.center_ra, result.center_dec,
                                    result.width_deg, result.height_deg,
                                    None, None,
                                    Some(&fits_path_str),
                                    Some(&result),
                                ).unwrap_or_default();

                                // Build annotations JSON
                                let annotations = serde_json::to_string(&objects).ok();

                                // Build plate solve metadata
                                let ps_meta = serde_json::json!({
                                    "plate_solve": {
                                        "solved_at": chrono::Utc::now().to_rfc3339(),
                                        "solver": result.solver,
                                        "center_ra": result.center_ra,
                                        "center_dec": result.center_dec,
                                        "pixel_scale": result.pixel_scale,
                                        "rotation": result.rotation,
                                        "width_deg": result.width_deg,
                                        "height_deg": result.height_deg,
                                        "solve_time": result.solve_time,
                                    }
                                });

                                // Merge with existing metadata
                                let merged_meta = if let Some(existing) = &new_image.metadata {
                                    if let Ok(mut existing_json) = serde_json::from_str::<serde_json::Value>(existing) {
                                        if let Some(obj) = existing_json.as_object_mut() {
                                            obj.insert("plate_solve".to_string(), ps_meta["plate_solve"].clone());
                                        }
                                        Some(existing_json.to_string())
                                    } else {
                                        Some(ps_meta.to_string())
                                    }
                                } else {
                                    Some(ps_meta.to_string())
                                };

                                // Update summary with first detected object name
                                let summary_update = objects.first().map(|o| o.name.clone());

                                let update = UpdateImage {
                                    annotations,
                                    metadata: merged_meta,
                                    summary: summary_update,
                                    ..Default::default()
                                };
                                let _ = repository::update_image(&mut conn, &image_id, &update);
                            }
                            Ok(result) => {
                                log::warn!("Plate solve failed for {}: {}", new_image.filename, result.error_message.unwrap_or_default());
                            }
                            Err(e) => {
                                log::warn!("Plate solve error for {}: {}", new_image.filename, e);
                            }
                        }
                    }
                }
                Err(e) => {
                    errors.push(format!("Failed to import {}: {}", new_image.filename, e));
                }
            }
        }
    }

    Ok((imported, errors))
}

#[tauri::command]
pub async fn start_auto_import(
    app: AppHandle,
    state: State<'_, AppState>,
    config: AutoImportConfig,
) -> Result<(), String> {
    // Stop existing task if running
    {
        let mut cancel = state.auto_import_cancel.lock().unwrap();
        if let Some(tx) = cancel.take() {
            let _ = tx.send(true);
        }
    }

    if !config.enabled {
        let mut status = state.auto_import_status.lock().unwrap();
        status.enabled = false;
        return Ok(());
    }

    // Create cancellation channel
    let (cancel_tx, mut cancel_rx) = watch::channel(false);
    {
        let mut cancel = state.auto_import_cancel.lock().unwrap();
        *cancel = Some(cancel_tx);
    }

    // Update status
    {
        let mut status = state.auto_import_status.lock().unwrap();
        status.enabled = true;
        status.errors.clear();
    }

    let db_pool = state.db.clone();
    let user_id = state.user_id.clone();
    let poll_interval = std::time::Duration::from_secs(config.poll_interval_secs.max(30));
    let config = config.clone();
    let status_ref = state.auto_import_status.clone();
    let pdir = app.path().app_data_dir()
        .map(|d| d.join("previews"))
        .unwrap_or_else(|_| PathBuf::from("/tmp/astra-previews"));
    let _ = std::fs::create_dir_all(&pdir);

    // Spawn background polling task
    tokio::spawn(async move {
        log::info!(
            "Auto-import started: {:?} every {}s",
            config.watch_folders,
            poll_interval.as_secs()
        );

        loop {
            // Check cancellation
            if *cancel_rx.borrow() {
                break;
            }

            // Update status: scanning
            {
                let mut status = status_ref.lock().unwrap();
                status.is_scanning = true;
            }

            // Run scan in blocking task with progress forwarding
            let db = db_pool.clone();
            let uid = user_id.clone();
            let cfg = config.clone();
            let app_clone = app.clone();
            let pd = pdir.clone();
            let scan_result = tokio::task::spawn_blocking(move || {
                let (tx, rx) = mpsc::channel();
                let app_fwd = app_clone.clone();
                std::thread::spawn(move || {
                    while let Ok(progress) = rx.recv() {
                        let _ = app_fwd.emit("auto-import-progress", &progress);
                    }
                });
                run_scan_cycle(&db, &uid, &cfg, &pd, Some(&tx))
            }).await;

            // Update status with results
            {
                let mut status = status_ref.lock().unwrap();
                status.is_scanning = false;
                status.last_scan_time = Some(chrono::Utc::now().to_rfc3339());

                match scan_result {
                    Ok(Ok((count, scan_errors))) => {
                        status.last_import_count = count;
                        status.total_imported += count;
                        status.errors = scan_errors;
                        if count > 0 {
                            log::info!("Auto-import: imported {} new images", count);
                        }
                    }
                    Ok(Err(e)) => {
                        status.errors = vec![e];
                    }
                    Err(e) => {
                        status.errors = vec![format!("Task panicked: {}", e)];
                    }
                }
            }

            // Emit status event
            let status_snapshot = { status_ref.lock().unwrap().clone() };
            let _ = app.emit("auto-import-status", &status_snapshot);

            // Wait for next poll or cancellation
            tokio::select! {
                _ = tokio::time::sleep(poll_interval) => {},
                _ = cancel_rx.changed() => {
                    if *cancel_rx.borrow() {
                        break;
                    }
                }
            }
        }

        log::info!("Auto-import stopped");
        let mut status = status_ref.lock().unwrap();
        status.enabled = false;
        status.is_scanning = false;
    });

    Ok(())
}

#[tauri::command]
pub fn stop_auto_import(state: State<'_, AppState>) -> Result<(), String> {
    let mut cancel = state.auto_import_cancel.lock().unwrap();
    if let Some(tx) = cancel.take() {
        let _ = tx.send(true);
    }
    let mut status = state.auto_import_status.lock().unwrap();
    status.enabled = false;
    Ok(())
}

#[tauri::command]
pub fn get_auto_import_status(state: State<'_, AppState>) -> Result<AutoImportStatus, String> {
    Ok(state.auto_import_status.lock().unwrap().clone())
}

#[tauri::command]
pub async fn scan_auto_import_now(
    app: AppHandle,
    state: State<'_, AppState>,
    config: AutoImportConfig,
) -> Result<AutoImportStatus, String> {
    let db_pool = state.db.clone();
    let user_id = state.user_id.clone();
    let pdir = app.path().app_data_dir()
        .map(|d| d.join("previews"))
        .unwrap_or_else(|_| PathBuf::from("/tmp/astra-previews"));
    let _ = std::fs::create_dir_all(&pdir);

    // Update status
    {
        let mut status = state.auto_import_status.lock().unwrap();
        status.is_scanning = true;
    }

    let app_clone = app.clone();
    let scan_result = tokio::task::spawn_blocking(move || {
        let (tx, rx) = mpsc::channel();
        let app_fwd = app_clone.clone();
        std::thread::spawn(move || {
            while let Ok(progress) = rx.recv() {
                let _ = app_fwd.emit("auto-import-progress", &progress);
            }
        });
        run_scan_cycle(&db_pool, &user_id, &config, &pdir, Some(&tx))
    }).await;

    let mut status = state.auto_import_status.lock().unwrap();
    status.is_scanning = false;
    status.last_scan_time = Some(chrono::Utc::now().to_rfc3339());

    match scan_result {
        Ok(Ok((count, scan_errors))) => {
            status.last_import_count = count;
            status.total_imported += count;
            status.errors = scan_errors;
        }
        Ok(Err(e)) => {
            status.errors = vec![e.clone()];
            return Err(e);
        }
        Err(e) => {
            let msg = format!("Task panicked: {}", e);
            status.errors = vec![msg.clone()];
            return Err(msg);
        }
    }

    let result = status.clone();
    drop(status);

    let _ = app.emit("auto-import-status", &result);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    // ========================================================================
    // is_fits tests
    // ========================================================================

    #[test]
    fn is_fits_fit_extension() {
        assert!(is_fits(Path::new("/data/Stack_M42.fit")));
    }

    #[test]
    fn is_fits_fits_extension() {
        assert!(is_fits(Path::new("/data/image.fits")));
    }

    #[test]
    fn is_fits_case_insensitive() {
        assert!(is_fits(Path::new("/data/image.FIT")));
        assert!(is_fits(Path::new("/data/image.FITS")));
    }

    #[test]
    fn is_fits_not_jpeg() {
        assert!(!is_fits(Path::new("/data/image.jpg")));
    }

    #[test]
    fn is_fits_not_png() {
        assert!(!is_fits(Path::new("/data/image.png")));
    }

    #[test]
    fn is_fits_no_extension() {
        assert!(!is_fits(Path::new("/data/noext")));
    }

    // ========================================================================
    // is_subframe tests
    // ========================================================================

    #[test]
    fn is_subframe_light_directory() {
        assert!(is_subframe(Path::new("/asiair/Autorun/Light/M42/Light_00001.fit")));
    }

    #[test]
    fn is_subframe_light_prefix() {
        assert!(is_subframe(Path::new("/data/Light_00001.fit")));
    }

    #[test]
    fn is_subframe_sharpcap_rawframes() {
        assert!(is_subframe(Path::new("/sharpcap/rawframes/frame_001.fits")));
    }

    #[test]
    fn is_subframe_sharpcap_frame_prefix() {
        assert!(is_subframe(Path::new("/data/frame_001.fits")));
    }

    #[test]
    fn is_subframe_not_stacked() {
        // A stacked file in Light directory should NOT be a subframe
        assert!(!is_subframe(Path::new("/asiair/Autorun/Light/M42/Stacked/Stacked_M42.fit")));
    }

    #[test]
    fn is_subframe_not_jpeg() {
        assert!(!is_subframe(Path::new("/data/Light_00001.jpg")));
    }

    #[test]
    fn is_subframe_not_dark() {
        assert!(!is_subframe(Path::new("/data/Dark_00001.fit")));
    }

    // ========================================================================
    // is_calibration tests
    // ========================================================================

    #[test]
    fn is_calibration_dark_dir() {
        assert!(is_calibration(Path::new("/asiair/Dark/Dark_001.fit")));
    }

    #[test]
    fn is_calibration_dark_prefix() {
        assert!(is_calibration(Path::new("/data/Dark_001.fit")));
    }

    #[test]
    fn is_calibration_flat_dir() {
        assert!(is_calibration(Path::new("/asiair/Flat/Flat_001.fit")));
    }

    #[test]
    fn is_calibration_flat_prefix() {
        assert!(is_calibration(Path::new("/data/Flat_001.fit")));
    }

    #[test]
    fn is_calibration_bias_dir() {
        assert!(is_calibration(Path::new("/asiair/Bias/Bias_001.fit")));
    }

    #[test]
    fn is_calibration_bias_prefix() {
        assert!(is_calibration(Path::new("/data/Bias_001.fit")));
    }

    #[test]
    fn is_calibration_master() {
        assert!(is_calibration(Path::new("/data/master_dark.fit")));
    }

    #[test]
    fn is_calibration_not_light() {
        assert!(!is_calibration(Path::new("/data/Light_001.fit")));
    }

    #[test]
    fn is_calibration_not_jpeg() {
        assert!(!is_calibration(Path::new("/data/Dark_001.jpg")));
    }

    // ========================================================================
    // is_stacked_fits tests
    // ========================================================================

    #[test]
    fn is_stacked_fits_stacked_dir() {
        assert!(is_stacked_fits(Path::new(
            "/asiair/Autorun/Light/M42/Stacked/Stack_M42.fit"
        )));
    }

    #[test]
    fn is_stacked_fits_stack_prefix() {
        assert!(is_stacked_fits(Path::new("/data/Stack_16bits.fit")));
    }

    #[test]
    fn is_stacked_fits_stacked_prefix() {
        assert!(is_stacked_fits(Path::new("/data/Stacked_M42.fit")));
    }

    #[test]
    fn is_stacked_fits_stacked_in_name() {
        assert!(is_stacked_fits(Path::new("/data/M42_stacked.fits")));
    }

    #[test]
    fn is_stacked_fits_not_light_subframe() {
        assert!(!is_stacked_fits(Path::new("/data/Light_00001.fit")));
    }

    #[test]
    fn is_stacked_fits_not_dark() {
        assert!(!is_stacked_fits(Path::new("/data/Dark_001.fit")));
    }

    #[test]
    fn is_stacked_fits_not_flat() {
        assert!(!is_stacked_fits(Path::new("/data/Flat_001.fit")));
    }

    #[test]
    fn is_stacked_fits_not_master() {
        assert!(!is_stacked_fits(Path::new("/data/master_dark.fit")));
    }

    #[test]
    fn is_stacked_fits_not_jpeg() {
        assert!(!is_stacked_fits(Path::new("/data/stacked.jpg")));
    }

    #[test]
    fn is_stacked_fits_not_light_dir_without_stacked() {
        // A plain FITS in /Light/ that is not a stacked file
        assert!(!is_stacked_fits(Path::new(
            "/asiair/Autorun/Light/M42/some_image.fit"
        )));
    }

    #[test]
    fn is_stacked_fits_sharpcap_frame_excluded() {
        assert!(!is_stacked_fits(Path::new("/data/frame_001.fits")));
    }
}
