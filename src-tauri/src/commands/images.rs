//! Image commands for managing astronomical images

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use tauri::State;

use crate::db::models::{Collection, Image, NewCollectionImage, NewImage, UpdateImage};
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
    pub thumbnail: Option<String>,
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
    pub thumbnail: Option<String>,
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
    log::info!("get_collection_images called with collection_id: {}", collection_id);
    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    // Use the many-to-many join table to get images
    let result = repository::get_images_in_collection(&mut conn, &collection_id);
    match &result {
        Ok(images) => log::info!("get_collection_images returning {} images", images.len()),
        Err(e) => log::error!("get_collection_images error: {}", e),
    }
    result.map_err(|e| e.to_string())
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
        thumbnail: input.thumbnail,
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
        thumbnail: input.thumbnail,
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

// ============================================================================
// Image-Collection Many-to-Many Commands
// ============================================================================

#[tauri::command]
pub fn add_image_to_collection(
    state: State<'_, AppState>,
    image_id: String,
    collection_id: String,
) -> Result<bool, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;

    // Check if already in collection
    let already_exists = repository::is_image_in_collection(&mut conn, &collection_id, &image_id)
        .map_err(|e| e.to_string())?;

    if already_exists {
        return Ok(false); // Already in collection
    }

    let new_entry = NewCollectionImage {
        id: uuid::Uuid::new_v4().to_string(),
        collection_id,
        image_id,
    };

    repository::add_image_to_collection(&mut conn, &new_entry)
        .map(|_| true)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_image_from_collection(
    state: State<'_, AppState>,
    image_id: String,
    collection_id: String,
) -> Result<bool, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    repository::remove_image_from_collection(&mut conn, &collection_id, &image_id)
        .map(|count| count > 0)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_image_collections(
    state: State<'_, AppState>,
    image_id: String,
) -> Result<Vec<Collection>, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    repository::get_collections_for_image(&mut conn, &image_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_collection_image_count(
    state: State<'_, AppState>,
    collection_id: String,
) -> Result<i64, String> {
    log::info!("get_collection_image_count called with collection_id: {}", collection_id);
    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    let result = repository::get_collection_image_count(&mut conn, &collection_id);
    match &result {
        Ok(count) => log::info!("get_collection_image_count returning: {}", count),
        Err(e) => log::error!("get_collection_image_count error: {}", e),
    }
    result.map_err(|e| e.to_string())
}

// ============================================================================
// Image Data Serving Commands
// ============================================================================

/// Get the full image data as a base64 data URL
#[tauri::command]
pub fn get_image_data(state: State<'_, AppState>, id: String) -> Result<String, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;

    // Get the image record
    let image = repository::get_image_by_id(&mut conn, &id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Image not found: {}", id))?;

    // Get the file path from url field
    let file_path = image.url.as_ref()
        .ok_or_else(|| "Image has no file path".to_string())?;

    let path = Path::new(file_path);
    if !path.exists() {
        return Err(format!("Image file not found: {}", file_path));
    }

    // Read the file
    let data = fs::read(path)
        .map_err(|e| format!("Failed to read image file: {}", e))?;

    // Determine content type
    let content_type = image.content_type
        .as_deref()
        .unwrap_or_else(|| {
            match path.extension().and_then(|e| e.to_str()) {
                Some("jpg") | Some("jpeg") => "image/jpeg",
                Some("png") => "image/png",
                Some("gif") => "image/gif",
                Some("webp") => "image/webp",
                Some("fit") | Some("fits") => "image/fits",
                _ => "application/octet-stream",
            }
        });

    // Encode as base64 data URL
    let base64_data = BASE64.encode(&data);
    Ok(format!("data:{};base64,{}", content_type, base64_data))
}

/// Get the thumbnail for an image (returns the stored thumbnail or generates one)
#[tauri::command]
pub fn get_image_thumbnail(state: State<'_, AppState>, id: String) -> Result<String, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;

    // Get the image record
    let image = repository::get_image_by_id(&mut conn, &id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Image not found: {}", id))?;

    // Return the stored thumbnail if available
    if let Some(thumbnail) = image.thumbnail {
        return Ok(thumbnail);
    }

    // Otherwise, return full image data as fallback
    get_image_data(state, id)
}
