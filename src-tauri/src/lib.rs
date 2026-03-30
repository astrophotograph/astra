//! Astra - Astronomy Observation Log
//!
//! A Tauri application for tracking and organizing astronomical imaging sessions.

use serde::{Deserialize, Serialize};
use tauri::Manager;

mod commands;
mod db;
mod python;
mod share;
mod state;
pub mod stretch;

use state::AppState;

/// Get application info
#[tauri::command]
fn get_app_info() -> AppInfo {
    AppInfo {
        name: "Astra".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        description: "Astronomy Observation Log".to_string(),
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub description: String,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize logging
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_geolocation::init())
        .setup(|app| {
            // Initialize database
            let db_path = db::get_database_path(app.handle());
            let db_pool = db::init_database(&db_path)
                .expect("Failed to initialize database");

            // Auto-backup on startup (keep last 5, one per launch)
            {
                let handle = app.handle().clone();
                let backup_dir = handle
                    .path()
                    .app_data_dir()
                    .map(|d| d.join("backups"));

                if let Ok(backup_dir) = backup_dir {
                    if std::fs::create_dir_all(&backup_dir).is_ok() && db_path.exists() {
                        let ts = chrono::Local::now().format("%Y%m%d_%H%M%S");
                        let dest = backup_dir.join(format!("astra_auto_{}.db", ts));
                        if let Err(e) = std::fs::copy(&db_path, &dest) {
                            log::warn!("Auto-backup failed: {}", e);
                        } else {
                            log::info!("Auto-backup created: {}", dest.display());
                            // Prune: keep only the 5 most recent auto-backups
                            if let Ok(entries) = std::fs::read_dir(&backup_dir) {
                                let mut auto_backups: Vec<std::path::PathBuf> = entries
                                    .flatten()
                                    .map(|e| e.path())
                                    .filter(|p| {
                                        p.file_name()
                                            .and_then(|n| n.to_str())
                                            .map(|n| n.starts_with("astra_auto_") && n.ends_with(".db"))
                                            .unwrap_or(false)
                                    })
                                    .collect();
                                auto_backups.sort();
                                auto_backups.reverse();
                                for old in auto_backups.into_iter().skip(5) {
                                    let _ = std::fs::remove_file(&old);
                                }
                            }
                        }
                    }
                }
            }

            // Create app state
            let app_state = AppState::new(db_pool);
            app.manage(app_state);

            // Initialize Python with path to astra_astro module
            // In development, the module is in ../python relative to src-tauri
            // In production, it should be bundled with the app
            let python_path = if cfg!(debug_assertions) {
                // Development mode: use the python directory relative to the project
                Some(std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../python"))
            } else {
                // Production mode: use the bundled resources
                app.path()
                    .resource_dir()
                    .ok()
                    .map(|p| p.join("python"))
            };

            if let Err(e) = python::init_python(python_path) {
                log::warn!("Failed to initialize Python: {}", e);
                // Don't fail - Python features will be unavailable
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_app_info,
            // Todo commands
            commands::get_todos,
            commands::get_todo,
            commands::create_todo,
            commands::update_todo,
            commands::delete_todo,
            commands::sync_todos,
            // Collection commands
            commands::get_collections,
            commands::get_collection,
            commands::create_collection,
            commands::update_collection,
            commands::delete_collection,
            // Image commands
            commands::get_images,
            commands::get_collection_images,
            commands::get_image,
            commands::create_image,
            commands::update_image,
            commands::delete_image,
            // Image-Collection relationship commands
            commands::add_image_to_collection,
            commands::remove_image_from_collection,
            commands::get_image_collections,
            commands::get_collection_image_count,
            // Image data serving commands
            commands::get_image_data,
            commands::get_image_thumbnail,
            // FITS URL population commands
            commands::populate_fits_urls,
            commands::ensure_fits_url,
            // Schedule commands
            commands::get_schedules,
            commands::get_active_schedule,
            commands::get_active_schedules,
            commands::get_schedule,
            commands::create_schedule,
            commands::update_schedule,
            commands::delete_schedule,
            commands::add_schedule_item,
            commands::remove_schedule_item,
            // Astronomy commands
            commands::lookup_astronomy_object,
            commands::calculate_object_altitude,
            commands::calculate_altitude_data,
            commands::get_sun_times,
            // Backup commands
            commands::create_backup,
            commands::list_backups,
            commands::restore_backup,
            commands::delete_backup,
            commands::export_database,
            commands::import_database,
            commands::get_image_path_prefixes,
            commands::remap_image_paths,
            // Bulk scan commands
            commands::bulk_scan_directory,
            commands::preview_bulk_scan,
            commands::cancel_scan,
            // Raw file collection commands
            commands::collect_raw_files,
            commands::cancel_collect,
            // Plate solving commands
            commands::plate_solve_image,
            commands::query_sky_region,
            commands::detect_plate_solvers,
            commands::get_solve_hints,
            // Skymap commands
            commands::generate_skymap,
            commands::generate_wide_skymap,
            // Image processing commands
            commands::process_fits_image,
            commands::classify_target_type,
            commands::get_processing_defaults,
            commands::regenerate_preview,
            commands::bulk_regenerate_previews,
            commands::get_unique_tags,
            commands::get_unique_cameras,
            commands::check_source_health,
            commands::migrate_previews_to_local,
            commands::scan_unimported_files,
            // Target browser commands
            commands::get_targets,
            commands::search_images_by_target,
            commands::get_images_by_target,
            // Share commands
            commands::configure_share_upload,
            commands::get_share_config,
            commands::test_share_upload,
            commands::clear_share_config,
            commands::publish_collection,
            commands::sync_collection,
            commands::unpublish_collection,
            commands::get_publish_status,
            // Auth commands (astra.gallery)
            commands::clerk_sign_in,
            commands::clerk_sign_out,
            commands::get_auth_session,
            // Gallery publish (authenticated)
            commands::publish_collection_gallery,
            // Auto-import commands
            commands::start_auto_import,
            commands::stop_auto_import,
            commands::get_auto_import_status,
            commands::scan_auto_import_now,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
