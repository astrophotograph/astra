//! Library maintenance: find images on disk that aren't in the database.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, State};
use walkdir::WalkDir;

use crate::db::repository;
use crate::state::AppState;

const SCAN_EMIT_FILE_INTERVAL: usize = 100;

static UNIMPORTED_SCAN_CANCELLED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanScopeEntry {
    path: String,
    contributing_images: usize,
}

/// Request cancellation of an in-flight unimported-files scan.
#[tauri::command]
pub fn cancel_unimported_scan() -> Result<(), String> {
    UNIMPORTED_SCAN_CANCELLED.store(true, Ordering::SeqCst);
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanProgressEvent {
    files_scanned: usize,
    unimported_found: usize,
    current_dir: String,
    dir_index: usize,
    dir_total: usize,
}

/// A group of unimported files sharing a common directory prefix.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnimportedGroup {
    /// Directory path prefix
    pub path: String,
    /// Number of unimported image files
    pub file_count: usize,
    /// Total size in bytes
    pub total_bytes: u64,
    /// Sample filenames (up to 5)
    pub samples: Vec<String>,
    /// File extensions found (e.g., ["fit", "jpg"])
    pub extensions: Vec<String>,
}

/// Result from scanning for unimported files.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnimportedScanResult {
    /// Directories scanned
    pub directories_scanned: usize,
    /// Total unimported files found
    pub total_files: usize,
    /// Total size of unimported files
    pub total_bytes: u64,
    /// Groups by directory prefix
    pub groups: Vec<UnimportedGroup>,
    /// True if the scan was cancelled mid-flight (results are partial)
    pub cancelled: bool,
}

/// Library-wide stats from the database.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageStats {
    pub total_images: i64,
    pub stacked_images: i64,
}

/// Get aggregate counts for the user's image library.
#[tauri::command]
pub async fn get_image_stats(state: State<'_, AppState>) -> Result<ImageStats, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    let total_images = repository::count_images_by_user(&mut conn, &state.user_id)
        .map_err(|e| e.to_string())?;
    let stacked_images = repository::count_stacked_images_by_user(&mut conn, &state.user_id)
        .map_err(|e| e.to_string())?;
    Ok(ImageStats {
        total_images,
        stacked_images,
    })
}

const IMAGE_EXTENSIONS: &[&str] = &[
    "fit", "fits", "jpg", "jpeg", "png", "tif", "tiff", "cr2", "cr3", "nef", "arw",
];

/// Scan directories for image files not in the library.
///
/// Checks known image paths from the database to determine which directories
/// to scan, then finds files in those directories that aren't tracked.
#[tauri::command]
pub async fn scan_unimported_files(
    app: AppHandle,
    state: State<'_, AppState>,
    scan_paths: Option<Vec<String>>,
    stacks_only: Option<bool>,
) -> Result<UnimportedScanResult, String> {
    let stacks_only = stacks_only.unwrap_or(false);
    UNIMPORTED_SCAN_CANCELLED.store(false, Ordering::SeqCst);
    let mut conn = state.db.get().map_err(|e| e.to_string())?;

    // Get all known image URLs and FITS URLs
    let known_urls: HashSet<String> = {
        let mut urls: HashSet<String> = repository::get_all_image_urls(&mut conn, &state.user_id)
            .map_err(|e| e.to_string())?
            .into_iter()
            .collect();
        let fits: Vec<String> = repository::get_all_fits_urls(&mut conn, &state.user_id)
            .map_err(|e| e.to_string())?;
        urls.extend(fits);
        urls
    };

    // Determine directories to scan, plus per-root contributing-image counts
    // (so the UI can spot outlier roots that came from a tiny number of test images)
    let mut dir_contributions: std::collections::HashMap<PathBuf, usize> =
        std::collections::HashMap::new();
    let dirs_to_scan: Vec<PathBuf> = if let Some(paths) = scan_paths {
        paths.iter().map(PathBuf::from).collect()
    } else {
        for url in &known_urls {
            let p = Path::new(url);
            // Walk up 3 parents to find a reasonable scan root
            if let Some(parent) = p.parent().and_then(|p| p.parent()).and_then(|p| p.parent()) {
                if parent.exists() {
                    *dir_contributions.entry(parent.to_path_buf()).or_insert(0) += 1;
                }
            }
        }
        dir_contributions.keys().cloned().collect()
    };

    // Announce the scan scope so the UI can show what's about to be walked.
    // Sort by contributing-image count ascending — outliers from test data
    // (lowest counts) sit at the top so they're easy to spot.
    let mut scan_scope: Vec<ScanScopeEntry> = dirs_to_scan
        .iter()
        .map(|d| ScanScopeEntry {
            path: d.to_string_lossy().to_string(),
            contributing_images: dir_contributions.get(d).copied().unwrap_or(0),
        })
        .collect();
    scan_scope.sort_by(|a, b| {
        a.contributing_images
            .cmp(&b.contributing_images)
            .then_with(|| a.path.cmp(&b.path))
    });
    let _ = app.emit("unimported-scan-started", &scan_scope);

    // Scan directories for image files not in the database
    let mut all_unimported: Vec<(PathBuf, u64)> = Vec::new();
    let mut files_scanned: usize = 0;
    let dir_total = dirs_to_scan.len();
    let mut cancelled = false;

    'outer: for (dir_index, dir) in dirs_to_scan.iter().enumerate() {
        if UNIMPORTED_SCAN_CANCELLED.load(Ordering::SeqCst) {
            cancelled = true;
            break 'outer;
        }
        if !dir.exists() {
            continue;
        }

        let current_dir = dir.to_string_lossy().to_string();
        let _ = app.emit(
            "unimported-scan-progress",
            ScanProgressEvent {
                files_scanned,
                unimported_found: all_unimported.len(),
                current_dir: current_dir.clone(),
                dir_index,
                dir_total,
            },
        );

        for entry in WalkDir::new(dir)
            .follow_links(true)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            files_scanned += 1;
            if files_scanned % SCAN_EMIT_FILE_INTERVAL == 0 {
                if UNIMPORTED_SCAN_CANCELLED.load(Ordering::SeqCst) {
                    cancelled = true;
                    break 'outer;
                }
                let _ = app.emit(
                    "unimported-scan-progress",
                    ScanProgressEvent {
                        files_scanned,
                        unimported_found: all_unimported.len(),
                        current_dir: current_dir.clone(),
                        dir_index,
                        dir_total,
                    },
                );
            }

            // Check extension
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_lowercase())
                .unwrap_or_default();
            if !IMAGE_EXTENSIONS.contains(&ext.as_str()) {
                continue;
            }

            // Skip subframes, calibration, and temporary files
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            let name_lower = name.to_lowercase();
            if name_lower.starts_with(".")
                || name_lower.contains("_sub")
                || name_lower.starts_with("light_")
                || name_lower.starts_with("dark_")
                || name_lower.starts_with("flat_")
                || name_lower.starts_with("bias_")
                || name_lower.ends_with("_thn.jpg")
            {
                continue;
            }

            // Stacks-only filter: keep only files matching the stack heuristic
            // (filenames starting with "stacked" — same rule the import scan uses)
            if stacks_only && !name_lower.starts_with("stacked") {
                continue;
            }

            // Check if already in library
            let path_str = path.to_string_lossy().to_string();
            if known_urls.contains(&path_str) {
                continue;
            }

            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            all_unimported.push((path.to_path_buf(), size));
        }
    }

    let _ = app.emit(
        "unimported-scan-progress",
        ScanProgressEvent {
            files_scanned,
            unimported_found: all_unimported.len(),
            current_dir: String::new(),
            dir_index: dir_total,
            dir_total,
        },
    );

    // Group by parent directory
    let mut groups_map: std::collections::HashMap<String, Vec<(PathBuf, u64)>> =
        std::collections::HashMap::new();

    for (path, size) in &all_unimported {
        let parent = path
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        groups_map
            .entry(parent)
            .or_default()
            .push((path.clone(), *size));
    }

    let mut groups: Vec<UnimportedGroup> = groups_map
        .into_iter()
        .map(|(path, files)| {
            let total_bytes: u64 = files.iter().map(|(_, s)| s).sum();
            let samples: Vec<String> = files
                .iter()
                .take(5)
                .map(|(p, _)| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("")
                        .to_string()
                })
                .collect();
            let extensions: Vec<String> = {
                let mut exts: HashSet<String> = files
                    .iter()
                    .filter_map(|(p, _)| {
                        p.extension()
                            .and_then(|e| e.to_str())
                            .map(|e| e.to_lowercase())
                    })
                    .collect();
                let mut v: Vec<String> = exts.drain().collect();
                v.sort();
                v
            };

            UnimportedGroup {
                path,
                file_count: files.len(),
                total_bytes,
                samples,
                extensions,
            }
        })
        .collect();

    groups.sort_by(|a, b| b.file_count.cmp(&a.file_count));

    let total_files = all_unimported.len();
    let total_bytes: u64 = all_unimported.iter().map(|(_, s)| s).sum();

    Ok(UnimportedScanResult {
        directories_scanned: dirs_to_scan.len(),
        total_files,
        total_bytes,
        groups,
        cancelled,
    })
}
