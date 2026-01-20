//! Astra - Astronomy Observation Log
//!
//! A Tauri application for tracking and organizing astronomical imaging sessions.

use serde::{Deserialize, Serialize};
use tauri::Manager;

mod commands;
mod db;
mod python;
mod state;

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
            // Skymap commands
            commands::generate_skymap,
            commands::generate_wide_skymap,
            // Image processing commands
            commands::process_fits_image,
            commands::classify_target_type,
            commands::get_processing_defaults,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
