//! Image processing commands for astrophotography
//!
//! Provides commands for processing FITS images with stretching and enhancements.

use base64::prelude::*;
use image::imageops::FilterType;
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use std::path::Path;
use std::sync::mpsc;
use tauri::{Emitter, State, Window};

use crate::db::{models::{NewCollection, NewCollectionImage, NewImage, UpdateImage}, repository};
use crate::python::image_process::{self, ProcessingParams, ProcessingProgress, ProcessingResult, TargetInfo};
use crate::state::AppState;

/// Name of the collection for processed images
const PROCESSED_COLLECTION_NAME: &str = "Processed";

/// Maximum thumbnail dimension (width or height)
const THUMBNAIL_SIZE: u32 = 300;
/// JPEG quality for thumbnails (0-100)
const THUMBNAIL_QUALITY: u8 = 80;

/// Generate a base64-encoded JPEG thumbnail from an image file
fn generate_thumbnail(image_path: &Path) -> Result<String, String> {
    // Load the image
    let img = image::open(image_path)
        .map_err(|e| format!("Failed to open image: {}", e))?;

    // Resize to thumbnail, maintaining aspect ratio
    let thumbnail = img.resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, FilterType::Lanczos3);

    // Convert to RGB8 (in case it's RGBA or other format)
    let rgb_image = thumbnail.to_rgb8();

    // Encode as JPEG to a buffer
    let mut buffer = Cursor::new(Vec::new());
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buffer, THUMBNAIL_QUALITY);
    encoder
        .encode(
            rgb_image.as_raw(),
            rgb_image.width(),
            rgb_image.height(),
            image::ExtendedColorType::Rgb8,
        )
        .map_err(|e| format!("Failed to encode thumbnail: {}", e))?;

    // Encode as base64
    let base64_data = BASE64_STANDARD.encode(buffer.into_inner());

    // Return as data URL
    Ok(format!("data:image/jpeg;base64,{}", base64_data))
}

/// Get or create the "Processed" collection
fn get_or_create_processed_collection(
    conn: &mut diesel::SqliteConnection,
    user_id: &str,
) -> Result<String, String> {
    // Try to find existing collection
    if let Some(collection) = repository::get_collection_by_name(conn, user_id, PROCESSED_COLLECTION_NAME)
        .map_err(|e| format!("Failed to query collection: {}", e))?
    {
        return Ok(collection.id);
    }

    // Create new collection
    let collection_id = uuid::Uuid::new_v4().to_string();
    let new_collection = NewCollection {
        id: collection_id.clone(),
        user_id: user_id.to_string(),
        name: PROCESSED_COLLECTION_NAME.to_string(),
        description: Some("Automatically processed images".to_string()),
        visibility: "private".to_string(),
        template: None,
        favorite: false,
        tags: Some("processed,auto".to_string()),
        metadata: None,
        archived: false,
    };

    repository::create_collection(conn, &new_collection)
        .map_err(|e| format!("Failed to create collection: {}", e))?;

    log::info!("Created '{}' collection with ID: {}", PROCESSED_COLLECTION_NAME, collection_id);
    Ok(collection_id)
}

/// Input for processing an image
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessImageInput {
    /// Image ID to process
    pub id: String,
    /// Target type override (optional, defaults to "auto")
    pub target_type: Option<String>,
    /// Stretch method (optional, defaults to "statistical")
    pub stretch_method: Option<String>,
    /// Stretch factor (optional, default based on target type)
    pub stretch_factor: Option<f64>,
    /// Whether to remove background (optional, defaults to true)
    pub background_removal: Option<bool>,
    /// Whether to reduce star brightness (optional, defaults to false)
    pub star_reduction: Option<bool>,
    /// Whether to apply color calibration (optional, defaults to true)
    pub color_calibration: Option<bool>,
    /// Noise reduction strength 0-1 (optional, defaults to 0)
    pub noise_reduction: Option<f64>,
}

/// Response from image processing
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessImageResponse {
    /// Processing result
    #[serde(flatten)]
    pub result: ProcessingResult,
}

/// Find companion FITS file for a given image URL (same logic as in images.rs)
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

/// Process a FITS image with stretch and enhancements
#[tauri::command]
pub async fn process_fits_image(
    state: State<'_, AppState>,
    window: Window,
    input: ProcessImageInput,
) -> Result<ProcessImageResponse, String> {
    // Get the image from the database
    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    let mut image = repository::get_image_by_id(&mut conn, &input.id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Image not found: {}", input.id))?;

    // Lazy populate fits_url if missing
    if image.fits_url.is_none() {
        if let Some(url) = &image.url {
            if let Some(fits_path) = find_fits_companion(url) {
                // Update database with the discovered fits_url
                let update = UpdateImage {
                    fits_url: Some(fits_path.clone()),
                    ..Default::default()
                };
                if let Err(e) = repository::update_image(&mut conn, &input.id, &update) {
                    log::warn!("Failed to update fits_url for image {}: {}", input.id, e);
                } else {
                    log::info!("Lazily populated fits_url for image {}: {}", input.id, fits_path);
                    image.fits_url = Some(fits_path);
                }
            }
        }
    }

    // Get the FITS file path (prefer fits_url, fallback to url if it's a FITS file)
    let file_path = image
        .fits_url
        .as_ref()
        .or_else(|| {
            // Fallback to url if it's a FITS file
            image.url.as_ref().filter(|u| {
                let lower = u.to_lowercase();
                lower.ends_with(".fit") || lower.ends_with(".fits")
            })
        })
        .ok_or_else(|| "Image has no FITS file path".to_string())?
        .clone();

    // Verify the file exists
    let path = Path::new(&file_path);
    if !path.exists() {
        return Err(format!("FITS file not found: {}", file_path));
    }

    // Determine output directory (create 'processed' subdirectory alongside original)
    let output_dir = path
        .parent()
        .unwrap_or(Path::new("."))
        .join("processed")
        .to_string_lossy()
        .to_string();

    // Get object name from existing metadata for auto-classification
    let object_name: Option<String> = image
        .metadata
        .as_ref()
        .and_then(|m| serde_json::from_str::<serde_json::Value>(m).ok())
        .and_then(|v| v.get("object_name").and_then(|n| n.as_str().map(String::from)));

    // Also check summary/filename for object name
    let object_name = object_name.or_else(|| image.summary.clone());

    // Build processing parameters
    let params = ProcessingParams {
        target_type: input.target_type.unwrap_or_else(|| "auto".to_string()),
        stretch_method: input.stretch_method.unwrap_or_else(|| "statistical".to_string()),
        stretch_factor: input.stretch_factor.unwrap_or(0.15),
        background_removal: input.background_removal.unwrap_or(true),
        star_reduction: input.star_reduction.unwrap_or(false),
        color_calibration: input.color_calibration.unwrap_or(true),
        noise_reduction: input.noise_reduction.unwrap_or(0.0),
    };

    // Create progress channel
    let (progress_tx, progress_rx) = mpsc::channel::<ProcessingProgress>();

    // Spawn a task to forward progress events to the frontend
    let window_clone = window.clone();
    let image_id = input.id.clone();
    std::thread::spawn(move || {
        while let Ok(progress) = progress_rx.recv() {
            let payload = serde_json::json!({
                "imageId": image_id,
                "step": progress.step,
                "progress": progress.progress,
                "message": progress.message,
            });
            if let Err(e) = window_clone.emit("image-processing-progress", payload) {
                log::warn!("Failed to emit progress event: {}", e);
            }
        }
    });

    // Process the image with progress reporting
    let result = image_process::process_image_with_progress(
        &file_path,
        &output_dir,
        &params,
        object_name.as_deref(),
        progress_tx,
    )?;

    // Update image metadata and import processed image
    if result.success {
        let processing_metadata = serde_json::json!({
            "processing": {
                "processed_at": chrono::Utc::now().to_rfc3339(),
                "target_type": result.target_type,
                "target_confidence": 0.85,
                "stretch_method": params.stretch_method,
                "stretch_factor": params.stretch_factor,
                "background_removal": params.background_removal,
                "star_reduction": params.star_reduction,
                "output_fits": result.output_fits_path,
                "output_preview": result.output_preview_path,
                "processing_time": result.processing_time,
            }
        });

        // Merge with existing metadata
        let new_metadata = if let Some(existing) = &image.metadata {
            if let Ok(mut existing_json) = serde_json::from_str::<serde_json::Value>(existing) {
                if let Some(obj) = existing_json.as_object_mut() {
                    obj.insert(
                        "processing".to_string(),
                        processing_metadata["processing"].clone(),
                    );
                }
                serde_json::to_string(&existing_json).ok()
            } else {
                Some(processing_metadata.to_string())
            }
        } else {
            Some(processing_metadata.to_string())
        };

        // Update the original image in database
        let update = UpdateImage {
            metadata: new_metadata,
            ..Default::default()
        };

        if let Err(e) = repository::update_image(&mut conn, &input.id, &update) {
            log::error!("Failed to update image after processing: {}", e);
        }

        // Import processed image into the "Processed" collection
        let processed_fits_path = Path::new(&result.output_fits_path);
        let preview_path = Path::new(&result.output_preview_path);

        // Get or create the "Processed" collection
        match get_or_create_processed_collection(&mut conn, &image.user_id) {
            Ok(collection_id) => {
                // Generate thumbnail from the PNG preview
                let thumbnail = match generate_thumbnail(preview_path) {
                    Ok(thumb) => Some(thumb),
                    Err(e) => {
                        log::warn!("Failed to generate thumbnail for processed image: {}", e);
                        None
                    }
                };

                // Build filename for the processed image
                let filename = processed_fits_path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("processed.fits")
                    .to_string();

                // Build summary (use original summary with " (Processed)" suffix)
                let summary = image.summary
                    .as_ref()
                    .map(|s| format!("{} (Processed)", s))
                    .or_else(|| Some(format!("{} (Processed)", filename.replace("_processed.fits", ""))));

                // Build metadata for processed image
                let processed_metadata = serde_json::json!({
                    "source_image_id": image.id,
                    "processing": processing_metadata["processing"],
                });

                // Create new image entry for the processed file
                // Use PNG preview as url for display, FITS as fits_url for processing
                let new_image_id = uuid::Uuid::new_v4().to_string();
                let new_image = NewImage {
                    id: new_image_id.clone(),
                    user_id: image.user_id.clone(),
                    collection_id: Some(collection_id.clone()),
                    filename,
                    url: Some(result.output_preview_path.clone()),
                    summary,
                    description: Some(format!(
                        "Processed from original image using {} stretch (factor: {:.0}%)",
                        params.stretch_method,
                        params.stretch_factor * 100.0
                    )),
                    content_type: Some("image/png".to_string()),
                    favorite: false,
                    tags: Some("processed".to_string()),
                    visibility: Some("private".to_string()),
                    location: image.location.clone(),
                    annotations: None,
                    metadata: Some(processed_metadata.to_string()),
                    thumbnail,
                    fits_url: Some(result.output_fits_path.clone()),
                };

                match repository::create_image(&mut conn, &new_image) {
                    Ok(created_image) => {
                        // Also add to collection_images junction table
                        let collection_image = NewCollectionImage {
                            id: uuid::Uuid::new_v4().to_string(),
                            collection_id: collection_id.clone(),
                            image_id: created_image.id.clone(),
                        };
                        if let Err(e) = repository::add_image_to_collection(&mut conn, &collection_image) {
                            log::error!("Failed to add image to collection_images: {}", e);
                        }
                        log::info!(
                            "Imported processed image {} into 'Processed' collection",
                            created_image.id
                        );
                    }
                    Err(e) => {
                        log::error!("Failed to import processed image: {}", e);
                    }
                }
            }
            Err(e) => {
                log::error!("Failed to get/create 'Processed' collection: {}", e);
            }
        }
    }

    Ok(ProcessImageResponse { result })
}

/// Get target type classification for an object
#[tauri::command]
pub fn classify_target_type(object_name: String) -> Result<TargetInfo, String> {
    image_process::classify_target(&object_name)
}

/// Get default processing parameters for a target type
#[tauri::command]
pub fn get_processing_defaults(target_type: String) -> Result<ProcessingParams, String> {
    let mut params = ProcessingParams::default();

    match target_type.as_str() {
        "emission_nebula" => {
            params.stretch_factor = 0.18;
            params.star_reduction = true;
        }
        "reflection_nebula" => {
            params.stretch_factor = 0.15;
        }
        "planetary_nebula" => {
            params.stretch_factor = 0.20;
        }
        "galaxy" => {
            params.stretch_factor = 0.12;
        }
        "globular_cluster" => {
            params.stretch_factor = 0.10;
        }
        "open_cluster" => {
            params.stretch_factor = 0.08;
        }
        "star_field" => {
            params.stretch_factor = 0.05;
            params.background_removal = false;
        }
        _ => {
            // Use defaults for unknown
        }
    }

    params.target_type = target_type;
    Ok(params)
}
