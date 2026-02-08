/**
 * Backup and restore commands for the database
 */

use std::fs;
use std::path::PathBuf;
use chrono::Local;
use diesel::prelude::*;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::state::AppState;

#[derive(Debug, Serialize, Deserialize)]
pub struct BackupInfo {
    pub filename: String,
    pub path: String,
    pub size_bytes: u64,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BackupResult {
    pub success: bool,
    pub message: String,
    pub backup_info: Option<BackupInfo>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RestoreResult {
    pub success: bool,
    pub message: String,
}

/// Get the backup directory path
fn get_backup_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    let backup_dir = app_data_dir.join("backups");

    // Create backup directory if it doesn't exist
    if !backup_dir.exists() {
        fs::create_dir_all(&backup_dir)
            .map_err(|e| format!("Failed to create backup directory: {}", e))?;
    }

    Ok(backup_dir)
}

/// Get the database path
fn get_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    Ok(app_data_dir.join("astra.db"))
}

/// Create a backup of the database
#[tauri::command]
pub fn create_backup(app: AppHandle) -> Result<BackupResult, String> {
    let db_path = get_db_path(&app)?;
    let backup_dir = get_backup_dir(&app)?;

    // Check if database exists
    if !db_path.exists() {
        return Ok(BackupResult {
            success: false,
            message: "Database file not found".to_string(),
            backup_info: None,
        });
    }

    // Generate backup filename with timestamp
    let timestamp = Local::now().format("%Y%m%d_%H%M%S");
    let backup_filename = format!("astra_backup_{}.db", timestamp);
    let backup_path = backup_dir.join(&backup_filename);

    // Copy database file to backup location
    fs::copy(&db_path, &backup_path)
        .map_err(|e| format!("Failed to create backup: {}", e))?;

    // Get file metadata
    let metadata = fs::metadata(&backup_path)
        .map_err(|e| format!("Failed to get backup metadata: {}", e))?;

    let backup_info = BackupInfo {
        filename: backup_filename,
        path: backup_path.to_string_lossy().to_string(),
        size_bytes: metadata.len(),
        created_at: Local::now().to_rfc3339(),
    };

    Ok(BackupResult {
        success: true,
        message: "Backup created successfully".to_string(),
        backup_info: Some(backup_info),
    })
}

/// List all available backups
#[tauri::command]
pub fn list_backups(app: AppHandle) -> Result<Vec<BackupInfo>, String> {
    let backup_dir = get_backup_dir(&app)?;

    let mut backups: Vec<BackupInfo> = Vec::new();

    if let Ok(entries) = fs::read_dir(&backup_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map_or(false, |ext| ext == "db") {
                if let Ok(metadata) = fs::metadata(&path) {
                    let filename = path.file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();

                    let created_at = metadata.created()
                        .or_else(|_| metadata.modified())
                        .map(|t| {
                            chrono::DateTime::<Local>::from(t).to_rfc3339()
                        })
                        .unwrap_or_else(|_| "Unknown".to_string());

                    backups.push(BackupInfo {
                        filename,
                        path: path.to_string_lossy().to_string(),
                        size_bytes: metadata.len(),
                        created_at,
                    });
                }
            }
        }
    }

    // Sort by created_at descending (newest first)
    backups.sort_by(|a, b| b.created_at.cmp(&a.created_at));

    Ok(backups)
}

/// Restore database from a backup
#[tauri::command]
pub fn restore_backup(app: AppHandle, backup_path: String) -> Result<RestoreResult, String> {
    let db_path = get_db_path(&app)?;
    let backup_file = PathBuf::from(&backup_path);

    // Validate backup file exists
    if !backup_file.exists() {
        return Ok(RestoreResult {
            success: false,
            message: "Backup file not found".to_string(),
        });
    }

    // Validate it's a .db file
    if backup_file.extension().map_or(true, |ext| ext != "db") {
        return Ok(RestoreResult {
            success: false,
            message: "Invalid backup file format".to_string(),
        });
    }

    // Create a backup of current database before restoring
    let timestamp = Local::now().format("%Y%m%d_%H%M%S");
    let pre_restore_backup = db_path.with_file_name(format!("astra_pre_restore_{}.db", timestamp));

    if db_path.exists() {
        fs::copy(&db_path, &pre_restore_backup)
            .map_err(|e| format!("Failed to backup current database: {}", e))?;
    }

    // Copy backup to database location
    fs::copy(&backup_file, &db_path)
        .map_err(|e| format!("Failed to restore backup: {}", e))?;

    Ok(RestoreResult {
        success: true,
        message: format!("Database restored from backup. Previous database saved as {:?}", pre_restore_backup.file_name()),
    })
}

/// Delete a backup file
#[tauri::command]
pub fn delete_backup(app: AppHandle, backup_path: String) -> Result<RestoreResult, String> {
    let backup_dir = get_backup_dir(&app)?;
    let backup_file = PathBuf::from(&backup_path);

    // Security check: ensure the backup file is within the backup directory
    if !backup_file.starts_with(&backup_dir) {
        return Ok(RestoreResult {
            success: false,
            message: "Invalid backup path".to_string(),
        });
    }

    // Validate it's a .db file
    if backup_file.extension().map_or(true, |ext| ext != "db") {
        return Ok(RestoreResult {
            success: false,
            message: "Invalid backup file format".to_string(),
        });
    }

    if !backup_file.exists() {
        return Ok(RestoreResult {
            success: false,
            message: "Backup file not found".to_string(),
        });
    }

    fs::remove_file(&backup_file)
        .map_err(|e| format!("Failed to delete backup: {}", e))?;

    Ok(RestoreResult {
        success: true,
        message: "Backup deleted successfully".to_string(),
    })
}

/// Export database to a custom location
#[tauri::command]
pub fn export_database(app: AppHandle, export_path: String) -> Result<BackupResult, String> {
    let db_path = get_db_path(&app)?;
    let export_file = PathBuf::from(&export_path);

    // Check if database exists
    if !db_path.exists() {
        return Ok(BackupResult {
            success: false,
            message: "Database file not found".to_string(),
            backup_info: None,
        });
    }

    // Copy database file to export location
    fs::copy(&db_path, &export_file)
        .map_err(|e| format!("Failed to export database: {}", e))?;

    // Get file metadata
    let metadata = fs::metadata(&export_file)
        .map_err(|e| format!("Failed to get export metadata: {}", e))?;

    let backup_info = BackupInfo {
        filename: export_file.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        path: export_file.to_string_lossy().to_string(),
        size_bytes: metadata.len(),
        created_at: Local::now().to_rfc3339(),
    };

    Ok(BackupResult {
        success: true,
        message: "Database exported successfully".to_string(),
        backup_info: Some(backup_info),
    })
}

/// Import database from a custom location
#[tauri::command]
pub fn import_database(app: AppHandle, import_path: String) -> Result<RestoreResult, String> {
    restore_backup(app, import_path)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PathPrefix {
    pub prefix: String,
    pub count: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RemapResult {
    pub success: bool,
    pub urls_updated: i64,
    pub fits_urls_updated: i64,
    pub message: String,
}

/// Get common path prefixes from image URLs in the database.
/// Useful after importing a backup from another computer to identify
/// paths that need remapping.
#[tauri::command]
pub fn get_image_path_prefixes(state: State<'_, AppState>) -> Result<Vec<PathPrefix>, String> {
    use crate::db::schema::images::dsl::*;

    let mut conn = state.db.get().map_err(|e| e.to_string())?;

    // Get all non-null URL values
    let urls_list: Vec<Option<String>> = images
        .select(url)
        .filter(url.is_not_null())
        .load(&mut conn)
        .map_err(|e| format!("Failed to query images: {}", e))?;

    // Extract directory prefixes (up to 3 levels deep)
    let mut prefix_counts: std::collections::HashMap<String, i64> = std::collections::HashMap::new();

    for u in urls_list.iter().flatten() {
        let path = PathBuf::from(u);
        // Get the parent directory of the file, then take up to the first 3 components
        if let Some(parent) = path.parent() {
            let components: Vec<&str> = parent
                .components()
                .filter_map(|c| c.as_os_str().to_str())
                .collect();
            // Build prefixes at different depths
            let mut prefix = String::new();
            for (i, comp) in components.iter().enumerate() {
                if i == 0 && parent.is_absolute() {
                    prefix = format!("/{}", comp);
                } else if i == 0 {
                    prefix = comp.to_string();
                } else {
                    prefix = format!("{}/{}", prefix, comp);
                }
                // Record prefixes at depth 2-4 (meaningful directory levels)
                if i >= 1 && i <= 3 {
                    *prefix_counts.entry(prefix.clone()).or_insert(0) += 1;
                }
            }
        }
    }

    // Filter to prefixes that cover a meaningful number of images
    let total = urls_list.len() as i64;
    let threshold = std::cmp::max(1, total / 10); // at least 10% of images

    let mut prefixes: Vec<PathPrefix> = prefix_counts
        .into_iter()
        .filter(|(_, count)| *count >= threshold)
        .map(|(prefix, count)| PathPrefix { prefix, count })
        .collect();

    prefixes.sort_by(|a, b| b.count.cmp(&a.count));
    // Keep top results
    prefixes.truncate(20);

    Ok(prefixes)
}

/// Remap image file paths in the database.
/// Replaces old_prefix with new_prefix in both url and fits_url fields.
/// This is needed when restoring a backup from another computer where
/// image files are stored at a different path.
#[tauri::command]
pub fn remap_image_paths(
    state: State<'_, AppState>,
    old_prefix: String,
    new_prefix: String,
) -> Result<RemapResult, String> {
    use crate::db::schema::images::dsl::*;

    if old_prefix.is_empty() {
        return Err("Old prefix cannot be empty".to_string());
    }

    let mut conn = state.db.get().map_err(|e| e.to_string())?;

    // Get all images with URLs that start with old_prefix
    let matching_images: Vec<(String, Option<String>, Option<String>)> = images
        .select((id, url, fits_url))
        .filter(url.like(format!("{}%", old_prefix)))
        .or_filter(fits_url.like(format!("{}%", old_prefix)))
        .load(&mut conn)
        .map_err(|e| format!("Failed to query images: {}", e))?;

    let mut urls_updated: i64 = 0;
    let mut fits_updated: i64 = 0;

    for (img_id, img_url, img_fits) in &matching_images {
        let mut update_url: Option<String> = None;
        let mut update_fits: Option<String> = None;

        if let Some(u) = img_url {
            if u.starts_with(&old_prefix) {
                update_url = Some(format!("{}{}", new_prefix, &u[old_prefix.len()..]));
                urls_updated += 1;
            }
        }

        if let Some(f) = img_fits {
            if f.starts_with(&old_prefix) {
                update_fits = Some(format!("{}{}", new_prefix, &f[old_prefix.len()..]));
                fits_updated += 1;
            }
        }

        if update_url.is_some() || update_fits.is_some() {
            let target = images.filter(id.eq(img_id));
            if let Some(new_url) = update_url {
                diesel::update(target.clone())
                    .set(url.eq(new_url))
                    .execute(&mut conn)
                    .map_err(|e| format!("Failed to update image URL: {}", e))?;
            }
            if let Some(new_fits) = update_fits {
                diesel::update(target)
                    .set(fits_url.eq(new_fits))
                    .execute(&mut conn)
                    .map_err(|e| format!("Failed to update FITS URL: {}", e))?;
            }
        }
    }

    Ok(RemapResult {
        success: true,
        urls_updated,
        fits_urls_updated: fits_updated,
        message: format!(
            "Remapped {} image URLs and {} FITS URLs from '{}' to '{}'",
            urls_updated, fits_updated, old_prefix, new_prefix
        ),
    })
}
