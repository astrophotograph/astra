//! Library maintenance: find images on disk that aren't in the database.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::State;
use walkdir::WalkDir;

use crate::db::repository;
use crate::state::AppState;

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
    state: State<'_, AppState>,
    scan_paths: Option<Vec<String>>,
) -> Result<UnimportedScanResult, String> {
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

    // Determine directories to scan
    let dirs_to_scan: Vec<PathBuf> = if let Some(paths) = scan_paths {
        paths.iter().map(PathBuf::from).collect()
    } else {
        // Extract unique top-level directories from known image paths (3 levels deep)
        let mut dir_set: HashSet<PathBuf> = HashSet::new();
        for url in &known_urls {
            let p = Path::new(url);
            // Walk up to find a reasonable parent (3 levels above the file)
            if let Some(parent) = p.parent().and_then(|p| p.parent()).and_then(|p| p.parent()) {
                if parent.exists() {
                    dir_set.insert(parent.to_path_buf());
                }
            }
        }
        dir_set.into_iter().collect()
    };

    // Scan directories for image files not in the database
    let mut all_unimported: Vec<(PathBuf, u64)> = Vec::new();

    for dir in &dirs_to_scan {
        if !dir.exists() {
            continue;
        }

        for entry in WalkDir::new(dir)
            .follow_links(true)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            let path = entry.path();
            if !path.is_file() {
                continue;
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
            {
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
    })
}
