//! Skymap generation bridge
//!
//! Provides access to the Python starplot-based skymap generation.

use pyo3::prelude::*;
use pyo3::types::PyDict;
use serde::{Deserialize, Serialize};

/// Result from skymap generation
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkymapResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Generate a skymap showing the location of an image on the sky
pub fn generate_skymap(
    center_ra: f64,
    center_dec: f64,
    fov_width: Option<f64>,
    fov_height: Option<f64>,
    image_width: Option<f64>,
    image_height: Option<f64>,
) -> Result<SkymapResult, String> {
    Python::with_gil(|py| {
        // Import our module
        let astra_astro = py
            .import("astra_astro")
            .map_err(|e| format!("Failed to import astra_astro: {}", e))?;

        // Build arguments
        let kwargs = PyDict::new(py);
        kwargs
            .set_item("center_ra", center_ra)
            .map_err(|e| format!("Failed to set center_ra: {}", e))?;
        kwargs
            .set_item("center_dec", center_dec)
            .map_err(|e| format!("Failed to set center_dec: {}", e))?;

        if let Some(w) = fov_width {
            kwargs
                .set_item("fov_width", w)
                .map_err(|e| format!("Failed to set fov_width: {}", e))?;
        }

        if let Some(h) = fov_height {
            kwargs
                .set_item("fov_height", h)
                .map_err(|e| format!("Failed to set fov_height: {}", e))?;
        }

        if let Some(w) = image_width {
            kwargs
                .set_item("image_width", w)
                .map_err(|e| format!("Failed to set image_width: {}", e))?;
        }

        if let Some(h) = image_height {
            kwargs
                .set_item("image_height", h)
                .map_err(|e| format!("Failed to set image_height: {}", e))?;
        }

        // Call generate_skymap function
        let result = astra_astro
            .call_method("generate_skymap", (), Some(&kwargs))
            .map_err(|e| format!("Skymap generation failed: {}", e))?;

        // Convert Python dict to Rust struct
        let dict: &Bound<'_, PyDict> = result
            .downcast()
            .map_err(|e| format!("Expected dict result: {}", e))?;

        let success: bool = dict
            .get_item("success")
            .map_err(|e| format!("Missing success: {}", e))?
            .ok_or("Missing success field")?
            .extract()
            .map_err(|e| format!("Invalid success: {}", e))?;

        let image: Option<String> = dict
            .get_item("image")
            .ok()
            .flatten()
            .and_then(|v| v.extract().ok());

        let error: Option<String> = dict
            .get_item("error")
            .ok()
            .flatten()
            .and_then(|v| v.extract().ok());

        Ok(SkymapResult {
            success,
            image,
            error,
        })
    })
}

/// Generate a wide-field skymap showing position on the full sky
pub fn generate_wide_skymap(center_ra: f64, center_dec: f64) -> Result<SkymapResult, String> {
    Python::with_gil(|py| {
        // Import our module
        let astra_astro = py
            .import("astra_astro")
            .map_err(|e| format!("Failed to import astra_astro: {}", e))?;

        // Build arguments
        let kwargs = PyDict::new(py);
        kwargs
            .set_item("center_ra", center_ra)
            .map_err(|e| format!("Failed to set center_ra: {}", e))?;
        kwargs
            .set_item("center_dec", center_dec)
            .map_err(|e| format!("Failed to set center_dec: {}", e))?;

        // Call generate_wide_skymap function
        let result = astra_astro
            .call_method("generate_wide_skymap", (), Some(&kwargs))
            .map_err(|e| format!("Wide skymap generation failed: {}", e))?;

        // Convert Python dict to Rust struct
        let dict: &Bound<'_, PyDict> = result
            .downcast()
            .map_err(|e| format!("Expected dict result: {}", e))?;

        let success: bool = dict
            .get_item("success")
            .map_err(|e| format!("Missing success: {}", e))?
            .ok_or("Missing success field")?
            .extract()
            .map_err(|e| format!("Invalid success: {}", e))?;

        let image: Option<String> = dict
            .get_item("image")
            .ok()
            .flatten()
            .and_then(|v| v.extract().ok());

        let error: Option<String> = dict
            .get_item("error")
            .ok()
            .flatten()
            .and_then(|v| v.extract().ok());

        Ok(SkymapResult {
            success,
            image,
            error,
        })
    })
}
