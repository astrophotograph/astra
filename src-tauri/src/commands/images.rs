//! Image commands for managing astronomical images

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use tauri::{Manager, State};

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
        fits_url: None,
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
        fits_url: None,
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

    let orig_path = Path::new(file_path);

    // If URL points to a FITS file or doesn't exist, look for a preview JPEG
    let path = if !orig_path.exists() || orig_path.extension().and_then(|e| e.to_str())
        .map(|e| { let l = e.to_lowercase(); l == "fit" || l == "fits" }).unwrap_or(false)
    {
        // Check local previews dir first (survives unmounting)
        let local_preview = dirs::data_dir()
            .map(|d| d.join("com.erewhon.astra").join("previews").join(format!("{}.jpg", id)))
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
    let data = fs::read(&path)
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

// ============================================================================
// FITS URL Population Commands
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
#[tauri::command]
pub fn populate_fits_urls(state: State<'_, AppState>) -> Result<PopulateFitsUrlsResult, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;

    // Get all images for this user
    let images = repository::get_images_by_user(&mut conn, &state.user_id)
        .map_err(|e| e.to_string())?;

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
        result.total_checked, result.updated, result.already_set, result.no_fits_found
    );

    Ok(result)
}

/// Ensure fits_url is populated for a single image (lazy population)
/// Returns the fits_url if found/already set, None otherwise
#[tauri::command]
pub fn ensure_fits_url(state: State<'_, AppState>, id: String) -> Result<Option<String>, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;

    let image = repository::get_image_by_id(&mut conn, &id)
        .map_err(|e| e.to_string())?
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

        repository::update_image(&mut conn, &id, &update)
            .map_err(|e| e.to_string())?;

        log::info!("Lazily populated fits_url for image {}: {}", id, fits_path);
        Ok(Some(fits_path))
    } else {
        Ok(None)
    }
}

/// Check which image sources/mounts are available
#[tauri::command]
pub fn check_source_health(state: State<'_, AppState>) -> Result<Vec<(String, bool, usize)>, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    let images = repository::get_images_by_user(&mut conn, &state.user_id)
        .map_err(|e| e.to_string())?;

    // Group by mount prefix and check availability
    let mut mounts: std::collections::HashMap<String, (bool, usize)> = std::collections::HashMap::new();
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

    Ok(mounts.into_iter().map(|(path, (available, count))| (path, available, count)).collect())
}

/// Migrate preview images from remote paths to local storage
#[tauri::command]
pub async fn migrate_previews_to_local(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(usize, usize), String> {
    let preview_dir = app.path().app_data_dir()
        .map(|d| d.join("previews"))
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let _ = std::fs::create_dir_all(&preview_dir);

    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    let images = repository::get_images_by_user(&mut conn, &state.user_id)
        .map_err(|e| e.to_string())?;

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
                if let Ok(_) = std::fs::copy(url_path, &local_preview) {
                    migrated += 1;
                    continue;
                }
            }

            // Try adjacent preview
            let adjacent = url_path.with_file_name(format!(
                "{}_preview.jpg",
                url_path.file_stem().unwrap_or_default().to_string_lossy()
            ));
            if adjacent.exists() {
                if let Ok(_) = std::fs::copy(&adjacent, &local_preview) {
                    migrated += 1;
                    continue;
                }
            }
        }
    }

    Ok((migrated, skipped))
}

/// Get all unique tags across all images
#[tauri::command]
pub fn get_unique_tags(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    let all_tags = repository::get_all_tags(&mut conn, &state.user_id)
        .map_err(|e| e.to_string())?;

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
#[tauri::command]
pub fn get_unique_cameras(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    let all_meta = repository::get_all_metadata(&mut conn, &state.user_id)
        .map_err(|e| e.to_string())?;

    let mut unique = std::collections::BTreeSet::new();
    for meta_str in all_meta {
        if let Ok(meta) = serde_json::from_str::<serde_json::Value>(&meta_str) {
            for key in ["INSTRUME", "instrume"] {
                if let Some(val) = meta.get(key) {
                    let s = val.to_string();
                    // Parse fitrs debug format
                    if let Some(caps) = s.strip_prefix("\"Some(CharacterString(\\\"") {
                        if let Some(name) = caps.strip_suffix("\\\"))\"}").or_else(|| caps.strip_suffix("\\\"))\"")) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

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
