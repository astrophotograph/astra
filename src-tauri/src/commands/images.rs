//! Image commands for managing astronomical images
//!
//! Each `#[tauri::command]` is a thin wrapper over a `*_core` fn taking
//! explicit `db` + `user_id` so the daemon can serve the same logic without
//! Tauri (same pattern as `migrate_library_core` in `hoardfs.rs`). The core
//! fns enforce the tenancy boundary: rows belonging to another user read as
//! not-found and cannot be mutated or linked into collections.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use diesel::SqliteConnection;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use tauri::{Manager, State};

use super::collections::fetch_owned_collection;
use crate::db::models::{Collection, Image, NewCollectionImage, NewImage, UpdateImage};
use crate::db::{repository, DbPool};
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

/// Load an image only if it belongs to `user_id`.
pub(crate) fn fetch_owned_image(
    conn: &mut SqliteConnection,
    user_id: &str,
    image_id: &str,
) -> Result<Option<Image>, String> {
    let image = repository::get_image_by_id(conn, image_id).map_err(|e| e.to_string())?;
    Ok(image.filter(|i| i.user_id == user_id))
}

// ============================================================================
// Core functions (no Tauri types — shared with the daemon)
// ============================================================================

pub fn get_images_core(db: &DbPool, user_id: &str) -> Result<Vec<Image>, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;
    repository::get_images_by_user(&mut conn, user_id).map_err(|e| e.to_string())
}

pub fn get_collection_images_core(
    db: &DbPool,
    user_id: &str,
    collection_id: &str,
) -> Result<Vec<Image>, String> {
    log::info!(
        "get_collection_images called with collection_id: {}",
        collection_id
    );
    let mut conn = db.get().map_err(|e| e.to_string())?;

    // Not-owned reads as nonexistent: same empty list as an unknown id.
    if fetch_owned_collection(&mut conn, user_id, collection_id)?.is_none() {
        return Ok(Vec::new());
    }

    let result = repository::get_images_in_collection(&mut conn, collection_id);
    match &result {
        Ok(images) => log::info!("get_collection_images returning {} images", images.len()),
        Err(e) => log::error!("get_collection_images error: {}", e),
    }
    result.map_err(|e| e.to_string())
}

pub fn get_image_core(db: &DbPool, user_id: &str, id: &str) -> Result<Option<Image>, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;
    fetch_owned_image(&mut conn, user_id, id)
}

pub fn create_image_core(
    db: &DbPool,
    user_id: &str,
    input: CreateImageInput,
) -> Result<Image, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;

    let new_image = NewImage {
        id: uuid::Uuid::new_v4().to_string(),
        user_id: user_id.to_string(),
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
        fits_url: None,
        blob_id: None,
    };

    repository::create_image(&mut conn, &new_image).map_err(|e| e.to_string())
}

pub fn update_image_core(
    db: &DbPool,
    user_id: &str,
    input: UpdateImageInput,
) -> Result<Image, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;

    fetch_owned_image(&mut conn, user_id, &input.id)?
        .ok_or_else(|| format!("Image not found: {}", input.id))?;

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
        fits_url: None,
        blob_id: None,
    };

    repository::update_image(&mut conn, &input.id, &update).map_err(|e| e.to_string())
}

pub fn delete_image_core(db: &DbPool, user_id: &str, id: &str) -> Result<bool, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;

    if fetch_owned_image(&mut conn, user_id, id)?.is_none() {
        return Ok(false);
    }

    repository::delete_image(&mut conn, id)
        .map(|count| count > 0)
        .map_err(|e| e.to_string())
}

// ============================================================================
// Image-Collection Many-to-Many Cores
// ============================================================================

pub fn add_image_to_collection_core(
    db: &DbPool,
    user_id: &str,
    image_id: &str,
    collection_id: &str,
) -> Result<bool, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;

    // Both endpoints must belong to the user before linking.
    fetch_owned_image(&mut conn, user_id, image_id)?
        .ok_or_else(|| format!("Image not found: {image_id}"))?;
    fetch_owned_collection(&mut conn, user_id, collection_id)?
        .ok_or_else(|| format!("Collection not found: {collection_id}"))?;

    let already_exists = repository::is_image_in_collection(&mut conn, collection_id, image_id)
        .map_err(|e| e.to_string())?;

    if already_exists {
        return Ok(false); // Already in collection
    }

    let new_entry = NewCollectionImage {
        id: uuid::Uuid::new_v4().to_string(),
        collection_id: collection_id.to_string(),
        image_id: image_id.to_string(),
    };

    repository::add_image_to_collection(&mut conn, &new_entry)
        .map(|_| true)
        .map_err(|e| e.to_string())
}

pub fn remove_image_from_collection_core(
    db: &DbPool,
    user_id: &str,
    image_id: &str,
    collection_id: &str,
) -> Result<bool, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;

    // The join row lives under the collection; not-owned removes nothing.
    if fetch_owned_collection(&mut conn, user_id, collection_id)?.is_none() {
        return Ok(false);
    }

    repository::remove_image_from_collection(&mut conn, collection_id, image_id)
        .map(|count| count > 0)
        .map_err(|e| e.to_string())
}

pub fn get_image_collections_core(
    db: &DbPool,
    user_id: &str,
    image_id: &str,
) -> Result<Vec<Collection>, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;

    if fetch_owned_image(&mut conn, user_id, image_id)?.is_none() {
        return Ok(Vec::new());
    }

    repository::get_collections_for_image(&mut conn, image_id).map_err(|e| e.to_string())
}

pub fn get_collection_image_count_core(
    db: &DbPool,
    user_id: &str,
    collection_id: &str,
) -> Result<i64, String> {
    log::info!(
        "get_collection_image_count called with collection_id: {}",
        collection_id
    );
    let mut conn = db.get().map_err(|e| e.to_string())?;

    if fetch_owned_collection(&mut conn, user_id, collection_id)?.is_none() {
        return Ok(0);
    }

    let result = repository::get_collection_image_count(&mut conn, collection_id);
    match &result {
        Ok(count) => log::info!("get_collection_image_count returning: {}", count),
        Err(e) => log::error!("get_collection_image_count error: {}", e),
    }
    result.map_err(|e| e.to_string())
}

// ============================================================================
// Image Data Serving Cores
// ============================================================================

/// Get the full image data as a base64 data URL
pub fn get_image_data_core(db: &DbPool, user_id: &str, id: &str) -> Result<String, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;

    // Get the image record
    let image = fetch_owned_image(&mut conn, user_id, id)?
        .ok_or_else(|| format!("Image not found: {}", id))?;

    // Get the file path from url field
    let file_path = image
        .url
        .as_ref()
        .ok_or_else(|| "Image has no file path".to_string())?;

    let orig_path = Path::new(file_path);

    // If URL points to a FITS file or doesn't exist, look for a preview JPEG
    let path = if !orig_path.exists()
        || orig_path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| {
                let l = e.to_lowercase();
                l == "fit" || l == "fits"
            })
            .unwrap_or(false)
    {
        // Check local previews dir first (survives unmounting)
        let local_preview = dirs::data_dir()
            .map(|d| {
                d.join("com.erewhon.astra")
                    .join("previews")
                    .join(format!("{}.jpg", id))
            })
            .unwrap_or_default();
        if local_preview.exists() {
            local_preview
        } else {
            // Fall back to preview next to the file
            let adjacent_preview = orig_path.with_file_name(format!(
                "{}_preview.jpg",
                orig_path.file_stem().unwrap_or_default().to_string_lossy()
            ));
            if adjacent_preview.exists() {
                adjacent_preview
            } else {
                orig_path.to_path_buf()
            }
        }
    } else {
        orig_path.to_path_buf()
    };

    if !path.exists() {
        // Last resort: return the embedded thumbnail if available
        if let Some(thumb) = &image.thumbnail {
            if !thumb.is_empty() {
                return Ok(thumb.clone());
            }
        }
        return Err(format!("Image file not found: {}", path.display()));
    }

    // Read the file
    let data = fs::read(&path).map_err(|e| format!("Failed to read image file: {}", e))?;

    // Determine content type
    let content_type = image.content_type.as_deref().unwrap_or_else(|| {
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
pub fn get_image_thumbnail_core(db: &DbPool, user_id: &str, id: &str) -> Result<String, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;

    // Get the image record
    let image = fetch_owned_image(&mut conn, user_id, id)?
        .ok_or_else(|| format!("Image not found: {}", id))?;

    // Return the stored thumbnail if available
    if let Some(thumbnail) = image.thumbnail {
        return Ok(thumbnail);
    }

    // Otherwise, return full image data as fallback
    drop(conn);
    get_image_data_core(db, user_id, id)
}

// ============================================================================
// FITS URL Population
// ============================================================================

/// Find companion FITS file for a given image URL
fn find_fits_companion(url: &str) -> Option<String> {
    let path = Path::new(url);

    // Only process image files (jpg, jpeg, png)
    let ext = path.extension()?.to_str()?.to_lowercase();
    if !matches!(ext.as_str(), "jpg" | "jpeg" | "png") {
        return None;
    }

    // Try .fit extension first, then .fits
    let stem = path.file_stem()?.to_str()?;
    let parent = path.parent()?;

    for fits_ext in &["fit", "fits"] {
        let fits_path = parent.join(format!("{}.{}", stem, fits_ext));
        if fits_path.exists() {
            return Some(fits_path.to_string_lossy().to_string());
        }
    }

    None
}

/// Result of populating FITS URLs
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PopulateFitsUrlsResult {
    pub total_checked: i32,
    pub updated: i32,
    pub already_set: i32,
    pub no_fits_found: i32,
}

/// Populate fits_url for all images that are missing it
/// This checks for companion .fit/.fits files alongside the image URL
pub fn populate_fits_urls_core(
    db: &DbPool,
    user_id: &str,
) -> Result<PopulateFitsUrlsResult, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;

    // Get all images for this user
    let images =
        repository::get_images_by_user(&mut conn, user_id).map_err(|e| e.to_string())?;

    let mut result = PopulateFitsUrlsResult {
        total_checked: 0,
        updated: 0,
        already_set: 0,
        no_fits_found: 0,
    };

    for image in images {
        result.total_checked += 1;

        // Skip if fits_url already set
        if image.fits_url.is_some() {
            result.already_set += 1;
            continue;
        }

        // Skip if no url
        let Some(url) = &image.url else {
            result.no_fits_found += 1;
            continue;
        };

        // Try to find companion FITS file
        if let Some(fits_path) = find_fits_companion(url) {
            let update = UpdateImage {
                fits_url: Some(fits_path.clone()),
                ..Default::default()
            };

            if let Err(e) = repository::update_image(&mut conn, &image.id, &update) {
                log::warn!("Failed to update fits_url for image {}: {}", image.id, e);
            } else {
                log::info!("Populated fits_url for image {}: {}", image.id, fits_path);
                result.updated += 1;
            }
        } else {
            result.no_fits_found += 1;
        }
    }

    log::info!(
        "populate_fits_urls complete: checked={}, updated={}, already_set={}, no_fits={}",
        result.total_checked,
        result.updated,
        result.already_set,
        result.no_fits_found
    );

    Ok(result)
}

/// Ensure fits_url is populated for a single image (lazy population)
/// Returns the fits_url if found/already set, None otherwise
pub fn ensure_fits_url_core(
    db: &DbPool,
    user_id: &str,
    id: &str,
) -> Result<Option<String>, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;

    let image = fetch_owned_image(&mut conn, user_id, id)?
        .ok_or_else(|| format!("Image not found: {}", id))?;

    // Return existing fits_url if set
    if let Some(fits_url) = &image.fits_url {
        return Ok(Some(fits_url.clone()));
    }

    // Try to find and set fits_url
    let Some(url) = &image.url else {
        return Ok(None);
    };

    if let Some(fits_path) = find_fits_companion(url) {
        let update = UpdateImage {
            fits_url: Some(fits_path.clone()),
            ..Default::default()
        };

        repository::update_image(&mut conn, id, &update).map_err(|e| e.to_string())?;

        log::info!("Lazily populated fits_url for image {}: {}", id, fits_path);
        Ok(Some(fits_path))
    } else {
        Ok(None)
    }
}

/// Check which image sources/mounts are available
pub fn check_source_health_core(
    db: &DbPool,
    user_id: &str,
) -> Result<Vec<(String, bool, usize)>, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;
    let images =
        repository::get_images_by_user(&mut conn, user_id).map_err(|e| e.to_string())?;

    // Group by mount prefix and check availability
    let mut mounts: std::collections::HashMap<String, (bool, usize)> =
        std::collections::HashMap::new();
    for img in &images {
        if let Some(url) = &img.url {
            // Extract mount prefix (e.g., /mnt/asiair, /mnt/mouseion)
            let parts: Vec<&str> = url.split('/').collect();
            if parts.len() >= 3 && parts[1] == "mnt" {
                let mount = format!("/{}/{}", parts[1], parts[2]);
                let entry = mounts.entry(mount.clone()).or_insert((false, 0));
                entry.1 += 1;
                if !entry.0 {
                    entry.0 = Path::new(&mount).exists() && std::fs::read_dir(&mount).is_ok();
                }
            }
        }
    }

    Ok(mounts
        .into_iter()
        .map(|(path, (available, count))| (path, available, count))
        .collect())
}

/// Migrate preview images from remote paths to local storage
pub fn migrate_previews_to_local_core(
    db: &DbPool,
    user_id: &str,
    preview_dir: &Path,
) -> Result<(usize, usize), String> {
    let _ = std::fs::create_dir_all(preview_dir);

    let mut conn = db.get().map_err(|e| e.to_string())?;
    let images =
        repository::get_images_by_user(&mut conn, user_id).map_err(|e| e.to_string())?;

    let mut migrated = 0usize;
    let mut skipped = 0usize;

    for img in &images {
        let local_preview = preview_dir.join(format!("{}.jpg", img.id));
        if local_preview.exists() {
            skipped += 1;
            continue;
        }

        // Try to find an existing preview to copy
        if let Some(url) = &img.url {
            let url_path = Path::new(url);
            if url_path.exists() && !url.ends_with(".fit") && !url.ends_with(".fits") {
                // URL points to an image file — copy it to local previews
                if std::fs::copy(url_path, &local_preview).is_ok() {
                    migrated += 1;
                    continue;
                }
            }

            // Try adjacent preview
            let adjacent = url_path.with_file_name(format!(
                "{}_preview.jpg",
                url_path.file_stem().unwrap_or_default().to_string_lossy()
            ));
            if adjacent.exists() && std::fs::copy(&adjacent, &local_preview).is_ok() {
                migrated += 1;
                continue;
            }
        }
    }

    Ok((migrated, skipped))
}

/// Get all unique tags across all images
pub fn get_unique_tags_core(db: &DbPool, user_id: &str) -> Result<Vec<String>, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;
    let all_tags = repository::get_all_tags(&mut conn, user_id).map_err(|e| e.to_string())?;

    let mut unique = std::collections::BTreeSet::new();
    for tags_str in all_tags {
        for tag in tags_str.split(',') {
            let t = tag.trim().to_string();
            if !t.is_empty() {
                unique.insert(t);
            }
        }
    }
    Ok(unique.into_iter().collect())
}

/// Get all unique camera/instrument names from image metadata
pub fn get_unique_cameras_core(db: &DbPool, user_id: &str) -> Result<Vec<String>, String> {
    let mut conn = db.get().map_err(|e| e.to_string())?;
    let all_meta = repository::get_all_metadata(&mut conn, user_id).map_err(|e| e.to_string())?;

    let mut unique = std::collections::BTreeSet::new();
    for meta_str in all_meta {
        if let Ok(meta) = serde_json::from_str::<serde_json::Value>(&meta_str) {
            for key in ["INSTRUME", "instrume"] {
                if let Some(val) = meta.get(key) {
                    let s = val.to_string();
                    // Parse fitrs debug format
                    if let Some(caps) = s.strip_prefix("\"Some(CharacterString(\\\"") {
                        if let Some(name) = caps
                            .strip_suffix("\\\"))\"}")
                            .or_else(|| caps.strip_suffix("\\\"))\""))
                        {
                            let trimmed = name.trim().to_string();
                            if !trimmed.is_empty() {
                                unique.insert(trimmed);
                            }
                        }
                    } else {
                        // Try simpler parsing
                        let cleaned = s.trim_matches('"').to_string();
                        if let Some(m) = cleaned.strip_prefix("Some(CharacterString(\"") {
                            if let Some(name) = m.strip_suffix("\"))") {
                                let trimmed = name.trim().to_string();
                                if !trimmed.is_empty() {
                                    unique.insert(trimmed);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(unique.into_iter().collect())
}

// ============================================================================
// Tauri command wrappers
// ============================================================================

#[tauri::command]
pub fn get_images(state: State<'_, AppState>) -> Result<Vec<Image>, String> {
    get_images_core(&state.db, &state.user_id)
}

#[tauri::command]
pub fn get_collection_images(
    state: State<'_, AppState>,
    collection_id: String,
) -> Result<Vec<Image>, String> {
    get_collection_images_core(&state.db, &state.user_id, &collection_id)
}

#[tauri::command]
pub fn get_image(state: State<'_, AppState>, id: String) -> Result<Option<Image>, String> {
    get_image_core(&state.db, &state.user_id, &id)
}

#[tauri::command]
pub fn create_image(
    state: State<'_, AppState>,
    input: CreateImageInput,
) -> Result<Image, String> {
    create_image_core(&state.db, &state.user_id, input)
}

#[tauri::command]
pub fn update_image(
    state: State<'_, AppState>,
    input: UpdateImageInput,
) -> Result<Image, String> {
    update_image_core(&state.db, &state.user_id, input)
}

#[tauri::command]
pub fn delete_image(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    delete_image_core(&state.db, &state.user_id, &id)
}

#[tauri::command]
pub fn add_image_to_collection(
    state: State<'_, AppState>,
    image_id: String,
    collection_id: String,
) -> Result<bool, String> {
    add_image_to_collection_core(&state.db, &state.user_id, &image_id, &collection_id)
}

#[tauri::command]
pub fn remove_image_from_collection(
    state: State<'_, AppState>,
    image_id: String,
    collection_id: String,
) -> Result<bool, String> {
    remove_image_from_collection_core(&state.db, &state.user_id, &image_id, &collection_id)
}

#[tauri::command]
pub fn get_image_collections(
    state: State<'_, AppState>,
    image_id: String,
) -> Result<Vec<Collection>, String> {
    get_image_collections_core(&state.db, &state.user_id, &image_id)
}

#[tauri::command]
pub fn get_collection_image_count(
    state: State<'_, AppState>,
    collection_id: String,
) -> Result<i64, String> {
    get_collection_image_count_core(&state.db, &state.user_id, &collection_id)
}

#[tauri::command]
pub fn get_image_data(state: State<'_, AppState>, id: String) -> Result<String, String> {
    get_image_data_core(&state.db, &state.user_id, &id)
}

#[tauri::command]
pub fn get_image_thumbnail(state: State<'_, AppState>, id: String) -> Result<String, String> {
    get_image_thumbnail_core(&state.db, &state.user_id, &id)
}

#[tauri::command]
pub fn populate_fits_urls(state: State<'_, AppState>) -> Result<PopulateFitsUrlsResult, String> {
    populate_fits_urls_core(&state.db, &state.user_id)
}

#[tauri::command]
pub fn ensure_fits_url(state: State<'_, AppState>, id: String) -> Result<Option<String>, String> {
    ensure_fits_url_core(&state.db, &state.user_id, &id)
}

#[tauri::command]
pub fn check_source_health(
    state: State<'_, AppState>,
) -> Result<Vec<(String, bool, usize)>, String> {
    check_source_health_core(&state.db, &state.user_id)
}

#[tauri::command]
pub async fn migrate_previews_to_local(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(usize, usize), String> {
    let preview_dir = app
        .path()
        .app_data_dir()
        .map(|d| d.join("previews"))
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    migrate_previews_to_local_core(&state.db, &state.user_id, &preview_dir)
}

#[tauri::command]
pub fn get_unique_tags(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    get_unique_tags_core(&state.db, &state.user_id)
}

#[tauri::command]
pub fn get_unique_cameras(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    get_unique_cameras_core(&state.db, &state.user_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::collections::{create_collection_core, CreateCollectionInput};
    use crate::db::test_support::{insert_user, test_pool};
    use tempfile::TempDir;

    fn make_image(db: &DbPool, user_id: &str, filename: &str) -> Image {
        create_image_core(
            db,
            user_id,
            CreateImageInput {
                collection_id: None,
                filename: filename.to_string(),
                url: None,
                summary: None,
                description: None,
                content_type: None,
                tags: None,
                visibility: None,
                location: None,
                annotations: None,
                metadata: None,
                thumbnail: None,
            },
        )
        .unwrap()
    }

    fn make_collection(db: &DbPool, user_id: &str, name: &str) -> Collection {
        create_collection_core(
            db,
            user_id,
            CreateCollectionInput {
                name: name.to_string(),
                description: None,
                visibility: None,
                template: None,
                tags: None,
            },
        )
        .unwrap()
    }

    #[test]
    fn image_crud_round_trip_core() {
        let db = test_pool();
        insert_user(&db, "alice");

        let created = make_image(&db, "alice", "M42.fit");
        assert_eq!(created.content_type.as_deref(), Some("image/jpeg"));
        assert_eq!(created.visibility.as_deref(), Some("private"));

        assert_eq!(get_images_core(&db, "alice").unwrap().len(), 1);
        assert_eq!(
            get_image_core(&db, "alice", &created.id)
                .unwrap()
                .unwrap()
                .filename,
            "M42.fit"
        );

        let updated = update_image_core(
            &db,
            "alice",
            UpdateImageInput {
                id: created.id.clone(),
                collection_id: None,
                filename: None,
                url: None,
                summary: Some("Orion Nebula".to_string()),
                description: None,
                content_type: None,
                favorite: Some(true),
                tags: None,
                visibility: None,
                location: None,
                annotations: None,
                metadata: None,
                thumbnail: None,
            },
        )
        .unwrap();
        assert_eq!(updated.summary.as_deref(), Some("Orion Nebula"));
        assert!(updated.favorite);

        assert!(delete_image_core(&db, "alice", &created.id).unwrap());
        assert!(get_images_core(&db, "alice").unwrap().is_empty());
    }

    #[test]
    fn image_cross_user_isolation() {
        let db = test_pool();
        insert_user(&db, "alice");
        insert_user(&db, "bob");

        let alices = make_image(&db, "alice", "NGC7000.fit");

        assert!(get_images_core(&db, "bob").unwrap().is_empty());
        assert!(get_image_core(&db, "bob", &alices.id).unwrap().is_none());
        assert!(update_image_core(
            &db,
            "bob",
            UpdateImageInput {
                id: alices.id.clone(),
                collection_id: None,
                filename: Some("hijacked.fit".to_string()),
                url: None,
                summary: None,
                description: None,
                content_type: None,
                favorite: None,
                tags: None,
                visibility: None,
                location: None,
                annotations: None,
                metadata: None,
                thumbnail: None,
            },
        )
        .is_err());
        assert!(!delete_image_core(&db, "bob", &alices.id).unwrap());
        assert!(get_image_data_core(&db, "bob", &alices.id).is_err());

        // Alice's image is untouched.
        let still = get_image_core(&db, "alice", &alices.id).unwrap().unwrap();
        assert_eq!(still.filename, "NGC7000.fit");
    }

    #[test]
    fn collection_membership_ops_are_user_scoped() {
        let db = test_pool();
        insert_user(&db, "alice");
        insert_user(&db, "bob");

        let image = make_image(&db, "alice", "M31.fit");
        let collection = make_collection(&db, "alice", "Galaxies");

        // Alice links her own image and collection.
        assert!(
            add_image_to_collection_core(&db, "alice", &image.id, &collection.id).unwrap()
        );
        // Second add is a no-op.
        assert!(
            !add_image_to_collection_core(&db, "alice", &image.id, &collection.id).unwrap()
        );
        assert_eq!(
            get_collection_image_count_core(&db, "alice", &collection.id).unwrap(),
            1
        );
        assert_eq!(
            get_collection_images_core(&db, "alice", &collection.id)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            get_image_collections_core(&db, "alice", &image.id)
                .unwrap()
                .len(),
            1
        );

        // Bob can't link, count, list, or unlink Alice's rows.
        assert!(add_image_to_collection_core(&db, "bob", &image.id, &collection.id).is_err());
        assert_eq!(
            get_collection_image_count_core(&db, "bob", &collection.id).unwrap(),
            0
        );
        assert!(get_collection_images_core(&db, "bob", &collection.id)
            .unwrap()
            .is_empty());
        assert!(get_image_collections_core(&db, "bob", &image.id)
            .unwrap()
            .is_empty());
        assert!(
            !remove_image_from_collection_core(&db, "bob", &image.id, &collection.id).unwrap()
        );

        // The link survives Bob's attempts; Alice can remove it.
        assert_eq!(
            get_collection_image_count_core(&db, "alice", &collection.id).unwrap(),
            1
        );
        assert!(
            remove_image_from_collection_core(&db, "alice", &image.id, &collection.id).unwrap()
        );
    }

    #[test]
    fn find_fits_companion_with_fit_extension() {
        let dir = TempDir::new().unwrap();
        let jpg_path = dir.path().join("M42.jpg");
        let fit_path = dir.path().join("M42.fit");
        fs::write(&jpg_path, b"fake jpg").unwrap();
        fs::write(&fit_path, b"fake fits").unwrap();

        let result = find_fits_companion(jpg_path.to_str().unwrap());
        assert!(result.is_some());
        assert!(result.unwrap().ends_with("M42.fit"));
    }

    #[test]
    fn find_fits_companion_with_fits_extension() {
        let dir = TempDir::new().unwrap();
        let png_path = dir.path().join("NGC7000.png");
        let fits_path = dir.path().join("NGC7000.fits");
        fs::write(&png_path, b"fake png").unwrap();
        fs::write(&fits_path, b"fake fits").unwrap();

        let result = find_fits_companion(png_path.to_str().unwrap());
        assert!(result.is_some());
        assert!(result.unwrap().ends_with("NGC7000.fits"));
    }

    #[test]
    fn find_fits_companion_prefers_fit_over_fits() {
        let dir = TempDir::new().unwrap();
        let jpg_path = dir.path().join("star.jpg");
        let fit_path = dir.path().join("star.fit");
        let fits_path = dir.path().join("star.fits");
        fs::write(&jpg_path, b"fake").unwrap();
        fs::write(&fit_path, b"fake").unwrap();
        fs::write(&fits_path, b"fake").unwrap();

        let result = find_fits_companion(jpg_path.to_str().unwrap());
        assert!(result.is_some());
        // .fit is tried first
        assert!(result.unwrap().ends_with("star.fit"));
    }

    #[test]
    fn find_fits_companion_no_fits_file() {
        let dir = TempDir::new().unwrap();
        let jpg_path = dir.path().join("lonely.jpg");
        fs::write(&jpg_path, b"fake").unwrap();

        let result = find_fits_companion(jpg_path.to_str().unwrap());
        assert!(result.is_none());
    }

    #[test]
    fn find_fits_companion_non_image_file() {
        let dir = TempDir::new().unwrap();
        let txt_path = dir.path().join("notes.txt");
        fs::write(&txt_path, b"text").unwrap();

        let result = find_fits_companion(txt_path.to_str().unwrap());
        assert!(result.is_none());
    }

    #[test]
    fn find_fits_companion_fits_file_input() {
        // A .fit file is not jpg/jpeg/png, so should return None
        let dir = TempDir::new().unwrap();
        let fit_path = dir.path().join("image.fit");
        fs::write(&fit_path, b"fake").unwrap();

        let result = find_fits_companion(fit_path.to_str().unwrap());
        assert!(result.is_none());
    }
}
