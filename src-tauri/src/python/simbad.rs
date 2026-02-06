//! SIMBAD lookup bridge
//!
//! Provides access to the Python SIMBAD query functionality.

use pyo3::prelude::*;
use pyo3::types::PyDict;
use serde::{Deserialize, Serialize};

/// Result from a SIMBAD object lookup
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimbadObject {
    pub name: String,
    pub object_type: String,
    pub ra: String,
    pub dec: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ra_deg: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dec_deg: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub magnitude: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub common_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub distance: Option<DistanceInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spectral_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alternative_names: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub catalogs: Option<std::collections::HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DistanceInfo {
    pub parsecs: f64,
    pub light_years: f64,
}

/// Look up an astronomical object in SIMBAD
pub fn lookup_object(object_name: &str) -> Result<Option<SimbadObject>, String> {
    Python::with_gil(|py| {
        // Import our module
        let astra_astro = py.import("astra_astro")
            .map_err(|e| format!("Failed to import astra_astro: {}", e))?;

        // Call lookup_object function
        let result = astra_astro
            .call_method1("lookup_object", (object_name,))
            .map_err(|e| format!("SIMBAD lookup failed: {}", e))?;

        // Check if result is None
        if result.is_none() {
            return Ok(None);
        }

        // Convert Python dict to Rust struct
        let dict: &Bound<'_, PyDict> = result.downcast()
            .map_err(|e| format!("Expected dict result: {}", e))?;

        // Extract fields
        let name: String = dict.get_item("name")
            .map_err(|e| format!("Missing name: {}", e))?
            .ok_or("Missing name field")?
            .extract()
            .map_err(|e| format!("Invalid name: {}", e))?;

        let object_type: String = dict.get_item("objectType")
            .map_err(|e| format!("Missing objectType: {}", e))?
            .ok_or("Missing objectType field")?
            .extract()
            .map_err(|e| format!("Invalid objectType: {}", e))?;

        let ra: String = dict.get_item("ra")
            .map_err(|e| format!("Missing ra: {}", e))?
            .ok_or("Missing ra field")?
            .extract()
            .map_err(|e| format!("Invalid ra: {}", e))?;

        let dec: String = dict.get_item("dec")
            .map_err(|e| format!("Missing dec: {}", e))?
            .ok_or("Missing dec field")?
            .extract()
            .map_err(|e| format!("Invalid dec: {}", e))?;

        let ra_deg: Option<f64> = dict.get_item("raDeg")
            .ok()
            .flatten()
            .and_then(|v| v.extract().ok());

        let dec_deg: Option<f64> = dict.get_item("decDeg")
            .ok()
            .flatten()
            .and_then(|v| v.extract().ok());

        let magnitude: Option<String> = dict.get_item("magnitude")
            .ok()
            .flatten()
            .and_then(|v| v.extract().ok());

        let size: Option<String> = dict.get_item("size")
            .ok()
            .flatten()
            .and_then(|v| v.extract().ok());

        let common_name: Option<String> = dict.get_item("commonName")
            .ok()
            .flatten()
            .and_then(|v| v.extract().ok());

        let spectral_type: Option<String> = dict.get_item("spectralType")
            .ok()
            .flatten()
            .and_then(|v| v.extract().ok());

        let alternative_names: Option<Vec<String>> = dict.get_item("alternativeNames")
            .ok()
            .flatten()
            .and_then(|v| v.extract().ok());

        let catalogs: Option<std::collections::HashMap<String, String>> = dict.get_item("catalogs")
            .ok()
            .flatten()
            .and_then(|v| v.extract().ok());

        // Extract distance if present
        let distance: Option<DistanceInfo> = dict.get_item("distance")
            .ok()
            .flatten()
            .and_then(|d| {
                let d_dict: &Bound<'_, PyDict> = d.downcast().ok()?;
                let parsecs: f64 = d_dict.get_item("parsecs").ok()??.extract().ok()?;
                let light_years: f64 = d_dict.get_item("lightYears").ok()??.extract().ok()?;
                Some(DistanceInfo { parsecs, light_years })
            });

        Ok(Some(SimbadObject {
            name,
            object_type,
            ra,
            dec,
            ra_deg,
            dec_deg,
            magnitude,
            size,
            common_name,
            distance,
            spectral_type,
            alternative_names,
            catalogs,
        }))
    })
}
