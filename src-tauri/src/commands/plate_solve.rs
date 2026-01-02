//! Plate solving commands for astronomical images

use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::State;

use crate::db::{models::UpdateImage, repository};
use crate::python::plate_solve::{self, CatalogObject, PlateSolveResult};
use crate::state::AppState;

/// Input for plate solving an image
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlateSolveInput {
    /// Image ID to plate solve
    pub id: String,
    /// Solver type: "nova", "local", or "astap"
    pub solver: String,
    /// API key for nova.astrometry.net (required for nova solver)
    pub api_key: Option<String>,
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

    // Plate solve the image
    let solve_result = plate_solve::solve_image(
        file_path,
        &input.solver,
        input.api_key.as_deref(),
        input.scale_lower,
        input.scale_upper,
        input.timeout,
    )?;

    let mut objects = Vec::new();

    // If solve was successful and catalog query is requested, query catalogs
    if solve_result.success && input.query_catalogs.unwrap_or(true) {
        objects = plate_solve::query_objects_in_fov(
            solve_result.center_ra,
            solve_result.center_dec,
            solve_result.width_deg,
            solve_result.height_deg,
            input.catalogs,
            input.star_mag_limit,
        )
        .unwrap_or_else(|e| {
            log::warn!("Failed to query catalogs: {}", e);
            Vec::new()
        });
    }

    // If solve was successful, update the image metadata and annotations
    if solve_result.success {
        // Build metadata JSON
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
            }
        });

        // Merge with existing metadata if present
        let new_metadata = if let Some(existing) = &image.metadata {
            if let Ok(mut existing_json) = serde_json::from_str::<serde_json::Value>(existing) {
                if let Some(obj) = existing_json.as_object_mut() {
                    obj.insert(
                        "plate_solve".to_string(),
                        plate_solve_metadata["plate_solve"].clone(),
                    );
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
            collection_id: None,
            filename: None,
            url: None,
            summary: None,
            description: None,
            content_type: None,
            favorite: None,
            tags: None,
            visibility: None,
            location: Some(location),
            annotations: annotations_json,
            metadata: new_metadata,
            thumbnail: None,
        };

        if let Err(e) = repository::update_image(&mut conn, &input.id, &update) {
            log::error!("Failed to update image after plate solve: {}", e);
        }
    }

    Ok(PlateSolveResponse {
        solve_result,
        objects,
    })
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
    )
}
