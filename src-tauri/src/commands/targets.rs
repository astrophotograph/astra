//! Target browser commands for viewing images grouped by astronomical object

use tauri::State;

use crate::db::models::Image;
use crate::db::repository::{self, TargetWithCount};
use crate::state::AppState;

/// Get all unique targets with their image counts
#[tauri::command]
pub fn get_targets(state: State<'_, AppState>) -> Result<Vec<TargetWithCount>, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    repository::get_targets_with_counts(&mut conn, &state.user_id)
        .map_err(|e| e.to_string())
}

/// Search images by target name (partial match)
#[tauri::command]
pub fn search_images_by_target(
    state: State<'_, AppState>,
    query: String,
) -> Result<Vec<Image>, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    repository::search_images_by_target(&mut conn, &state.user_id, &query)
        .map_err(|e| e.to_string())
}

/// Get all images for a specific target (exact match)
#[tauri::command]
pub fn get_images_by_target(
    state: State<'_, AppState>,
    target_name: String,
) -> Result<Vec<Image>, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    repository::get_images_by_target(&mut conn, &state.user_id, &target_name)
        .map_err(|e| e.to_string())
}
