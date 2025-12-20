//! Image commands for managing astronomical images

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::models::{Image, NewImage, UpdateImage};
use crate::db::repository;
use crate::state::AppState;

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateImageInput {
    pub collection_id: Option<String>,
    pub filename: String,
    pub url: Option<String>,
    pub summary: Option<String>,
    pub description: Option<String>,
    pub content_type: Option<String>,
    pub tags: Option<String>,
    pub visibility: Option<String>,
    pub location: Option<String>,
    pub annotations: Option<String>,
    pub metadata: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateImageInput {
    pub id: String,
    pub collection_id: Option<String>,
    pub filename: Option<String>,
    pub url: Option<String>,
    pub summary: Option<String>,
    pub description: Option<String>,
    pub content_type: Option<String>,
    pub favorite: Option<bool>,
    pub tags: Option<String>,
    pub visibility: Option<String>,
    pub location: Option<String>,
    pub annotations: Option<String>,
    pub metadata: Option<String>,
}

#[tauri::command]
pub fn get_images(state: State<'_, AppState>) -> Result<Vec<Image>, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    repository::get_images_by_user(&mut conn, &state.user_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_collection_images(
    state: State<'_, AppState>,
    collection_id: String,
) -> Result<Vec<Image>, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    repository::get_images_by_collection(&mut conn, &collection_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_image(state: State<'_, AppState>, id: String) -> Result<Option<Image>, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    repository::get_image_by_id(&mut conn, &id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_image(
    state: State<'_, AppState>,
    input: CreateImageInput,
) -> Result<Image, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;

    let new_image = NewImage {
        id: uuid::Uuid::new_v4().to_string(),
        user_id: state.user_id.clone(),
        collection_id: input.collection_id,
        filename: input.filename,
        url: input.url,
        summary: input.summary,
        description: input.description,
        content_type: input.content_type.or(Some("image/jpeg".to_string())),
        favorite: false,
        tags: input.tags,
        visibility: input.visibility.or(Some("private".to_string())),
        location: input.location,
        annotations: input.annotations,
        metadata: input.metadata,
    };

    repository::create_image(&mut conn, &new_image)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_image(
    state: State<'_, AppState>,
    input: UpdateImageInput,
) -> Result<Image, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;

    let update = UpdateImage {
        collection_id: input.collection_id,
        filename: input.filename,
        url: input.url,
        summary: input.summary,
        description: input.description,
        content_type: input.content_type,
        favorite: input.favorite,
        tags: input.tags,
        visibility: input.visibility,
        location: input.location,
        annotations: input.annotations,
        metadata: input.metadata,
    };

    repository::update_image(&mut conn, &input.id, &update)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_image(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    repository::delete_image(&mut conn, &id)
        .map(|count| count > 0)
        .map_err(|e| e.to_string())
}
