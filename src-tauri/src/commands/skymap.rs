//! Skymap generation commands

use serde::{Deserialize, Serialize};

use crate::python::skymap;

/// Input for generating a skymap
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkymapInput {
    /// Center Right Ascension in degrees
    pub center_ra: f64,
    /// Center Declination in degrees
    pub center_dec: f64,
    /// Field of view width in degrees for the map
    pub fov_width: Option<f64>,
    /// Field of view height in degrees for the map
    pub fov_height: Option<f64>,
    /// Image FOV width in degrees (for rectangle overlay)
    pub image_width: Option<f64>,
    /// Image FOV height in degrees (for rectangle overlay)
    pub image_height: Option<f64>,
}

/// Result from skymap generation
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkymapResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Generate a skymap showing the location of an image on the sky
#[tauri::command]
pub fn generate_skymap(input: SkymapInput) -> Result<SkymapResponse, String> {
    let result = skymap::generate_skymap(
        input.center_ra,
        input.center_dec,
        input.fov_width,
        input.fov_height,
        input.image_width,
        input.image_height,
    )?;

    Ok(SkymapResponse {
        success: result.success,
        image: result.image,
        error: result.error,
    })
}

/// Generate a wide-field skymap showing position on the entire sky
#[tauri::command]
pub fn generate_wide_skymap(center_ra: f64, center_dec: f64) -> Result<SkymapResponse, String> {
    let result = skymap::generate_wide_skymap(center_ra, center_dec)?;

    Ok(SkymapResponse {
        success: result.success,
        image: result.image,
        error: result.error,
    })
}
