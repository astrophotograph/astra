//! Plate solving bridge
//!
//! Provides access to the Python plate solving and catalog query functionality.

use pyo3::prelude::*;
use pyo3::types::{PyDict, PyList};
use serde::{Deserialize, Serialize};

/// Result from plate solving an image
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlateSolveResult {
    pub success: bool,
    pub center_ra: f64,
    pub center_dec: f64,
    pub pixel_scale: f64,
    pub rotation: f64,
    pub width_deg: f64,
    pub height_deg: f64,
    pub image_width: i32,
    pub image_height: i32,
    pub solver: String,
    pub solve_time: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

/// An astronomical object found in the field of view
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogObject {
    pub name: String,
    pub catalog: String,
    pub object_type: String,
    pub ra: f64,
    pub dec: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub magnitude: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_arcmin: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub common_name: Option<String>,
}

/// Plate solve an image using the specified solver
pub fn solve_image(
    image_path: &str,
    solver: &str,
    api_key: Option<&str>,
    scale_lower: Option<f64>,
    scale_upper: Option<f64>,
    timeout: Option<i32>,
) -> Result<PlateSolveResult, String> {
    Python::with_gil(|py| {
        // Import our module
        let astra_astro = py
            .import("astra_astro")
            .map_err(|e| format!("Failed to import astra_astro: {}", e))?;

        // Build arguments
        let kwargs = PyDict::new(py);
        kwargs
            .set_item("image_path", image_path)
            .map_err(|e| format!("Failed to set image_path: {}", e))?;
        kwargs
            .set_item("solver", solver)
            .map_err(|e| format!("Failed to set solver: {}", e))?;

        if let Some(key) = api_key {
            kwargs
                .set_item("api_key", key)
                .map_err(|e| format!("Failed to set api_key: {}", e))?;
        }

        if let Some(lower) = scale_lower {
            kwargs
                .set_item("scale_lower", lower)
                .map_err(|e| format!("Failed to set scale_lower: {}", e))?;
        }

        if let Some(upper) = scale_upper {
            kwargs
                .set_item("scale_upper", upper)
                .map_err(|e| format!("Failed to set scale_upper: {}", e))?;
        }

        if let Some(t) = timeout {
            kwargs
                .set_item("timeout", t)
                .map_err(|e| format!("Failed to set timeout: {}", e))?;
        }

        // Call solve_image function
        let result = astra_astro
            .call_method("solve_image", (), Some(&kwargs))
            .map_err(|e| format!("Plate solve failed: {}", e))?;

        // Convert Python dict to Rust struct
        let dict: &Bound<'_, PyDict> = result
            .downcast()
            .map_err(|e| format!("Expected dict result: {}", e))?;

        // Extract required fields
        let success: bool = dict
            .get_item("success")
            .map_err(|e| format!("Missing success: {}", e))?
            .ok_or("Missing success field")?
            .extract()
            .map_err(|e| format!("Invalid success: {}", e))?;

        let center_ra: f64 = dict
            .get_item("centerRa")
            .ok()
            .flatten()
            .and_then(|v| v.extract().ok())
            .unwrap_or(0.0);

        let center_dec: f64 = dict
            .get_item("centerDec")
            .ok()
            .flatten()
            .and_then(|v| v.extract().ok())
            .unwrap_or(0.0);

        let pixel_scale: f64 = dict
            .get_item("pixelScale")
            .ok()
            .flatten()
            .and_then(|v| v.extract().ok())
            .unwrap_or(0.0);

        let rotation: f64 = dict
            .get_item("rotation")
            .ok()
            .flatten()
            .and_then(|v| v.extract().ok())
            .unwrap_or(0.0);

        let width_deg: f64 = dict
            .get_item("widthDeg")
            .ok()
            .flatten()
            .and_then(|v| v.extract().ok())
            .unwrap_or(0.0);

        let height_deg: f64 = dict
            .get_item("heightDeg")
            .ok()
            .flatten()
            .and_then(|v| v.extract().ok())
            .unwrap_or(0.0);

        let image_width: i32 = dict
            .get_item("imageWidth")
            .ok()
            .flatten()
            .and_then(|v| v.extract().ok())
            .unwrap_or(0);

        let image_height: i32 = dict
            .get_item("imageHeight")
            .ok()
            .flatten()
            .and_then(|v| v.extract().ok())
            .unwrap_or(0);

        let solver_name: String = dict
            .get_item("solver")
            .ok()
            .flatten()
            .and_then(|v| v.extract().ok())
            .unwrap_or_default();

        let solve_time: f64 = dict
            .get_item("solveTime")
            .ok()
            .flatten()
            .and_then(|v| v.extract().ok())
            .unwrap_or(0.0);

        let error_message: Option<String> = dict
            .get_item("errorMessage")
            .ok()
            .flatten()
            .and_then(|v| v.extract().ok());

        Ok(PlateSolveResult {
            success,
            center_ra,
            center_dec,
            pixel_scale,
            rotation,
            width_deg,
            height_deg,
            image_width,
            image_height,
            solver: solver_name,
            solve_time,
            error_message,
        })
    })
}

/// Query catalogs for objects in a field of view
pub fn query_objects_in_fov(
    center_ra: f64,
    center_dec: f64,
    width_deg: f64,
    height_deg: f64,
    catalogs: Option<Vec<String>>,
    star_mag_limit: Option<f64>,
) -> Result<Vec<CatalogObject>, String> {
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
        kwargs
            .set_item("width_deg", width_deg)
            .map_err(|e| format!("Failed to set width_deg: {}", e))?;
        kwargs
            .set_item("height_deg", height_deg)
            .map_err(|e| format!("Failed to set height_deg: {}", e))?;

        if let Some(cats) = catalogs {
            let py_list = PyList::new(py, &cats)
                .map_err(|e| format!("Failed to create catalog list: {}", e))?;
            kwargs
                .set_item("catalogs", py_list)
                .map_err(|e| format!("Failed to set catalogs: {}", e))?;
        }

        if let Some(mag) = star_mag_limit {
            kwargs
                .set_item("star_mag_limit", mag)
                .map_err(|e| format!("Failed to set star_mag_limit: {}", e))?;
        }

        // Call query_objects_in_fov function
        let result = astra_astro
            .call_method("query_objects_in_fov", (), Some(&kwargs))
            .map_err(|e| format!("Catalog query failed: {}", e))?;

        // Convert Python list of dicts to Rust Vec
        let list: &Bound<'_, PyList> = result
            .downcast()
            .map_err(|e| format!("Expected list result: {}", e))?;

        let mut objects = Vec::new();
        for item in list.iter() {
            let dict: &Bound<'_, PyDict> = item
                .downcast()
                .map_err(|e| format!("Expected dict in list: {}", e))?;

            let name: String = dict
                .get_item("name")
                .map_err(|e| format!("Missing name: {}", e))?
                .ok_or("Missing name field")?
                .extract()
                .map_err(|e| format!("Invalid name: {}", e))?;

            let catalog: String = dict
                .get_item("catalog")
                .map_err(|e| format!("Missing catalog: {}", e))?
                .ok_or("Missing catalog field")?
                .extract()
                .map_err(|e| format!("Invalid catalog: {}", e))?;

            let object_type: String = dict
                .get_item("objectType")
                .map_err(|e| format!("Missing objectType: {}", e))?
                .ok_or("Missing objectType field")?
                .extract()
                .map_err(|e| format!("Invalid objectType: {}", e))?;

            let ra: f64 = dict
                .get_item("ra")
                .map_err(|e| format!("Missing ra: {}", e))?
                .ok_or("Missing ra field")?
                .extract()
                .map_err(|e| format!("Invalid ra: {}", e))?;

            let dec: f64 = dict
                .get_item("dec")
                .map_err(|e| format!("Missing dec: {}", e))?
                .ok_or("Missing dec field")?
                .extract()
                .map_err(|e| format!("Invalid dec: {}", e))?;

            let magnitude: Option<f64> = dict
                .get_item("magnitude")
                .ok()
                .flatten()
                .and_then(|v| v.extract().ok());

            let size: Option<String> = dict
                .get_item("size")
                .ok()
                .flatten()
                .and_then(|v| v.extract().ok());

            let size_arcmin: Option<f64> = dict
                .get_item("sizeArcmin")
                .ok()
                .flatten()
                .and_then(|v| v.extract().ok());

            let common_name: Option<String> = dict
                .get_item("commonName")
                .ok()
                .flatten()
                .and_then(|v| v.extract().ok());

            objects.push(CatalogObject {
                name,
                catalog,
                object_type,
                ra,
                dec,
                magnitude,
                size,
                size_arcmin,
                common_name,
            });
        }

        Ok(objects)
    })
}
