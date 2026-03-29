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
    /// Raw WCS parameters (CRPIX, CRVAL, CD matrix) for accurate reconstruction
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wcs: Option<serde_json::Value>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pixel_x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pixel_y: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub radius_px: Option<f64>,
}

/// Plate solve an image using the specified solver
pub fn solve_image(
    image_path: &str,
    solver: &str,
    api_key: Option<&str>,
    api_url: Option<&str>,
    scale_lower: Option<f64>,
    scale_upper: Option<f64>,
    timeout: Option<i32>,
    hint_ra: Option<f64>,
    hint_dec: Option<f64>,
    hint_radius: Option<f64>,
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

        if let Some(url) = api_url {
            kwargs
                .set_item("api_url", url)
                .map_err(|e| format!("Failed to set api_url: {}", e))?;
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

        // Add hint coordinates for faster solving
        if let Some(ra) = hint_ra {
            kwargs
                .set_item("hint_ra", ra)
                .map_err(|e| format!("Failed to set hint_ra: {}", e))?;
        }

        if let Some(dec) = hint_dec {
            kwargs
                .set_item("hint_dec", dec)
                .map_err(|e| format!("Failed to set hint_dec: {}", e))?;
        }

        if let Some(radius) = hint_radius {
            kwargs
                .set_item("hint_radius", radius)
                .map_err(|e| format!("Failed to set hint_radius: {}", e))?;
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

        // Extract raw WCS params if present
        let wcs: Option<serde_json::Value> = dict
            .get_item("wcs")
            .ok()
            .flatten()
            .and_then(|v| {
                // Convert Python dict to serde_json::Value via JSON string
                let json_mod = py.import("json").ok()?;
                let json_str: String = json_mod
                    .call_method1("dumps", (v,))
                    .ok()?
                    .extract()
                    .ok()?;
                serde_json::from_str(&json_str).ok()
            });

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
            wcs,
        })
    })
}

/// Solver availability info
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SolverInfo {
    pub available: bool,
    pub version: Option<String>,
    pub details: String,
}

/// Hints extracted from FITS headers
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SolveHints {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scale_arcsec: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scale_lower: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scale_upper: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ra_hint: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dec_hint: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fov_deg: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub focal_length_mm: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pixel_size_um: Option<f64>,
    pub image_width: i32,
    pub image_height: i32,
}

/// Detect which plate solvers are installed
pub fn detect_solvers() -> Result<std::collections::HashMap<String, SolverInfo>, String> {
    Python::with_gil(|py| {
        let plate_solve = py
            .import("astra_astro.plate_solve")
            .map_err(|e| format!("Failed to import astra_astro.plate_solve: {}", e))?;

        let result = plate_solve
            .call_method0("detect_solvers")
            .map_err(|e| format!("detect_solvers failed: {}", e))?;

        let dict: &Bound<'_, PyDict> = result
            .downcast()
            .map_err(|e| format!("Expected dict: {}", e))?;

        let mut solvers = std::collections::HashMap::new();
        for (key, value) in dict.iter() {
            let name: String = key.extract().map_err(|e| format!("Invalid key: {}", e))?;
            let info_dict: &Bound<'_, PyDict> = value
                .downcast()
                .map_err(|e| format!("Expected dict for solver info: {}", e))?;

            let available: bool = info_dict
                .get_item("available").ok().flatten()
                .and_then(|v| v.extract().ok())
                .unwrap_or(false);
            let version: Option<String> = info_dict
                .get_item("version").ok().flatten()
                .and_then(|v| v.extract().ok());
            let details: String = info_dict
                .get_item("details").ok().flatten()
                .and_then(|v| v.extract().ok())
                .unwrap_or_default();

            solvers.insert(name, SolverInfo { available, version, details });
        }

        Ok(solvers)
    })
}

/// Extract plate solving hints from a FITS file
pub fn extract_solve_hints(image_path: &str) -> Result<SolveHints, String> {
    Python::with_gil(|py| {
        let plate_solve = py
            .import("astra_astro.plate_solve")
            .map_err(|e| format!("Failed to import astra_astro.plate_solve: {}", e))?;

        let result = plate_solve
            .call_method1("extract_solve_hints", (image_path,))
            .map_err(|e| format!("extract_solve_hints failed: {}", e))?;

        let dict: &Bound<'_, PyDict> = result
            .downcast()
            .map_err(|e| format!("Expected dict: {}", e))?;

        Ok(SolveHints {
            scale_arcsec: dict.get_item("scale_arcsec").ok().flatten().and_then(|v| v.extract().ok()),
            scale_lower: dict.get_item("scale_lower").ok().flatten().and_then(|v| v.extract().ok()),
            scale_upper: dict.get_item("scale_upper").ok().flatten().and_then(|v| v.extract().ok()),
            ra_hint: dict.get_item("ra_hint").ok().flatten().and_then(|v| v.extract().ok()),
            dec_hint: dict.get_item("dec_hint").ok().flatten().and_then(|v| v.extract().ok()),
            fov_deg: dict.get_item("fov_deg").ok().flatten().and_then(|v| v.extract().ok()),
            focal_length_mm: dict.get_item("focal_length_mm").ok().flatten().and_then(|v| v.extract().ok()),
            pixel_size_um: dict.get_item("pixel_size_um").ok().flatten().and_then(|v| v.extract().ok()),
            image_width: dict.get_item("image_width").ok().flatten().and_then(|v| v.extract().ok()).unwrap_or(0),
            image_height: dict.get_item("image_height").ok().flatten().and_then(|v| v.extract().ok()).unwrap_or(0),
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
    fits_path: Option<&str>,
    solve_result: Option<&PlateSolveResult>,
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
        let mut result = astra_astro
            .call_method("query_objects_in_fov", (), Some(&kwargs))
            .map_err(|e| format!("Catalog query failed: {}", e))?;

        // Add pixel positions using solve result WCS (or FITS header WCS as fallback)
        if let Some(fpath) = fits_path {
            let catalog_query = astra_astro
                .getattr("catalog_query")
                .map_err(|e| format!("Failed to get catalog_query: {}", e))?;

            // Build solve_result dict for Python if available
            let py_solve_result = if let Some(sr) = solve_result {
                let d = PyDict::new(py);
                d.set_item("centerRa", sr.center_ra).ok();
                d.set_item("centerDec", sr.center_dec).ok();
                d.set_item("pixelScale", sr.pixel_scale).ok();
                d.set_item("rotation", sr.rotation).ok();
                d.set_item("widthDeg", sr.width_deg).ok();
                d.set_item("heightDeg", sr.height_deg).ok();
                d.set_item("imageWidth", sr.image_width).ok();
                d.set_item("imageHeight", sr.image_height).ok();
                // Pass raw WCS params if available — convert JSON to Python dict
                if let Some(ref wcs) = sr.wcs {
                    let json_mod = py.import("json")
                        .map_err(|e| format!("Failed to import json: {}", e))?;
                    let wcs_str = serde_json::to_string(wcs).unwrap_or_default();
                    let py_wcs = json_mod
                        .call_method1("loads", (wcs_str,))
                        .map_err(|e| format!("Failed to convert WCS to Python: {}", e))?;
                    d.set_item("wcs", py_wcs).ok();
                }
                Some(d)
            } else {
                None
            };

            let args = (result, fpath, py_solve_result);
            result = catalog_query
                .call_method1("add_pixel_positions", args)
                .map_err(|e| format!("Failed to add pixel positions: {}", e))?;
        }

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

            let pixel_x: Option<f64> = dict.get_item("pixelX").ok().flatten().and_then(|v| v.extract().ok());
            let pixel_y: Option<f64> = dict.get_item("pixelY").ok().flatten().and_then(|v| v.extract().ok());
            let radius_px: Option<f64> = dict.get_item("radiusPx").ok().flatten().and_then(|v| v.extract().ok());

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
                pixel_x,
                pixel_y,
                radius_px,
            });
        }

        Ok(objects)
    })
}
