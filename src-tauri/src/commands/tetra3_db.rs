//! Tetra3 database downloads from astra.gallery.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;

const TETRA3_BASE_URL: &str = "https://astra.gallery/downloads/tetra3";
const EMIT_BYTES_THRESHOLD: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgressEvent {
    filename: String,
    downloaded: u64,
    total: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResult {
    pub path: String,
    pub bytes: u64,
}

/// Download a tetra3 database from astra.gallery into the app data dir.
/// Streams to disk and emits `tetra3-download-progress` events (every ~4 MB
/// plus a final 100% event).
#[tauri::command]
pub async fn download_tetra3_db(
    app: AppHandle,
    filename: String,
) -> Result<DownloadResult, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    let tetra3_dir = app_data.join("tetra3");
    tokio::fs::create_dir_all(&tetra3_dir)
        .await
        .map_err(|e| format!("create dir: {e}"))?;
    let dest_path = tetra3_dir.join(&filename);

    let url = format!("{TETRA3_BASE_URL}/{filename}");
    let client = reqwest::Client::new();
    let mut response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("request: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }
    let total = response.content_length().unwrap_or(0);

    let mut file = tokio::fs::File::create(&dest_path)
        .await
        .map_err(|e| format!("create file: {e}"))?;

    let _ = app.emit(
        "tetra3-download-progress",
        DownloadProgressEvent {
            filename: filename.clone(),
            downloaded: 0,
            total,
        },
    );

    let mut downloaded: u64 = 0;
    let mut last_emit: u64 = 0;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("read chunk: {e}"))?
    {
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("write: {e}"))?;
        downloaded += chunk.len() as u64;
        if downloaded - last_emit >= EMIT_BYTES_THRESHOLD {
            let _ = app.emit(
                "tetra3-download-progress",
                DownloadProgressEvent {
                    filename: filename.clone(),
                    downloaded,
                    total,
                },
            );
            last_emit = downloaded;
        }
    }
    file.flush().await.map_err(|e| format!("flush: {e}"))?;

    let _ = app.emit(
        "tetra3-download-progress",
        DownloadProgressEvent {
            filename: filename.clone(),
            downloaded,
            total: total.max(downloaded),
        },
    );

    Ok(DownloadResult {
        path: dest_path.to_string_lossy().to_string(),
        bytes: downloaded,
    })
}
