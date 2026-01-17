//! Bulk scan commands for importing images from directories

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chrono::{NaiveDate, NaiveDateTime, NaiveTime, Timelike};
use image::imageops::FilterType;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{Emitter, State};
use tokio::sync::Semaphore;
use walkdir::WalkDir;

/// Global cancellation flag for scan operations
static SCAN_CANCELLED: AtomicBool = AtomicBool::new(false);

use crate::db::models::{NewCollection, NewCollectionImage, NewImage};
use crate::db::repository;
use crate::state::AppState;

/// Maximum number of concurrent CPU-intensive tasks (FITS parsing + thumbnail generation)
const MAX_PARALLEL_PROCESSING: usize = 4;

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
    let base64_data = BASE64.encode(buffer.into_inner());

    // Return as data URL
    Ok(format!("data:image/jpeg;base64,{}", base64_data))
}

/// Input for bulk scan operation
#[derive(Debug, Serialize, Deserialize)]
pub struct BulkScanInput {
    /// Directory to scan recursively
    pub directory: String,
    /// Tags to apply to all imported images (comma-separated)
    pub tags: Option<String>,
    /// Only import stacked images (not raw subframes)
    pub stacked_only: bool,
    /// Maximum number of files to import (None = unlimited)
    pub max_files: Option<usize>,
}

/// Result of a bulk scan operation
#[derive(Debug, Serialize, Deserialize)]
pub struct BulkScanResult {
    /// Number of images imported
    pub images_imported: usize,
    /// Number of collections created
    pub collections_created: usize,
    /// Number of images skipped (already exist or errors)
    pub images_skipped: usize,
    /// Any errors encountered
    pub errors: Vec<String>,
}

/// Progress event payload for scan operations
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanProgress {
    /// Current image being processed (1-indexed)
    pub current: usize,
    /// Total number of images to process
    pub total: usize,
    /// Name of the current file being processed
    pub current_file: String,
    /// Percentage complete (0-100)
    pub percent: u8,
    /// Number of images skipped (duplicates)
    #[serde(default)]
    pub skipped: usize,
    /// Whether the scan was cancelled
    #[serde(default)]
    pub cancelled: bool,
}

/// Cancel an ongoing scan operation
#[tauri::command]
pub fn cancel_scan() -> Result<(), String> {
    SCAN_CANCELLED.store(true, Ordering::SeqCst);
    log::info!("Scan cancellation requested");
    Ok(())
}

/// Metadata extracted from a FITS file
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct FitsMetadata {
    pub object_name: Option<String>,
    pub ra: Option<String>,
    pub dec: Option<String>,
    pub date_obs: Option<String>,
    pub exposure: Option<f64>,
    pub gain: Option<i32>,
    pub offset: Option<i32>,
    pub telescope: Option<String>,
    pub instrument: Option<String>,
    pub filter: Option<String>,
    pub focal_length: Option<f64>,
    pub aperture: Option<f64>,
    pub image_width: Option<i32>,
    pub image_height: Option<i32>,
    pub stacked_frames: Option<i32>,
    pub software: Option<String>,
    /// All raw headers as JSON
    pub raw_headers: HashMap<String, String>,
}

/// Represents a discovered image (potentially with both .fit and .jpg)
#[derive(Debug, Clone)]
struct DiscoveredImage {
    /// Base name without extension
    base_name: String,
    /// Directory containing the image
    directory: PathBuf,
    /// Path to FITS file if exists
    fits_path: Option<PathBuf>,
    /// Path to JPEG file if exists
    jpeg_path: Option<PathBuf>,
    /// Whether this is a stacked image
    is_stacked: bool,
}

/// Result of preprocessing a single image (FITS parsing + thumbnail generation)
#[derive(Debug)]
struct ProcessedImage {
    /// Original discovered image info
    discovered: DiscoveredImage,
    /// Parsed FITS metadata (if successful)
    metadata: Option<FitsMetadata>,
    /// Generated thumbnail (if successful)
    thumbnail: Option<String>,
    /// Error message if processing failed
    error: Option<String>,
}

/// Parse FITS header to extract metadata
fn parse_fits_metadata(fits_path: &Path) -> Result<FitsMetadata, String> {
    use fitrs::Fits;

    let fits = Fits::open(fits_path).map_err(|e| format!("Failed to parse FITS file: {}", e))?;

    let mut metadata = FitsMetadata::default();

    // Get the primary HDU
    if let Some(hdu) = fits.into_iter().next() {
        for (key, value) in hdu.iter() {
            let key_str = key.to_string();
            let value_str = format!("{:?}", value);

            // Store raw header
            metadata.raw_headers.insert(key_str.clone(), value_str.clone());

            // Parse specific fields
            match key_str.as_str() {
                "OBJECT" => metadata.object_name = extract_string_value(&value_str),
                "RA" => metadata.ra = extract_string_value(&value_str),
                "DEC" => metadata.dec = extract_string_value(&value_str),
                "DATE-OBS" => metadata.date_obs = extract_string_value(&value_str),
                "EXPTIME" | "EXPOSURE" => metadata.exposure = extract_float_value(&value_str),
                "GAIN" => metadata.gain = extract_int_value(&value_str),
                "OFFSET" => metadata.offset = extract_int_value(&value_str),
                "TELESCOP" => metadata.telescope = extract_string_value(&value_str),
                "INSTRUME" => metadata.instrument = extract_string_value(&value_str),
                "FILTER" => metadata.filter = extract_string_value(&value_str),
                "FOCALLEN" => metadata.focal_length = extract_float_value(&value_str),
                "APERTURE" => metadata.aperture = extract_float_value(&value_str),
                "NAXIS1" => metadata.image_width = extract_int_value(&value_str),
                "NAXIS2" => metadata.image_height = extract_int_value(&value_str),
                "STACKCNT" | "NCOMBINE" => metadata.stacked_frames = extract_int_value(&value_str),
                "SWCREATE" | "SOFTWARE" => metadata.software = extract_string_value(&value_str),
                _ => {}
            }
        }
    }

    Ok(metadata)
}

fn extract_string_value(value: &str) -> Option<String> {
    // Try to extract string from various fitrs debug formats
    let trimmed = value.trim();

    // Handle Some(CharacterString("...")) format from fitrs debug output
    if trimmed.starts_with("Some(CharacterString(\"") && trimmed.ends_with("\"))") {
        let inner = &trimmed[22..trimmed.len() - 3];
        return Some(inner.trim().to_string());
    }

    // Handle CharacterString("...") format
    if trimmed.starts_with("CharacterString(\"") && trimmed.ends_with("\")") {
        let inner = &trimmed[17..trimmed.len() - 2];
        return Some(inner.trim().to_string());
    }

    // Handle Character("...") format
    if trimmed.starts_with("Character(\"") && trimmed.ends_with("\")") {
        let inner = &trimmed[11..trimmed.len() - 2];
        return Some(inner.trim().trim_matches('\'').to_string());
    }

    // Handle Some(RealFloatingNumber(...)) format (for RA/DEC as floats)
    if trimmed.starts_with("Some(RealFloatingNumber(") && trimmed.ends_with("))") {
        let num_str = &trimmed[24..trimmed.len() - 2];
        if let Ok(num) = num_str.parse::<f64>() {
            return Some(format!("{:.6}", num));
        }
    }

    // Handle RealFloatingNumber(...) format
    if trimmed.starts_with("RealFloatingNumber(") && trimmed.ends_with(")") {
        let num_str = &trimmed[19..trimmed.len() - 1];
        if let Ok(num) = num_str.parse::<f64>() {
            return Some(format!("{:.6}", num));
        }
    }

    // Handle quoted strings
    if trimmed.starts_with('"') && trimmed.ends_with('"') {
        return Some(trimmed[1..trimmed.len() - 1].trim().to_string());
    }
    if trimmed.starts_with('\'') && trimmed.ends_with('\'') {
        return Some(trimmed[1..trimmed.len() - 1].trim().to_string());
    }

    // Return as-is if no pattern matched
    if trimmed != "None" {
        Some(trimmed.to_string())
    } else {
        None
    }
}

fn extract_float_value(value: &str) -> Option<f64> {
    let trimmed = value.trim();

    // Handle Some(RealFloatingNumber(...)) format
    if trimmed.starts_with("Some(RealFloatingNumber(") && trimmed.ends_with("))") {
        return trimmed[24..trimmed.len() - 2].parse().ok();
    }

    // Handle RealFloatingNumber(...) format
    if trimmed.starts_with("RealFloatingNumber(") && trimmed.ends_with(")") {
        return trimmed[19..trimmed.len() - 1].parse().ok();
    }

    // Handle FloatingPoint(...) format
    if trimmed.starts_with("FloatingPoint(") && trimmed.ends_with(")") {
        return trimmed[14..trimmed.len() - 1].parse().ok();
    }

    // Handle Some(IntegerNumber(...)) format
    if trimmed.starts_with("Some(IntegerNumber(") && trimmed.ends_with("))") {
        return trimmed[19..trimmed.len() - 2].parse::<i64>().ok().map(|v| v as f64);
    }

    // Handle IntegerNumber(...) format
    if trimmed.starts_with("IntegerNumber(") && trimmed.ends_with(")") {
        return trimmed[14..trimmed.len() - 1].parse::<i64>().ok().map(|v| v as f64);
    }

    trimmed.parse().ok()
}

fn extract_int_value(value: &str) -> Option<i32> {
    let trimmed = value.trim();

    // Handle Some(IntegerNumber(...)) format
    if trimmed.starts_with("Some(IntegerNumber(") && trimmed.ends_with("))") {
        return trimmed[19..trimmed.len() - 2].parse().ok();
    }

    // Handle IntegerNumber(...) format
    if trimmed.starts_with("IntegerNumber(") && trimmed.ends_with(")") {
        return trimmed[14..trimmed.len() - 1].parse().ok();
    }

    // Handle Some(RealFloatingNumber(...)) format
    if trimmed.starts_with("Some(RealFloatingNumber(") && trimmed.ends_with("))") {
        return trimmed[24..trimmed.len() - 2].parse::<f64>().ok().map(|v| v as i32);
    }

    // Handle FloatingPoint(...) format
    if trimmed.starts_with("FloatingPoint(") && trimmed.ends_with(")") {
        return trimmed[14..trimmed.len() - 1].parse::<f64>().ok().map(|v| v as i32);
    }

    trimmed.parse().ok()
}

/// Determine session date from observation timestamp
/// Images after midnight but before noon are considered part of the previous day's session
fn get_session_date(date_obs: &str) -> Option<NaiveDate> {
    // Try parsing various date formats
    let datetime = if let Ok(dt) = NaiveDateTime::parse_from_str(date_obs, "%Y-%m-%dT%H:%M:%S%.f") {
        Some(dt)
    } else if let Ok(dt) = NaiveDateTime::parse_from_str(date_obs, "%Y-%m-%dT%H:%M:%S") {
        Some(dt)
    } else if let Ok(d) = NaiveDate::parse_from_str(date_obs, "%Y-%m-%d") {
        Some(d.and_time(NaiveTime::from_hms_opt(12, 0, 0)?))
    } else {
        None
    };

    datetime.map(|dt| {
        // If time is between midnight and noon, use previous day
        if dt.hour() < 12 {
            dt.date() - chrono::Duration::days(1)
        } else {
            dt.date()
        }
    })
}

/// Generate collection name from session date (one collection per night)
fn generate_collection_name(session_date: &NaiveDate, _object_name: Option<&str>) -> String {
    session_date.format("%Y-%m-%d").to_string()
}

/// Scan a directory for image files
fn scan_directory(directory: &Path, stacked_only: bool, max_files: Option<usize>) -> Vec<DiscoveredImage> {
    let mut images: HashMap<String, DiscoveredImage> = HashMap::new();

    for entry in WalkDir::new(directory)
        .follow_links(true)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();

        // Skip directories
        if path.is_dir() {
            continue;
        }

        // Get the filename
        let filename = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");

        // Skip macOS resource fork files (start with "._")
        if filename.starts_with("._") {
            continue;
        }

        // Check extension
        let extension = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase());

        let is_fits = extension.as_deref() == Some("fit") || extension.as_deref() == Some("fits");
        let is_jpeg = extension.as_deref() == Some("jpg") || extension.as_deref() == Some("jpeg");

        if !is_fits && !is_jpeg {
            continue;
        }

        // Get the file stem (name without extension)
        let file_stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string());

        let Some(stem) = file_stem else {
            continue;
        };

        // Skip Seestar thumbnail files (*thn.jpg)
        if is_jpeg && stem.to_lowercase().ends_with("thn") {
            continue;
        }

        // Check if this is a stacked image or raw subframe
        let is_stacked = stem.to_lowercase().starts_with("stacked");
        let is_light = stem.to_lowercase().starts_with("light");

        // Skip raw subframes if stacked_only is true
        if stacked_only && is_light {
            continue;
        }

        // Get parent directory
        let parent = path.parent().unwrap_or(directory).to_path_buf();

        // Create a unique key for this image (directory + stem)
        let key = format!("{}:{}", parent.display(), stem);

        // Update or create the discovered image entry
        let discovered = images.entry(key.clone()).or_insert_with(|| DiscoveredImage {
            base_name: stem.clone(),
            directory: parent.clone(),
            fits_path: None,
            jpeg_path: None,
            is_stacked,
        });

        if is_fits {
            discovered.fits_path = Some(path.to_path_buf());
        } else if is_jpeg {
            discovered.jpeg_path = Some(path.to_path_buf());
        }

        // Check if we've reached the max files limit
        if let Some(max) = max_files {
            if images.len() >= max {
                break;
            }
        }
    }

    // Apply max_files limit to the result
    let mut result: Vec<DiscoveredImage> = images.into_values().collect();
    if let Some(max) = max_files {
        result.truncate(max);
    }
    result
}

/// Process a single image: parse FITS metadata and generate thumbnail
/// This runs in a blocking task for CPU-intensive operations
async fn process_single_image(discovered: DiscoveredImage) -> ProcessedImage {
    let discovered_clone = discovered.clone();

    // Run CPU-intensive work in a blocking task
    tokio::task::spawn_blocking(move || {
        let mut processed = ProcessedImage {
            discovered: discovered_clone,
            metadata: None,
            thumbnail: None,
            error: None,
        };

        // Parse FITS metadata if we have a FITS file
        if let Some(fits_path) = &processed.discovered.fits_path {
            match parse_fits_metadata(fits_path) {
                Ok(m) => processed.metadata = Some(m),
                Err(e) => {
                    processed.error = Some(format!(
                        "Failed to parse {}: {}",
                        fits_path.display(),
                        e
                    ));
                    return processed;
                }
            }
        }

        // Generate thumbnail from JPEG if available
        if let Some(jpeg_path) = &processed.discovered.jpeg_path {
            match generate_thumbnail(jpeg_path) {
                Ok(thumb) => processed.thumbnail = Some(thumb),
                Err(e) => {
                    log::warn!("Failed to generate thumbnail for {}: {}", jpeg_path.display(), e);
                }
            }
        }

        processed
    })
    .await
    .unwrap_or_else(|e| ProcessedImage {
        discovered,
        metadata: None,
        thumbnail: None,
        error: Some(format!("Task panicked: {}", e)),
    })
}

/// Bulk scan a directory and import images (parallelized version)
#[tauri::command]
pub async fn bulk_scan_directory(
    window: tauri::Window,
    state: State<'_, AppState>,
    input: BulkScanInput,
) -> Result<BulkScanResult, String> {
    // Reset cancellation flag at start
    SCAN_CANCELLED.store(false, Ordering::SeqCst);

    // Clone what we need for the async block
    let db_pool = state.db.clone();
    let user_id = state.user_id.clone();

    let directory = PathBuf::from(&input.directory);
    if !directory.exists() {
        return Err(format!("Directory does not exist: {}", input.directory));
    }

    let mut result = BulkScanResult {
        images_imported: 0,
        collections_created: 0,
        images_skipped: 0,
        errors: Vec::new(),
    };

    // Emit "Scanning directory" progress
    let _ = window.emit("scan-progress", &ScanProgress {
        current: 0,
        total: 0,
        current_file: format!("Scanning directory: {}...", directory.display()),
        percent: 0,
        skipped: 0,
        cancelled: false,
    });

    // Scan directory for images
    let discovered_images = scan_directory(&directory, input.stacked_only, input.max_files);
    let total_discovered = discovered_images.len();

    if total_discovered == 0 {
        let _ = window.emit("scan-progress", &ScanProgress {
            current: 0,
            total: 0,
            current_file: "No images found".to_string(),
            percent: 100,
            skipped: 0,
            cancelled: false,
        });
        return Ok(result);
    }

    // Emit "Found images" progress
    let _ = window.emit("scan-progress", &ScanProgress {
        current: 0,
        total: total_discovered,
        current_file: format!("Found {} images, loading database...", total_discovered),
        percent: 0,
        skipped: 0,
        cancelled: false,
    });

    // Check for cancellation
    if SCAN_CANCELLED.load(Ordering::SeqCst) {
        return Ok(result);
    }

    // === PHASE 1: Pre-load existing data for efficient duplicate checking ===
    let existing_urls: HashSet<String> = {
        let mut conn = db_pool.get().map_err(|e| e.to_string())?;
        repository::get_all_image_urls(&mut conn, &user_id)
            .map_err(|e| e.to_string())?
            .into_iter()
            .collect()
    };

    // Emit progress after loading URLs
    let _ = window.emit("scan-progress", &ScanProgress {
        current: 0,
        total: total_discovered,
        current_file: format!("Loaded {} existing image records...", existing_urls.len()),
        percent: 0,
        skipped: 0,
        cancelled: false,
    });

    // Check for cancellation
    if SCAN_CANCELLED.load(Ordering::SeqCst) {
        return Ok(result);
    }

    // Pre-load URL to image ID mapping for images we need to add to collections
    let url_to_image_id: HashMap<String, String> = {
        let mut conn = db_pool.get().map_err(|e| e.to_string())?;
        let images = repository::get_images_by_user(&mut conn, &user_id)
            .map_err(|e| e.to_string())?;
        images
            .into_iter()
            .filter_map(|img| img.url.map(|url| (url, img.id)))
            .collect()
    };

    // Pre-load collection-image pairs
    let existing_collection_images: HashSet<(String, String)> = {
        let mut conn = db_pool.get().map_err(|e| e.to_string())?;
        repository::get_all_collection_image_pairs(&mut conn)
            .map_err(|e| e.to_string())?
            .into_iter()
            .collect()
    };

    // Emit "Filtering duplicates" progress
    let _ = window.emit("scan-progress", &ScanProgress {
        current: 0,
        total: total_discovered,
        current_file: "Checking for duplicates...".to_string(),
        percent: 0,
        skipped: 0,
        cancelled: false,
    });

    // Check for cancellation
    if SCAN_CANCELLED.load(Ordering::SeqCst) {
        return Ok(result);
    }

    // === PRE-FILTER: Separate new images from duplicates ===
    // This ensures progress bar shows actual work to be done
    let mut new_images: Vec<DiscoveredImage> = Vec::new();
    let mut duplicate_images: Vec<DiscoveredImage> = Vec::new();

    for discovered in discovered_images {
        // Build URL for duplicate checking
        let url = discovered
            .jpeg_path
            .as_ref()
            .or(discovered.fits_path.as_ref())
            .map(|p| p.to_string_lossy().to_string());

        if let Some(ref url_str) = url {
            if existing_urls.contains(url_str) {
                duplicate_images.push(discovered);
            } else {
                new_images.push(discovered);
            }
        } else {
            new_images.push(discovered);
        }
    }

    let skipped_duplicates = duplicate_images.len();
    result.images_skipped = skipped_duplicates;
    let total_to_process = new_images.len();

    // Emit initial progress showing duplicates already skipped
    let _ = window.emit("scan-progress", &ScanProgress {
        current: 0,
        total: total_discovered,
        current_file: format!("Found {} new images ({} duplicates skipped)", total_to_process, skipped_duplicates),
        percent: 0,
        skipped: skipped_duplicates,
        cancelled: false,
    });

    // If all images are duplicates, we're done
    if total_to_process == 0 {
        let _ = window.emit("scan-progress", &ScanProgress {
            current: total_discovered,
            total: total_discovered,
            current_file: "All images already exist".to_string(),
            percent: 100,
            skipped: skipped_duplicates,
            cancelled: false,
        });
        return Ok(result);
    }

    // Check for cancellation
    if SCAN_CANCELLED.load(Ordering::SeqCst) {
        let _ = window.emit("scan-progress", &ScanProgress {
            current: 0,
            total: total_discovered,
            current_file: "Cancelled".to_string(),
            percent: 0,
            skipped: skipped_duplicates,
            cancelled: true,
        });
        return Ok(result);
    }

    // === PHASE 2: Parallel processing of FITS metadata and thumbnails (new images only) ===
    let semaphore = Arc::new(Semaphore::new(MAX_PARALLEL_PROCESSING));
    let mut processing_tasks = Vec::with_capacity(total_to_process);

    for discovered in new_images {
        // Check for cancellation before spawning new tasks
        if SCAN_CANCELLED.load(Ordering::SeqCst) {
            break;
        }

        let permit = semaphore.clone().acquire_owned().await.unwrap();
        let task = tokio::spawn(async move {
            let result = process_single_image(discovered).await;
            drop(permit); // Release semaphore
            result
        });
        processing_tasks.push(task);
    }

    // Collect all processed results
    let mut processed_images = Vec::with_capacity(total_to_process);
    for (index, task) in processing_tasks.into_iter().enumerate() {
        // Check for cancellation
        if SCAN_CANCELLED.load(Ordering::SeqCst) {
            task.abort();
            let _ = window.emit("scan-progress", &ScanProgress {
                current: skipped_duplicates + index,
                total: total_discovered,
                current_file: "Cancelled".to_string(),
                percent: ((skipped_duplicates + index) * 100 / total_discovered) as u8,
                skipped: skipped_duplicates,
                cancelled: true,
            });
            return Ok(result);
        }

        match task.await {
            Ok(processed) => {
                // Emit progress (include skipped in the count for accurate percentage)
                let progress_current = skipped_duplicates + index + 1;
                let _ = window.emit("scan-progress", &ScanProgress {
                    current: progress_current,
                    total: total_discovered,
                    current_file: processed.discovered.base_name.clone(),
                    percent: (progress_current * 50 / total_discovered) as u8, // 0-50% for processing
                    skipped: skipped_duplicates,
                    cancelled: false,
                });
                processed_images.push(processed);
            }
            Err(e) => {
                if e.is_cancelled() {
                    // Task was cancelled, don't count as error
                    continue;
                }
                result.errors.push(format!("Task failed: {}", e));
                result.images_skipped += 1;
            }
        }
    }

    let total_images = total_discovered;

    // === PHASE 3: Sequential database operations ===
    let mut conn = db_pool.get().map_err(|e| e.to_string())?;

    // Track collections by session date to avoid duplicates
    let mut session_collections: HashMap<String, String> = HashMap::new();
    let processed_count = processed_images.len();

    for (index, processed) in processed_images.into_iter().enumerate() {
        // Check for cancellation
        if SCAN_CANCELLED.load(Ordering::SeqCst) {
            let _ = window.emit("scan-progress", &ScanProgress {
                current: skipped_duplicates + index,
                total: total_images,
                current_file: "Cancelled".to_string(),
                percent: ((skipped_duplicates + index) * 100 / total_images) as u8,
                skipped: result.images_skipped,
                cancelled: true,
            });
            return Ok(result);
        }

        // Emit progress (50-100% for DB operations)
        // Calculate progress: skipped duplicates are already counted, now add processed items
        let progress_current = skipped_duplicates + index + 1;
        let _ = window.emit("scan-progress", &ScanProgress {
            current: progress_current,
            total: total_images,
            current_file: processed.discovered.base_name.clone(),
            percent: (50 + (index + 1) * 50 / processed_count.max(1)) as u8,
            skipped: result.images_skipped,
            cancelled: false,
        });

        // Skip if processing failed
        if let Some(error) = processed.error {
            result.errors.push(error);
            result.images_skipped += 1;
            continue;
        }

        // We need metadata to proceed
        let Some(metadata) = processed.metadata else {
            result.images_skipped += 1;
            continue;
        };

        // Build URL (already validated as non-duplicate in pre-filter phase)
        let url = processed.discovered
            .jpeg_path
            .as_ref()
            .or(processed.discovered.fits_path.as_ref())
            .map(|p| p.to_string_lossy().to_string());

        // Determine session date and get/create collection
        let session_date = metadata
            .date_obs
            .as_ref()
            .and_then(|d| get_session_date(d));

        let collection_id = if let Some(date) = session_date {
            let collection_key = format!("{}", date);

            if let Some(id) = session_collections.get(&collection_key) {
                id.clone()
            } else {
                let collection_name =
                    generate_collection_name(&date, metadata.object_name.as_deref());

                match repository::get_collection_by_name(&mut conn, &user_id, &collection_name) {
                    Ok(Some(existing)) => {
                        session_collections.insert(collection_key, existing.id.clone());
                        existing.id
                    }
                    Ok(None) => {
                        let new_collection = NewCollection {
                            id: uuid::Uuid::new_v4().to_string(),
                            user_id: user_id.clone(),
                            name: collection_name,
                            description: Some(format!(
                                "Auto-imported from {}",
                                directory.display()
                            )),
                            visibility: "private".to_string(),
                            template: Some("astrolog".to_string()),
                            favorite: false,
                            tags: input.tags.clone(),
                            metadata: Some(
                                serde_json::json!({
                                    "session_date": date.to_string(),
                                    "auto_imported": true,
                                    "source_directory": directory.to_string_lossy(),
                                })
                                .to_string(),
                            ),
                            archived: false,
                        };

                        match repository::create_collection(&mut conn, &new_collection) {
                            Ok(c) => {
                                result.collections_created += 1;
                                session_collections.insert(collection_key, c.id.clone());
                                c.id
                            }
                            Err(e) => {
                                result.errors.push(format!("Failed to create collection: {}", e));
                                continue;
                            }
                        }
                    }
                    Err(e) => {
                        result.errors.push(format!("Failed to check for existing collection: {}", e));
                        continue;
                    }
                }
            }
        } else {
            // No date - use a generic "Unknown Session" collection
            let unknown_key = "unknown".to_string();
            if let Some(id) = session_collections.get(&unknown_key) {
                id.clone()
            } else {
                let collection_name = "Unknown Session".to_string();

                match repository::get_collection_by_name(&mut conn, &user_id, &collection_name) {
                    Ok(Some(existing)) => {
                        session_collections.insert(unknown_key, existing.id.clone());
                        existing.id
                    }
                    Ok(None) => {
                        let new_collection = NewCollection {
                            id: uuid::Uuid::new_v4().to_string(),
                            user_id: user_id.clone(),
                            name: collection_name,
                            description: Some(format!(
                                "Auto-imported from {} (no date metadata)",
                                directory.display()
                            )),
                            visibility: "private".to_string(),
                            template: Some("astrolog".to_string()),
                            favorite: false,
                            tags: input.tags.clone(),
                            metadata: Some(
                                serde_json::json!({
                                    "auto_imported": true,
                                    "source_directory": directory.to_string_lossy(),
                                })
                                .to_string(),
                            ),
                            archived: false,
                        };

                        match repository::create_collection(&mut conn, &new_collection) {
                            Ok(c) => {
                                result.collections_created += 1;
                                session_collections.insert(unknown_key, c.id.clone());
                                c.id
                            }
                            Err(e) => {
                                result.errors.push(format!("Failed to create collection: {}", e));
                                continue;
                            }
                        }
                    }
                    Err(e) => {
                        result.errors.push(format!("Failed to check for existing collection: {}", e));
                        continue;
                    }
                }
            }
        };

        // Check if image already exists using pre-loaded data (O(1) lookup)
        if let Some(ref url_str) = url {
            if existing_urls.contains(url_str) {
                // Image exists, check if it needs to be added to collection
                if let Some(image_id) = url_to_image_id.get(url_str) {
                    let pair = (collection_id.clone(), image_id.clone());
                    if !existing_collection_images.contains(&pair) {
                        let collection_image = NewCollectionImage {
                            id: uuid::Uuid::new_v4().to_string(),
                            collection_id: collection_id.clone(),
                            image_id: image_id.clone(),
                        };
                        let _ = repository::add_image_to_collection(&mut conn, &collection_image);
                    }
                }
                result.images_skipped += 1;
                continue;
            }
        }

        // Build image record
        let filename = processed.discovered.base_name.clone();
        let summary = metadata.object_name.clone();
        let description = build_description(&metadata);

        // Combine user tags with auto-detected tags
        let mut all_tags = Vec::new();
        if let Some(user_tags) = &input.tags {
            all_tags.push(user_tags.clone());
        }
        if processed.discovered.is_stacked {
            all_tags.push("stacked".to_string());
        }
        if metadata.telescope.as_ref().map(|t| t.to_lowercase().contains("seestar")).unwrap_or(false) {
            all_tags.push("seestar".to_string());
        }
        let tags_str = if all_tags.is_empty() {
            None
        } else {
            Some(all_tags.join(", "))
        };

        let metadata_json = serde_json::to_string(&metadata).ok();

        let new_image = NewImage {
            id: uuid::Uuid::new_v4().to_string(),
            user_id: user_id.clone(),
            collection_id: None,
            filename,
            url,
            summary,
            description: Some(description),
            content_type: Some("image/jpeg".to_string()),
            favorite: false,
            tags: tags_str,
            visibility: Some("private".to_string()),
            location: metadata.ra.as_ref().zip(metadata.dec.as_ref()).map(|(ra, dec)| format!("{}, {}", ra, dec)),
            annotations: None,
            metadata: metadata_json,
            thumbnail: processed.thumbnail,
        };

        // Insert image
        let image = match repository::create_image(&mut conn, &new_image) {
            Ok(img) => img,
            Err(e) => {
                result.errors.push(format!(
                    "Failed to create image {}: {}",
                    processed.discovered.base_name, e
                ));
                result.images_skipped += 1;
                continue;
            }
        };

        // Add image to collection via join table
        let collection_image = NewCollectionImage {
            id: uuid::Uuid::new_v4().to_string(),
            collection_id: collection_id.clone(),
            image_id: image.id.clone(),
        };

        if let Err(e) = repository::add_image_to_collection(&mut conn, &collection_image) {
            result.errors.push(format!(
                "Failed to add image to collection: {}",
                e
            ));
        }

        result.images_imported += 1;
    }

    Ok(result)
}

/// Build a description string from FITS metadata
fn build_description(metadata: &FitsMetadata) -> String {
    let mut parts = Vec::new();

    if let Some(obj) = &metadata.object_name {
        parts.push(format!("**Object:** {}", obj));
    }

    if let Some(telescope) = &metadata.telescope {
        parts.push(format!("**Telescope:** {}", telescope));
    }

    if let Some(exp) = metadata.exposure {
        parts.push(format!("**Exposure:** {:.1}s", exp));
    }

    if let Some(frames) = metadata.stacked_frames {
        parts.push(format!("**Stacked Frames:** {}", frames));
    }

    if let Some(gain) = metadata.gain {
        parts.push(format!("**Gain:** {}", gain));
    }

    if let Some(filter) = &metadata.filter {
        parts.push(format!("**Filter:** {}", filter));
    }

    if let (Some(w), Some(h)) = (metadata.image_width, metadata.image_height) {
        parts.push(format!("**Resolution:** {}x{}", w, h));
    }

    if let Some(date) = &metadata.date_obs {
        parts.push(format!("**Date:** {}", date));
    }

    parts.join("\n")
}

/// Preview scan results without importing
#[tauri::command]
pub fn preview_bulk_scan(
    input: BulkScanInput,
) -> Result<BulkScanPreview, String> {
    let directory = PathBuf::from(&input.directory);
    if !directory.exists() {
        return Err(format!("Directory does not exist: {}", input.directory));
    }

    let discovered_images = scan_directory(&directory, input.stacked_only, input.max_files);

    let mut preview = BulkScanPreview {
        total_images: discovered_images.len(),
        stacked_images: 0,
        raw_subframes: 0,
        with_fits: 0,
        with_jpeg: 0,
        sample_files: Vec::new(),
    };

    for img in &discovered_images {
        if img.is_stacked {
            preview.stacked_images += 1;
        } else {
            preview.raw_subframes += 1;
        }

        if img.fits_path.is_some() {
            preview.with_fits += 1;
        }

        if img.jpeg_path.is_some() {
            preview.with_jpeg += 1;
        }

        // Add sample files (up to 10)
        if preview.sample_files.len() < 10 {
            preview.sample_files.push(PreviewFile {
                name: img.base_name.clone(),
                directory: img.directory.to_string_lossy().to_string(),
                has_fits: img.fits_path.is_some(),
                has_jpeg: img.jpeg_path.is_some(),
                is_stacked: img.is_stacked,
            });
        }
    }

    Ok(preview)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BulkScanPreview {
    pub total_images: usize,
    pub stacked_images: usize,
    pub raw_subframes: usize,
    pub with_fits: usize,
    pub with_jpeg: usize,
    pub sample_files: Vec<PreviewFile>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PreviewFile {
    pub name: String,
    pub directory: String,
    pub has_fits: bool,
    pub has_jpeg: bool,
    pub is_stacked: bool,
}
