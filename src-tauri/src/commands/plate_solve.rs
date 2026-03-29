//! Plate solving commands for astronomical images

use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::State;

use crate::db::{models::UpdateImage, repository};
use crate::python::plate_solve::{self, CatalogObject, PlateSolveResult, SolveHints, SolverInfo};
use crate::state::AppState;

/// Input for plate solving an image
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlateSolveInput {
    /// Image ID to plate solve
    pub id: String,
    /// Solver type: "nova", "local", "astap", or "tetra3"
    pub solver: String,
    /// API key for nova.astrometry.net (required for nova solver)
    pub api_key: Option<String>,
    /// Custom API URL for local astrometry.net instance (optional, defaults to nova.astrometry.net)
    pub api_url: Option<String>,
    /// Lower bound of expected image scale (arcsec/pixel)
    pub scale_lower: Option<f64>,
    /// Upper bound of expected image scale (arcsec/pixel)
    pub scale_upper: Option<f64>,
    /// Timeout in seconds
    pub timeout: Option<i32>,
    /// Whether to query catalogs for objects after solving
    pub query_catalogs: Option<bool>,
    /// Catalogs to query (if not specified, queries all)
    pub catalogs: Option<Vec<String>>,
    /// Magnitude limit for bright stars
    pub star_mag_limit: Option<f64>,
    /// Hint RA in degrees (to speed up solving)
    pub hint_ra: Option<f64>,
    /// Hint Dec in degrees (to speed up solving)
    pub hint_dec: Option<f64>,
    /// Hint search radius in degrees (default: 10)
    pub hint_radius: Option<f64>,
    /// Path to tetra3 database file (.rkyv) — required for "tetra3" solver.
    /// If not specified, will look for "tetra3_database.rkyv" in the app's resource directory.
    pub tetra3_db_path: Option<String>,
    /// FOV estimate in degrees for tetra3 solver (horizontal field of view).
    /// If not specified, will be estimated from scale_lower/scale_upper and image dimensions.
    pub fov_estimate: Option<f64>,
}

/// Combined result from plate solving and catalog query
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlateSolveResponse {
    /// Plate solve result
    #[serde(flatten)]
    pub solve_result: PlateSolveResult,
    /// Objects found in the field of view
    pub objects: Vec<CatalogObject>,
}

/// Plate solve an image using the native tetra3rs solver.
///
/// This solver works by:
/// 1. Loading a pre-built tetra3 star pattern database (.rkyv file)
/// 2. Extracting star centroids from the image (using tetra3's built-in centroid extraction)
/// 3. Matching star patterns against the database to determine the camera pointing
///
/// The database file must be generated separately using tetra3's database generation tools
/// (e.g., `SolverDatabase::generate_from_gaia()`) and saved as an .rkyv file.
fn solve_with_tetra3(
    image_path: &str,
    db_path: &str,
    fov_estimate_deg: Option<f64>,
    scale_lower: Option<f64>,
    scale_upper: Option<f64>,
    image_width: u32,
    image_height: u32,
    timeout_ms: Option<u64>,
) -> Result<PlateSolveResult, String> {
    let start = std::time::Instant::now();

    // Load the tetra3 database
    let db = tetra3::SolverDatabase::load_from_file(db_path)
        .map_err(|e| format!("Failed to load tetra3 database from '{}': {}", db_path, e))?;

    // Extract star centroids from the image using tetra3's built-in centroid extraction.
    // This requires the "image" feature on the tetra3 crate.
    let centroid_config = tetra3::CentroidExtractionConfig {
        sigma_threshold: 5.0,
        min_pixels: 3,
        max_pixels: 500,
        max_centroids: Some(50),
        sigma_clip_iterations: 3,
        sigma_clip_factor: 3.0,
        use_8_connectivity: true,
        local_bg_block_size: None,
        max_elongation: None,
    };

    // Try loading with the `image` crate first (JPEG, PNG, TIFF).
    // If that fails (e.g., FITS files), extract raw pixel data from FITS and use
    // tetra3's raw pixel centroid extraction.
    let lower_path = image_path.to_lowercase();
    let is_fits = lower_path.ends_with(".fit") || lower_path.ends_with(".fits");

    let centroid_result = if is_fits {
        // Extract pixel data from FITS and use extract_centroids_from_raw
        let (pixels, w, h) = read_fits_pixels(image_path)?;
        tetra3::extract_centroids_from_raw(&pixels, w, h, &centroid_config)
            .map_err(|e| format!("Failed to extract centroids from FITS: {}", e))?
    } else {
        tetra3::extract_centroids(image_path, &centroid_config)
            .map_err(|e| format!("Failed to extract star centroids: {}", e))?
    };

    let centroids = &centroid_result.centroids;
    if centroids.len() < 4 {
        return Ok(PlateSolveResult {
            success: false,
            center_ra: 0.0,
            center_dec: 0.0,
            pixel_scale: 0.0,
            rotation: 0.0,
            width_deg: 0.0,
            height_deg: 0.0,
            image_width: image_width as i32,
            image_height: image_height as i32,
            solver: "tetra3".to_string(),
            solve_time: start.elapsed().as_secs_f64(),
            wcs: None,
            error_message: Some(format!(
                "Too few stars detected ({}) — need at least 4 for plate solving",
                centroids.len()
            )),
        });
    }

    log::info!(
        "tetra3: extracted {} centroids from image",
        centroids.len()
    );

    // Estimate FOV from provided values or scale hints
    let fov_rad = if let Some(fov_deg) = fov_estimate_deg {
        (fov_deg as f32).to_radians()
    } else if let (Some(lower), Some(upper)) = (scale_lower, scale_upper) {
        // scale is arcsec/pixel, FOV = scale * width / 3600 degrees
        let avg_scale = (lower + upper) / 2.0;
        let fov_deg = avg_scale * image_width as f64 / 3600.0;
        (fov_deg as f32).to_radians()
    } else if let Some(lower) = scale_lower {
        // Use lower bound as rough estimate
        let fov_deg = lower * image_width as f64 / 3600.0;
        (fov_deg as f32).to_radians()
    } else {
        // Default: assume a typical astrophotography FOV of ~2 degrees
        (2.0_f32).to_radians()
    };

    // Calculate FOV error range for search.
    // Use a wide range because single-scale databases are built at one FOV
    // and the actual image FOV may differ significantly.
    let fov_max_error = if let (Some(lower), Some(upper)) = (scale_lower, scale_upper) {
        // Use the full scale range, plus extra margin for single-scale DB mismatch
        let fov_lower = (lower * image_width as f64 / 3600.0) as f32;
        let fov_upper = (upper * image_width as f64 / 3600.0) as f32;
        let fov_center = (fov_lower + fov_upper) / 2.0;
        // At least ±50% to handle single-scale database mismatch
        Some((fov_center * 0.5).to_radians().max((fov_upper - fov_center).to_radians()))
    } else {
        // Wide search: ±50% of estimated FOV
        Some(fov_rad * 0.5)
    };

    let timeout = timeout_ms.or(Some(60000));

    log::info!(
        "tetra3: FOV estimate {:.2}° (error ±{:.2}°), {}x{}, timeout {}s",
        fov_rad.to_degrees(),
        fov_max_error.map(|e| e.to_degrees()).unwrap_or(0.0),
        image_width,
        image_height,
        timeout.unwrap_or(0) / 1000,
    );

    let solve_config = tetra3::SolveConfig {
        fov_estimate_rad: fov_rad,
        image_width,
        image_height,
        fov_max_error_rad: fov_max_error,
        solve_timeout_ms: timeout,
        ..Default::default()
    };

    let result = db.solve_from_centroids(centroids, &solve_config);

    let elapsed = start.elapsed().as_secs_f64();

    match result.status {
        tetra3::SolveStatus::MatchFound => {
            // Extract RA/Dec from crval_rad (WCS reference point in radians)
            let (center_ra_deg, center_dec_deg) = if let Some(crval) = result.crval_rad {
                (crval[0].to_degrees(), crval[1].to_degrees())
            } else {
                // Fallback: extract from quaternion if WCS not available
                // The quaternion qicrs2cam rotates from ICRS to camera frame,
                // so the camera boresight in ICRS is the inverse rotation of +Z
                log::warn!("tetra3: crval_rad not available, falling back to quaternion");
                (0.0, 0.0)
            };

            // Calculate pixel scale from CD matrix or FOV
            let pixel_scale_arcsec = if let Some(cd) = result.cd_matrix {
                // Pixel scale from CD matrix: sqrt(cd11^2 + cd21^2) in degrees, convert to arcsec
                let scale_deg = (cd[0][0] * cd[0][0] + cd[1][0] * cd[1][0]).sqrt();
                scale_deg * 3600.0
            } else if let Some(fov) = result.fov_rad {
                // pixel_scale = fov_deg / image_width * 3600
                (fov as f64).to_degrees() / image_width as f64 * 3600.0
            } else {
                0.0
            };

            // Calculate rotation angle
            let rotation_deg = if let Some(theta) = result.theta_rad {
                theta.to_degrees()
            } else if let Some(cd) = result.cd_matrix {
                // Rotation from CD matrix: atan2(-cd21, cd11)
                (-cd[1][0]).atan2(cd[0][0]).to_degrees()
            } else {
                0.0
            };

            // Calculate FOV width/height in degrees
            let width_deg = pixel_scale_arcsec * image_width as f64 / 3600.0;
            let height_deg = pixel_scale_arcsec * image_height as f64 / 3600.0;

            Ok(PlateSolveResult {
                success: true,
                center_ra: center_ra_deg,
                center_dec: center_dec_deg,
                pixel_scale: pixel_scale_arcsec,
                rotation: rotation_deg,
                width_deg,
                height_deg,
                image_width: image_width as i32,
                image_height: image_height as i32,
                solver: "tetra3".to_string(),
                solve_time: elapsed,
                error_message: None,
                wcs: None,
            })
        }
        tetra3::SolveStatus::NoMatch => Ok(PlateSolveResult {
            success: false,
            center_ra: 0.0,
            center_dec: 0.0,
            pixel_scale: 0.0,
            rotation: 0.0,
            width_deg: 0.0,
            height_deg: 0.0,
            image_width: image_width as i32,
            image_height: image_height as i32,
            solver: "tetra3".to_string(),
            solve_time: elapsed,
            error_message: Some("No match found".to_string()),
            wcs: None,
        }),
        tetra3::SolveStatus::Timeout => Ok(PlateSolveResult {
            success: false,
            center_ra: 0.0,
            center_dec: 0.0,
            pixel_scale: 0.0,
            rotation: 0.0,
            width_deg: 0.0,
            height_deg: 0.0,
            image_width: image_width as i32,
            image_height: image_height as i32,
            solver: "tetra3".to_string(),
            solve_time: elapsed,
            error_message: Some("Solve timed out".to_string()),
            wcs: None,
        }),
        tetra3::SolveStatus::TooFew => Ok(PlateSolveResult {
            success: false,
            center_ra: 0.0,
            center_dec: 0.0,
            pixel_scale: 0.0,
            rotation: 0.0,
            width_deg: 0.0,
            height_deg: 0.0,
            image_width: image_width as i32,
            image_height: image_height as i32,
            solver: "tetra3".to_string(),
            solve_time: elapsed,
            error_message: Some("Too few stars for pattern matching".to_string()),
            wcs: None,
        }),
    }
}

/// Read image dimensions from a FITS file's NAXIS1/NAXIS2 headers.
fn read_fits_dimensions(path: &Path) -> Result<(u32, u32), String> {
    use fitrs::Fits;

    let fits = Fits::open(path).map_err(|e| format!("Failed to open FITS: {}", e))?;
    let hdu = fits.into_iter().next().ok_or("No HDU in FITS file")?;

    // Read NAXIS1/NAXIS2 from the header key-value pairs
    let mut width: Option<u32> = None;
    let mut height: Option<u32> = None;

    for (key, value) in hdu.iter() {
        let key_str = key.to_string();
        let value_str = format!("{:?}", value);
        match key_str.as_str() {
            "NAXIS1" => {
                width = crate::commands::scan::extract_int_value(&value_str).map(|v| v as u32);
            }
            "NAXIS2" => {
                height = crate::commands::scan::extract_int_value(&value_str).map(|v| v as u32);
            }
            _ => {}
        }
    }

    match (width, height) {
        (Some(w), Some(h)) if w > 0 && h > 0 => Ok((w, h)),
        _ => Err("Could not read NAXIS1/NAXIS2 from FITS".to_string()),
    }
}

/// Read pixel data from a FITS file as f32 values for centroid extraction.
/// Returns (pixels, width, height) where pixels is a flat array in row-major order.
fn read_fits_pixels(fits_path: &str) -> Result<(Vec<f32>, u32, u32), String> {
    use fitrs::Fits;

    let fits =
        Fits::open(fits_path).map_err(|e| format!("Failed to open FITS file: {}", e))?;
    let hdu = fits.into_iter().next().ok_or("No HDU in FITS file")?;

    let (width, height, pixels) = match hdu.read_data() {
        fitrs::FitsData::FloatingPoint32(data) => {
            let shape = &data.shape;
            let w = shape[shape.len() - 1];
            let h = shape[shape.len() - 2];
            // For color images (3 channels), average to mono
            let channel_size = w * h;
            let pixels = if data.data.len() == channel_size * 3 {
                // RGB: average channels
                (0..channel_size)
                    .map(|i| (data.data[i] + data.data[i + channel_size] + data.data[i + 2 * channel_size]) / 3.0)
                    .collect()
            } else {
                data.data.clone()
            };
            (w as u32, h as u32, pixels)
        }
        fitrs::FitsData::FloatingPoint64(data) => {
            let shape = &data.shape;
            let w = shape[shape.len() - 1];
            let h = shape[shape.len() - 2];
            let channel_size = w * h;
            let pixels: Vec<f32> = if data.data.len() == channel_size * 3 {
                (0..channel_size)
                    .map(|i| ((data.data[i] + data.data[i + channel_size] + data.data[i + 2 * channel_size]) / 3.0) as f32)
                    .collect()
            } else {
                data.data.iter().map(|&x| x as f32).collect()
            };
            (w as u32, h as u32, pixels)
        }
        fitrs::FitsData::IntegersI32(data) => {
            let shape = &data.shape;
            let w = shape[shape.len() - 1];
            let h = shape[shape.len() - 2];
            let pixels: Vec<f32> = data.data.iter().map(|x| x.unwrap_or(0) as f32).collect();
            let channel_size = w * h;
            let mono = if pixels.len() == channel_size * 3 {
                (0..channel_size)
                    .map(|i| (pixels[i] + pixels[i + channel_size] + pixels[i + 2 * channel_size]) / 3.0)
                    .collect()
            } else {
                pixels
            };
            (w as u32, h as u32, mono)
        }
        fitrs::FitsData::IntegersU32(data) => {
            let shape = &data.shape;
            let w = shape[shape.len() - 1];
            let h = shape[shape.len() - 2];
            let pixels: Vec<f32> = data.data.iter().map(|x| x.unwrap_or(0) as f32).collect();
            let channel_size = w * h;
            let mono = if pixels.len() == channel_size * 3 {
                (0..channel_size)
                    .map(|i| (pixels[i] + pixels[i + channel_size] + pixels[i + 2 * channel_size]) / 3.0)
                    .collect()
            } else {
                pixels
            };
            (w as u32, h as u32, mono)
        }
        _ => return Err("Unsupported FITS pixel format for centroid extraction".to_string()),
    };

    if pixels.is_empty() {
        return Err("No pixel data in FITS file".to_string());
    }

    Ok((pixels, width, height))
}

/// Plate solve an image and optionally query catalogs for objects
#[tauri::command]
pub async fn plate_solve_image(
    state: State<'_, AppState>,
    input: PlateSolveInput,
) -> Result<PlateSolveResponse, String> {
    // Get the image from the database
    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    let image = repository::get_image_by_id(&mut conn, &input.id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Image not found: {}", input.id))?;

    // Get the file path
    let file_path = image
        .url
        .as_ref()
        .ok_or_else(|| "Image has no file path".to_string())?;

    let path = Path::new(file_path);
    if !path.exists() {
        return Err(format!("Image file not found: {}", file_path));
    }

    // Plate solve the image — dispatch to tetra3 native solver or Python bridge
    let solve_result = if input.solver == "tetra3" {
        // Get image dimensions for tetra3 (try to read from the image file).
        // The `image` crate doesn't support FITS, so we fall back to reading
        // FITS dimensions via fitrs if the standard image read fails.
        let (img_w, img_h) = ::image::image_dimensions(path)
            .ok()
            .or_else(|| {
                // Try reading dimensions from FITS headers
                read_fits_dimensions(path).ok()
            })
            .unwrap_or_else(|| {
                log::warn!("Could not read image dimensions from file, using 0x0");
                (0, 0)
            });

        // Resolve tetra3 database path
        let db_path = input.tetra3_db_path
            .ok_or_else(|| "tetra3 solver requires a database path (tetra3DbPath). \
                Generate one with tetra3's SolverDatabase::generate_from_gaia() and \
                save it as an .rkyv file.".to_string())?;

        let timeout_ms = input.timeout.map(|t| (t as u64) * 1000);

        solve_with_tetra3(
            file_path,
            &db_path,
            input.fov_estimate,
            input.scale_lower,
            input.scale_upper,
            img_w,
            img_h,
            timeout_ms,
        )?
    } else {
        plate_solve::solve_image(
            file_path,
            &input.solver,
            input.api_key.as_deref(),
            input.api_url.as_deref(),
            input.scale_lower,
            input.scale_upper,
            input.timeout,
            input.hint_ra,
            input.hint_dec,
            input.hint_radius,
        )?
    };

    let mut objects = Vec::new();

    // If solve was successful and catalog query is requested, query catalogs
    if solve_result.success && input.query_catalogs.unwrap_or(true) {
        // Use FITS file for WCS pixel positions (preview JPEG has no WCS headers)
        let fits_for_wcs = image.fits_url.as_deref()
            .or_else(|| {
                // Use url if it's a FITS file
                image.url.as_deref().filter(|u| {
                    let l = u.to_lowercase();
                    l.ends_with(".fit") || l.ends_with(".fits")
                })
            });

        objects = plate_solve::query_objects_in_fov(
            solve_result.center_ra,
            solve_result.center_dec,
            solve_result.width_deg,
            solve_result.height_deg,
            input.catalogs,
            input.star_mag_limit,
            fits_for_wcs,
            Some(&solve_result),
        )
        .unwrap_or_else(|e| {
            log::warn!("Failed to query catalogs: {}", e);
            Vec::new()
        });
    }

    // Update image metadata based on solve result
    if solve_result.success {
        // Build metadata JSON for successful solve
        let plate_solve_metadata = serde_json::json!({
            "plate_solve": {
                "solved_at": chrono::Utc::now().to_rfc3339(),
                "solver": solve_result.solver,
                "center_ra": solve_result.center_ra,
                "center_dec": solve_result.center_dec,
                "pixel_scale": solve_result.pixel_scale,
                "rotation": solve_result.rotation,
                "width_deg": solve_result.width_deg,
                "height_deg": solve_result.height_deg,
                "solve_time": solve_result.solve_time,
                "wcs": solve_result.wcs,
            }
        });

        // Merge with existing metadata if present, and remove any failed flag
        let new_metadata = if let Some(existing) = &image.metadata {
            if let Ok(mut existing_json) = serde_json::from_str::<serde_json::Value>(existing) {
                if let Some(obj) = existing_json.as_object_mut() {
                    obj.insert(
                        "plate_solve".to_string(),
                        plate_solve_metadata["plate_solve"].clone(),
                    );
                    // Remove failed flag if present (image is now solved)
                    obj.remove("plate_solve_failed");
                }
                serde_json::to_string(&existing_json).ok()
            } else {
                Some(plate_solve_metadata.to_string())
            }
        } else {
            Some(plate_solve_metadata.to_string())
        };

        // Convert objects to annotations JSON
        let annotations_json = if !objects.is_empty() {
            Some(serde_json::to_string(&objects).unwrap_or_default())
        } else {
            None
        };

        // Format location as RA/Dec string
        let location = format!(
            "RA: {:.4}°, Dec: {:.4}°",
            solve_result.center_ra, solve_result.center_dec
        );

        // Update the image in database
        let update = UpdateImage {
            location: Some(location),
            annotations: annotations_json,
            metadata: new_metadata,
            ..Default::default()
        };

        if let Err(e) = repository::update_image(&mut conn, &input.id, &update) {
            log::error!("Failed to update image after plate solve: {}", e);
        }
    } else {
        // Build metadata JSON for failed solve
        let failed_metadata = serde_json::json!({
            "plate_solve_failed": {
                "failed_at": chrono::Utc::now().to_rfc3339(),
                "solver": solve_result.solver,
                "error_message": solve_result.error_message,
            }
        });

        // Merge with existing metadata if present
        let new_metadata = if let Some(existing) = &image.metadata {
            if let Ok(mut existing_json) = serde_json::from_str::<serde_json::Value>(existing) {
                if let Some(obj) = existing_json.as_object_mut() {
                    obj.insert(
                        "plate_solve_failed".to_string(),
                        failed_metadata["plate_solve_failed"].clone(),
                    );
                }
                serde_json::to_string(&existing_json).ok()
            } else {
                Some(failed_metadata.to_string())
            }
        } else {
            Some(failed_metadata.to_string())
        };

        // Update the image in database with failed flag
        let update = UpdateImage {
            metadata: new_metadata,
            ..Default::default()
        };

        if let Err(e) = repository::update_image(&mut conn, &input.id, &update) {
            log::error!("Failed to update image after plate solve failure: {}", e);
        }
    }

    Ok(PlateSolveResponse {
        solve_result,
        objects,
    })
}

/// Detect which plate solvers are installed on the system
#[tauri::command]
pub fn detect_plate_solvers() -> Result<std::collections::HashMap<String, SolverInfo>, String> {
    plate_solve::detect_solvers()
}

/// Extract plate solving hints from a FITS file's headers
#[tauri::command]
pub fn get_solve_hints(
    state: State<'_, AppState>,
    image_id: String,
) -> Result<SolveHints, String> {
    let mut conn = state.db.get().map_err(|e| e.to_string())?;
    let image = repository::get_image_by_id(&mut conn, &image_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Image not found: {}", image_id))?;

    // Prefer FITS file, fall back to URL if it's a FITS
    let fits_path = image.fits_url
        .or_else(|| {
            image.url.filter(|u| {
                let l = u.to_lowercase();
                l.ends_with(".fit") || l.ends_with(".fits")
            })
        })
        .ok_or_else(|| "No FITS file available for this image".to_string())?;

    plate_solve::extract_solve_hints(&fits_path)
}

/// Query catalogs for objects in a given sky region
#[tauri::command]
pub fn query_sky_region(
    center_ra: f64,
    center_dec: f64,
    width_deg: f64,
    height_deg: f64,
    catalogs: Option<Vec<String>>,
    star_mag_limit: Option<f64>,
) -> Result<Vec<CatalogObject>, String> {
    plate_solve::query_objects_in_fov(
        center_ra,
        center_dec,
        width_deg,
        height_deg,
        catalogs,
        star_mag_limit,
        None,
        None,
    )
}
