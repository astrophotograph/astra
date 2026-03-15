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

use crate::db::models::{NewImage, UpdateImage};
use crate::db::repository;
use crate::python::image_process as py_image;
use crate::python::plate_solve as py_plate_solve;
use crate::state::{AppState, AutoImportStatus};

use super::scan::{
    generate_fits_thumbnail, generate_thumbnail, parse_fits_metadata, FitsMetadata,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoImportConfig {
    pub watch_folders: Vec<String>,
    pub poll_interval_secs: u64,
    pub enabled: bool,
    /// Plate solve on import
    pub plate_solve: Option<bool>,
    pub plate_solve_solver: Option<String>,
    pub plate_solve_api_key: Option<String>,
    pub plate_solve_api_url: Option<String>,
    pub stretch_bg_percent: Option<f64>,
    pub stretch_sigma: Option<f64>,
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
            return Some(obj.clone());
        }
    }

    // Fall back to parent directory name (ASI Air uses target name as dir)
    // e.g., /mnt/asiair/Autorun/Light/M42/Stacked/Stack_xxx.fit -> "M42"
    let mut current = path.parent();
    while let Some(dir) = current {
        let dir_name = dir.file_name()?.to_string_lossy().to_string();
        // Skip generic directory names
        if !["stacked", "light", "autorun", "plan", "live", "dark", "flat", "bias"]
            .contains(&dir_name.to_lowercase().as_str())
        {
            return Some(dir_name);
        }
        current = dir.parent();
    }
    None
}

/// Run a single scan cycle
fn run_scan_cycle(
    db_pool: &crate::db::DbPool,
    user_id: &str,
    config: &AutoImportConfig,
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
    let watch_folders = &config.watch_folders;
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

    emit("scanning", "Scanning watch folders...", None, 0, 0);

    for folder in watch_folders {
        let folder_path = PathBuf::from(folder);
        if !folder_path.exists() {
            errors.push(format!("Watch folder not found: {}", folder));
            continue;
        }

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

            // Skip already imported
            if existing_urls.contains(&path_str) || existing_fits.contains(&path_str) {
                continue;
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
            let mut desc_parts = Vec::new();
            if let Some(exp) = metadata.exposure {
                desc_parts.push(format!("{:.1}s exposure", exp));
            }
            if let Some(frames) = metadata.stacked_frames {
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

            // Create image record
            let new_image = NewImage {
                id: uuid::Uuid::new_v4().to_string(),
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
                fits_url: Some(path_str),
            };

            let image_id = new_image.id.clone();
            let fits_path_str = new_image.fits_url.clone().unwrap_or_default();

            let mut conn = db_pool.get().map_err(|e| e.to_string())?;
            match repository::create_image(&mut conn, &new_image) {
                Ok(_) => {
                    imported += 1;
                    log::info!("Auto-imported: {}", new_image.filename);

                    // Generate a full-size preview JPEG via Python stretch
                    let preview_dir = path.parent().unwrap_or(Path::new("/tmp"));
                    let preview_path = preview_dir.join(
                        format!("{}_preview.jpg", path.file_stem().unwrap_or_default().to_string_lossy())
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
            let scan_result = tokio::task::spawn_blocking(move || {
                let (tx, rx) = mpsc::channel();
                // Spawn a thread to forward progress to the app
                let app_fwd = app_clone.clone();
                std::thread::spawn(move || {
                    while let Ok(progress) = rx.recv() {
                        let _ = app_fwd.emit("auto-import-progress", &progress);
                    }
                });
                run_scan_cycle(&db, &uid, &cfg, Some(&tx))
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
        run_scan_cycle(&db_pool, &user_id, &config, Some(&tx))
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
