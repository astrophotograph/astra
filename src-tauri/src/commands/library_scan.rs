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
pub struct ScanScopeEntry {
    pub path: String,
    pub contributing_images: usize,
}

/// All image + FITS paths the library already tracks for a user.
fn load_known_urls(
    conn: &mut diesel::SqliteConnection,
    user_id: &str,
) -> Result<HashSet<String>, String> {
    let mut urls: HashSet<String> = repository::get_all_image_urls(conn, user_id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .collect();
    urls.extend(
        repository::get_all_fits_urls(conn, user_id)
            .map_err(|e| e.to_string())?,
    );
    Ok(urls)
}

/// The legacy root heuristic: walk up 3 parents from each tracked file and
/// count how many images each surviving directory contributes. Only used to
/// bootstrap the curated scan-roots list now — never as a scan fallback.
fn derive_roots_from_urls(
    known_urls: &HashSet<String>,
) -> std::collections::HashMap<PathBuf, usize> {
    let mut contributions: std::collections::HashMap<PathBuf, usize> =
        std::collections::HashMap::new();
    for url in known_urls {
        let p = Path::new(url);
        if let Some(parent) = p.parent().and_then(|p| p.parent()).and_then(|p| p.parent()) {
            if parent.exists() {
                *contributions.entry(parent.to_path_buf()).or_insert(0) += 1;
            }
        }
    }
    contributions
}

/// Directories a scan will walk: explicit paths win; otherwise the user's
/// persisted scan roots. An empty roots list scans nothing — the curated
/// list in Settings is the single source of scope.
fn resolve_scan_dirs(
    conn: &mut diesel::SqliteConnection,
    user_id: &str,
    scan_paths: Option<Vec<String>>,
) -> Result<Vec<PathBuf>, String> {
    match scan_paths {
        Some(paths) => Ok(paths.iter().map(PathBuf::from).collect()),
        None => Ok(repository::get_scan_roots(conn, user_id)
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(PathBuf::from)
            .collect()),
    }
}

/// Reject empty or relative scan-root paths; trim trailing slashes.
fn normalized_root(path: &str) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Scan root path is empty".to_string());
    }
    if !Path::new(trimmed).is_absolute() {
        return Err(format!("Scan root must be an absolute path: {trimmed}"));
    }
    let stripped = if trimmed.len() > 1 {
        trimmed.trim_end_matches('/')
    } else {
        trimmed
    };
    Ok(stripped.to_string())
}

/// Get the user's persisted scan roots.
#[tauri::command]
pub async fn get_scan_roots(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    repository::get_scan_roots(&mut conn, &state.user_id).map_err(|e| e.to_string())
}

/// Add one scan root; returns the updated list.
#[tauri::command]
pub async fn add_scan_root(
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<String>, String> {
    let path = normalized_root(&path)?;
    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    repository::add_scan_root(&mut conn, &state.user_id, &path).map_err(|e| e.to_string())?;
    repository::get_scan_roots(&mut conn, &state.user_id).map_err(|e| e.to_string())
}

/// Remove one scan root by exact path; returns the updated list.
#[tauri::command]
pub async fn remove_scan_root(
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<String>, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    repository::remove_scan_root(&mut conn, &state.user_id, &path).map_err(|e| e.to_string())?;
    repository::get_scan_roots(&mut conn, &state.user_id).map_err(|e| e.to_string())
}

/// Replace the scan-roots list wholesale; returns the persisted list.
#[tauri::command]
pub async fn set_scan_roots(
    state: State<'_, AppState>,
    roots: Vec<String>,
) -> Result<Vec<String>, String> {
    let normalized: Vec<String> = roots
        .iter()
        .map(|r| normalized_root(r))
        .collect::<Result<_, _>>()?;
    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    repository::set_scan_roots(&mut conn, &state.user_id, &normalized)
        .map_err(|e| e.to_string())?;
    repository::get_scan_roots(&mut conn, &state.user_id).map_err(|e| e.to_string())
}

/// Run the legacy 3-parents-up derivation over the current library and return
/// candidate roots with contributing-image counts, WITHOUT persisting anything.
/// The UI uses this to bootstrap the curated list.
#[tauri::command]
pub async fn derive_scan_roots(
    state: State<'_, AppState>,
) -> Result<Vec<ScanScopeEntry>, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    let known_urls = load_known_urls(&mut conn, &state.user_id)?;
    let mut entries: Vec<ScanScopeEntry> = derive_roots_from_urls(&known_urls)
        .into_iter()
        .map(|(path, contributing_images)| ScanScopeEntry {
            path: path.to_string_lossy().to_string(),
            contributing_images,
        })
        .collect();
    // Highest contributors first — those are the roots most worth keeping.
    entries.sort_by(|a, b| {
        b.contributing_images
            .cmp(&a.contributing_images)
            .then_with(|| a.path.cmp(&b.path))
    });
    Ok(entries)
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
    let known_urls = load_known_urls(&mut conn, &state.user_id)?;

    // Explicit paths win; otherwise the user's curated scan roots.
    // No auto-derivation fallback — an empty roots list scans nothing.
    let dirs_to_scan = resolve_scan_dirs(&mut conn, &state.user_id, scan_paths)?;

    // Announce the scan scope so the UI can show what's about to be walked.
    let mut scan_scope: Vec<ScanScopeEntry> = dirs_to_scan
        .iter()
        .map(|d| ScanScopeEntry {
            path: d.to_string_lossy().to_string(),
            contributing_images: 0,
        })
        .collect();
    scan_scope.sort_by(|a, b| a.path.cmp(&b.path));
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::{insert_user, test_pool};

    #[test]
    fn scan_roots_crud_is_tenant_scoped() {
        let pool = test_pool();
        insert_user(&pool, "u1");
        insert_user(&pool, "u2");
        let mut conn = pool.get().unwrap();

        repository::add_scan_root(&mut conn, "u1", "/data/astro").unwrap();
        repository::add_scan_root(&mut conn, "u1", "/data/astro").unwrap(); // idempotent
        repository::add_scan_root(&mut conn, "u2", "/other").unwrap();

        assert_eq!(
            repository::get_scan_roots(&mut conn, "u1").unwrap(),
            vec!["/data/astro"]
        );
        assert_eq!(
            repository::get_scan_roots(&mut conn, "u2").unwrap(),
            vec!["/other"]
        );

        repository::set_scan_roots(&mut conn, "u1", &["/b".to_string(), "/a".to_string()])
            .unwrap();
        assert_eq!(
            repository::get_scan_roots(&mut conn, "u1").unwrap(),
            vec!["/a", "/b"]
        );

        assert_eq!(repository::remove_scan_root(&mut conn, "u1", "/a").unwrap(), 1);
        assert_eq!(
            repository::get_scan_roots(&mut conn, "u1").unwrap(),
            vec!["/b"]
        );
        assert_eq!(
            repository::get_scan_roots(&mut conn, "u2").unwrap(),
            vec!["/other"]
        );
    }

    #[test]
    fn resolve_dirs_prefers_explicit_then_roots_then_empty() {
        let pool = test_pool();
        insert_user(&pool, "u1");
        let mut conn = pool.get().unwrap();

        repository::add_scan_root(&mut conn, "u1", "/roots/a").unwrap();

        // Explicit paths win even when roots exist
        let dirs =
            resolve_scan_dirs(&mut conn, "u1", Some(vec!["/explicit".to_string()])).unwrap();
        assert_eq!(dirs, vec![PathBuf::from("/explicit")]);

        // None → persisted roots
        let dirs = resolve_scan_dirs(&mut conn, "u1", None).unwrap();
        assert_eq!(dirs, vec![PathBuf::from("/roots/a")]);

        // No roots → empty scope, no auto-derive fallback
        repository::remove_scan_root(&mut conn, "u1", "/roots/a").unwrap();
        let dirs = resolve_scan_dirs(&mut conn, "u1", None).unwrap();
        assert!(dirs.is_empty());
    }

    #[test]
    fn normalized_root_validates_and_trims() {
        assert_eq!(normalized_root(" /data/astro/ ").unwrap(), "/data/astro");
        assert_eq!(normalized_root("/").unwrap(), "/");
        assert!(normalized_root("").is_err());
        assert!(normalized_root("   ").is_err());
        assert!(normalized_root("relative/path").is_err());
    }

    #[test]
    fn derive_walks_three_parents_up_and_counts() {
        let tmp = tempfile::TempDir::new().unwrap();
        let deep = tmp.path().join("captures/2026-08/M31/lights");
        std::fs::create_dir_all(&deep).unwrap();

        let mut urls = HashSet::new();
        urls.insert(
            deep.join("stacked1.fits").to_string_lossy().to_string(),
        );
        urls.insert(
            deep.join("stacked2.fits").to_string_lossy().to_string(),
        );

        let contributions = derive_roots_from_urls(&urls);
        let expected_root = tmp.path().join("captures/2026-08");
        assert_eq!(contributions.get(&expected_root), Some(&2));
        assert_eq!(contributions.len(), 1);
    }
}
