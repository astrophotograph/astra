//! Image processing bridge to Python
//!
//! Provides access to the Python image processing functionality.

use pyo3::prelude::*;
use pyo3::types::PyDict;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Parameters for image processing
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessingParams {
    /// Target type: "auto" or specific type (emission_nebula, galaxy, etc.)
    pub target_type: String,
    /// Stretch method: "statistical", "arcsinh", "log"
    pub stretch_method: String,
    /// Target median for stretch (0.05-0.30)
    pub stretch_factor: f64,
    /// Whether to remove background gradient
    pub background_removal: bool,
    /// Whether to reduce star brightness
    pub star_reduction: bool,
    /// Whether to apply color calibration
    pub color_calibration: bool,
    /// Noise reduction strength (0-1)
    pub noise_reduction: f64,
}

impl Default for ProcessingParams {
    fn default() -> Self {
        Self {
            target_type: "auto".to_string(),
            stretch_method: "statistical".to_string(),
            stretch_factor: 0.15,
            background_removal: true,
            star_reduction: false,
            color_calibration: true,
            noise_reduction: 0.0,
        }
    }
}

/// Result from image processing
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessingResult {
    pub success: bool,
    pub output_fits_path: String,
    pub output_preview_path: String,
    pub target_type: String,
    pub processing_params: serde_json::Value,
    pub processing_time: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

/// Target classification information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetInfo {
    pub target_type: String,
    pub object_name: String,
    pub confidence: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub simbad_type: Option<String>,
}

/// Process a FITS image with stretch and enhancements
pub fn process_image(
    input_fits_path: &str,
    output_dir: &str,
    params: &ProcessingParams,
    object_name: Option<&str>,
) -> Result<ProcessingResult, String> {
    Python::with_gil(|py| {
        // Import our module
        let astra_astro = py
            .import("astra_astro")
            .map_err(|e| format!("Failed to import astra_astro: {}", e))?;

        // Build params dictionary
        let params_dict = PyDict::new(py);
        params_dict
            .set_item("targetType", &params.target_type)
            .map_err(|e| format!("Failed to set targetType: {}", e))?;
        params_dict
            .set_item("stretchMethod", &params.stretch_method)
            .map_err(|e| format!("Failed to set stretchMethod: {}", e))?;
        params_dict
            .set_item("stretchFactor", params.stretch_factor)
            .map_err(|e| format!("Failed to set stretchFactor: {}", e))?;
        params_dict
            .set_item("backgroundRemoval", params.background_removal)
            .map_err(|e| format!("Failed to set backgroundRemoval: {}", e))?;
        params_dict
            .set_item("starReduction", params.star_reduction)
            .map_err(|e| format!("Failed to set starReduction: {}", e))?;
        params_dict
            .set_item("colorCalibration", params.color_calibration)
            .map_err(|e| format!("Failed to set colorCalibration: {}", e))?;
        params_dict
            .set_item("noiseReduction", params.noise_reduction)
            .map_err(|e| format!("Failed to set noiseReduction: {}", e))?;

        // Call process_image_from_dict function
        let result = astra_astro
            .call_method1(
                "process_image_from_dict",
                (input_fits_path, output_dir, params_dict, object_name),
            )
            .map_err(|e| format!("Image processing failed: {}", e))?;

        // Convert Python dict to Rust struct
        let dict: &Bound<'_, PyDict> = result
            .downcast()
            .map_err(|e| format!("Expected dict result: {}", e))?;

        // Extract fields
        let success: bool = dict
            .get_item("success")
            .map_err(|e| format!("Missing success: {}", e))?
            .ok_or("Missing success field")?
            .extract()
            .map_err(|e| format!("Invalid success: {}", e))?;

        let output_fits_path: String = dict
            .get_item("outputFitsPath")
            .ok()
            .flatten()
            .and_then(|v| v.extract().ok())
            .unwrap_or_default();

        let output_preview_path: String = dict
            .get_item("outputPreviewPath")
            .ok()
            .flatten()
            .and_then(|v| v.extract().ok())
            .unwrap_or_default();

        let target_type: String = dict
            .get_item("targetType")
            .ok()
            .flatten()
            .and_then(|v| v.extract().ok())
            .unwrap_or_default();

        let processing_time: f64 = dict
            .get_item("processingTime")
            .ok()
            .flatten()
            .and_then(|v| v.extract().ok())
            .unwrap_or(0.0);

        let error_message: Option<String> = dict
            .get_item("errorMessage")
            .ok()
            .flatten()
            .and_then(|v| v.extract().ok());

        // Extract processing params
        let processing_params: serde_json::Value = dict
            .get_item("processingParams")
            .ok()
            .flatten()
            .and_then(|v| {
                // Convert Python dict to HashMap, then to serde_json::Value
                let params_map: HashMap<String, serde_json::Value> = v
                    .extract::<HashMap<String, PyObject>>()
                    .ok()?
                    .into_iter()
                    .filter_map(|(k, v)| {
                        Python::with_gil(|py| {
                            let py_obj = v.bind(py);
                            if let Ok(s) = py_obj.extract::<String>() {
                                Some((k, serde_json::Value::String(s)))
                            } else if let Ok(b) = py_obj.extract::<bool>() {
                                Some((k, serde_json::Value::Bool(b)))
                            } else if let Ok(f) = py_obj.extract::<f64>() {
                                Some((
                                    k,
                                    serde_json::Number::from_f64(f)
                                        .map(serde_json::Value::Number)
                                        .unwrap_or(serde_json::Value::Null),
                                ))
                            } else {
                                None
                            }
                        })
                    })
                    .collect();
                Some(serde_json::Value::Object(
                    params_map.into_iter().collect(),
                ))
            })
            .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));

        Ok(ProcessingResult {
            success,
            output_fits_path,
            output_preview_path,
            target_type,
            processing_params,
            processing_time,
            error_message,
        })
    })
}

/// Classify a target from its object name
pub fn classify_target(object_name: &str) -> Result<TargetInfo, String> {
    Python::with_gil(|py| {
        // Import our module
        let astra_astro = py
            .import("astra_astro")
            .map_err(|e| format!("Failed to import astra_astro: {}", e))?;

        // Call classify_target function
        let result = astra_astro
            .call_method1("classify_target", (object_name,))
            .map_err(|e| format!("Target classification failed: {}", e))?;

        // Convert Python dict to Rust struct
        let dict: &Bound<'_, PyDict> = result
            .downcast()
            .map_err(|e| format!("Expected dict result: {}", e))?;

        // Extract fields
        let target_type: String = dict
            .get_item("targetType")
            .map_err(|e| format!("Missing targetType: {}", e))?
            .ok_or("Missing targetType field")?
            .extract()
            .map_err(|e| format!("Invalid targetType: {}", e))?;

        let object_name: String = dict
            .get_item("objectName")
            .map_err(|e| format!("Missing objectName: {}", e))?
            .ok_or("Missing objectName field")?
            .extract()
            .map_err(|e| format!("Invalid objectName: {}", e))?;

        let confidence: f64 = dict
            .get_item("confidence")
            .map_err(|e| format!("Missing confidence: {}", e))?
            .ok_or("Missing confidence field")?
            .extract()
            .map_err(|e| format!("Invalid confidence: {}", e))?;

        let simbad_type: Option<String> = dict
            .get_item("simbadType")
            .ok()
            .flatten()
            .and_then(|v| v.extract().ok());

        Ok(TargetInfo {
            target_type,
            object_name,
            confidence,
            simbad_type,
        })
    })
}
