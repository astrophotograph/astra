//! Target browser commands for viewing images grouped by astronomical object
//!
//! Each `#[tauri::command]` is a thin wrapper over a `*_core` fn taking
//! explicit `db` + `user_id` so the daemon can serve the same logic without
//! Tauri. The repository fns here are user-scoped queries already — the
//! cores just carry the caller's identity through.

use tauri::State;

use crate::db::models::Image;
use crate::db::repository::{self, TargetWithCount};
use crate::db::DbPool;
use crate::state::AppState;

// ============================================================================
// Core functions (no Tauri types — shared with the daemon)
// ============================================================================

pub fn get_targets_core(db: &DbPool, user_id: &str) -> Result<Vec<TargetWithCount>, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;
    repository::get_targets_with_counts(&mut conn, user_id).map_err(|e| e.to_string())
}

pub fn search_images_by_target_core(
    db: &DbPool,
    user_id: &str,
    query: &str,
) -> Result<Vec<Image>, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;
    repository::search_images_by_target(&mut conn, user_id, query).map_err(|e| e.to_string())
}

pub fn get_images_by_target_core(
    db: &DbPool,
    user_id: &str,
    target_name: &str,
) -> Result<Vec<Image>, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;
    repository::get_images_by_target(&mut conn, user_id, target_name).map_err(|e| e.to_string())
}

// ============================================================================
// Tauri command wrappers
// ============================================================================

/// Get all unique targets with their image counts
#[tauri::command]
pub fn get_targets(state: State<'_, AppState>) -> Result<Vec<TargetWithCount>, String> {
    get_targets_core(&state.db, &state.user_id)
}

/// Search images by target name (partial match)
#[tauri::command]
pub fn search_images_by_target(
    state: State<'_, AppState>,
    query: String,
) -> Result<Vec<Image>, String> {
    search_images_by_target_core(&state.db, &state.user_id, &query)
}

/// Get all images for a specific target (exact match)
#[tauri::command]
pub fn get_images_by_target(
    state: State<'_, AppState>,
    target_name: String,
) -> Result<Vec<Image>, String> {
    get_images_by_target_core(&state.db, &state.user_id, &target_name)
}
