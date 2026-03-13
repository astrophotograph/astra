//! Share upload configuration persistence.

use serde::{Deserialize, Serialize};
use std::path::Path;

/// Configuration for uploading shares to S3-compatible storage.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareUploadConfig {
    /// S3-compatible endpoint URL (e.g. "https://<account>.r2.cloudflarestorage.com")
    pub endpoint_url: String,
    /// Bucket name
    pub bucket: String,
    /// AWS region (use "auto" for Cloudflare R2)
    pub region: String,
    /// Key prefix for uploaded objects (e.g. "shares/")
    pub path_prefix: String,
    /// Base URL for public access (e.g. "https://astra.gallery")
    pub public_url_base: String,
}

const CONFIG_FILENAME: &str = "share-config.json";

/// Load share config from app data directory.
pub fn load_config(data_dir: &Path) -> Result<Option<ShareUploadConfig>, String> {
    let path = data_dir.join(CONFIG_FILENAME);
    if !path.exists() {
        return Ok(None);
    }
    let data = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read share config: {}", e))?;
    let config: ShareUploadConfig =
        serde_json::from_str(&data).map_err(|e| format!("Failed to parse share config: {}", e))?;
    Ok(Some(config))
}

/// Save share config to app data directory.
pub fn save_config(data_dir: &Path, config: &ShareUploadConfig) -> Result<(), String> {
    let path = data_dir.join(CONFIG_FILENAME);
    let data = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize share config: {}", e))?;
    std::fs::write(&path, data).map_err(|e| format!("Failed to write share config: {}", e))?;
    Ok(())
}

/// Delete share config from app data directory.
pub fn delete_config(data_dir: &Path) -> Result<(), String> {
    let path = data_dir.join(CONFIG_FILENAME);
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|e| format!("Failed to delete share config: {}", e))?;
    }
    Ok(())
}
