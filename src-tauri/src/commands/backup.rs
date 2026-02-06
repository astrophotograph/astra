/**
 * Backup and restore commands for the database
 */

use std::fs;
use std::path::PathBuf;
use chrono::Local;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::db::DbPool;

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
