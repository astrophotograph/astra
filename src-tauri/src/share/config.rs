//! Gallery daemon connection configuration persistence.
//!
//! Replaces the worker-era S3 share config (`share-config.json`) — the
//! desktop now publishes by pushing to the Astra daemon with a personal
//! access token. An orphaned `share-config.json` from older versions is
//! ignored and harmless.

use serde::{Deserialize, Serialize};
use std::path::Path;

/// Connection to the hosted Astra daemon.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GalleryDaemonConfig {
    /// Daemon base URL (e.g. "https://astra.gallery" or "http://127.0.0.1:27872").
    pub base_url: String,
    /// Personal access token minted by `astra_daemon --mint-token`.
    pub token: String,
}

const CONFIG_FILENAME: &str = "gallery-daemon.json";

pub fn load_config(data_dir: &Path) -> Result<Option<GalleryDaemonConfig>, String> {
    let path = data_dir.join(CONFIG_FILENAME);
    if !path.exists() {
        return Ok(None);
    }
    let data = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read gallery daemon config: {e}"))?;
    let config: GalleryDaemonConfig = serde_json::from_str(&data)
        .map_err(|e| format!("Failed to parse gallery daemon config: {e}"))?;
    Ok(Some(config))
}

pub fn save_config(data_dir: &Path, config: &GalleryDaemonConfig) -> Result<(), String> {
    let path = data_dir.join(CONFIG_FILENAME);
    let data = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize gallery daemon config: {e}"))?;
    std::fs::write(&path, data)
        .map_err(|e| format!("Failed to write gallery daemon config: {e}"))?;
    Ok(())
}

pub fn delete_config(data_dir: &Path) -> Result<(), String> {
    let path = data_dir.join(CONFIG_FILENAME);
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|e| format!("Failed to delete gallery daemon config: {e}"))?;
    }
    Ok(())
}
