//! Collection commands for managing observation collections

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::models::{Collection, NewCollection, UpdateCollection};
use crate::db::repository;
use crate::state::AppState;

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateCollectionInput {
    pub name: String,
    pub description: Option<String>,
    pub visibility: Option<String>,
    pub template: Option<String>,
    pub tags: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateCollectionInput {
    pub id: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub visibility: Option<String>,
    pub template: Option<String>,
    pub favorite: Option<bool>,
    pub tags: Option<String>,
    pub metadata: Option<String>,
}

#[tauri::command]
pub fn get_collections(state: State<'_, AppState>) -> Result<Vec<Collection>, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    repository::get_collections(&mut conn, &state.user_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_collection(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<Collection>, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    repository::get_collection_by_id(&mut conn, &id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_collection(
    state: State<'_, AppState>,
    input: CreateCollectionInput,
) -> Result<Collection, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;

    let new_collection = NewCollection {
        id: uuid::Uuid::new_v4().to_string(),
        user_id: state.user_id.clone(),
        name: input.name,
        description: input.description,
        visibility: input.visibility.unwrap_or_else(|| "private".to_string()),
        template: input.template,
        favorite: false,
        tags: input.tags,
        metadata: None,
    };

    repository::create_collection(&mut conn, &new_collection)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_collection(
    state: State<'_, AppState>,
    input: UpdateCollectionInput,
) -> Result<Collection, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;

    let update = UpdateCollection {
        name: input.name,
        description: input.description,
        visibility: input.visibility,
        template: input.template,
        favorite: input.favorite,
        tags: input.tags,
        metadata: input.metadata,
    };

    repository::update_collection(&mut conn, &input.id, &update)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_collection(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    repository::delete_collection(&mut conn, &id)
        .map(|count| count > 0)
        .map_err(|e| e.to_string())
}
