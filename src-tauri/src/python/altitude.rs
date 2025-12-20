//! Altitude calculation bridge
//!
//! Provides access to the Python altitude calculation functionality.

use pyo3::prelude::*;
use pyo3::types::{PyDict, PyList};
use serde::{Deserialize, Serialize};

/// Observer location for altitude calculations
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObserverLocation {
    pub latitude: f64,
    pub longitude: f64,
    #[serde(default)]
    pub elevation: f64,
    pub name: Option<String>,
}

/// A single altitude/azimuth data point
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AltitudePoint {
    pub time: String,
    pub altitude: f64,
    pub azimuth: f64,
    pub compass_direction: String,
}

/// Sunrise/sunset and twilight times
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SunTimes {
    pub sunrise: Option<String>,
    pub sunset: Option<String>,
    pub civil_twilight_start: Option<String>,
    pub civil_twilight_end: Option<String>,
    pub nautical_twilight_start: Option<String>,
    pub nautical_twilight_end: Option<String>,
    pub astronomical_twilight_start: Option<String>,
    pub astronomical_twilight_end: Option<String>,
}

/// Calculate current altitude and azimuth for an object
pub fn calculate_altitude(
    ra_deg: f64,
    dec_deg: f64,
    location: &ObserverLocation,
) -> Result<AltitudePoint, String> {
    Python::with_gil(|py| {
        let astra_astro = py.import("astra_astro")
            .map_err(|e| format!("Failed to import astra_astro: {}", e))?;

        // Create ObserverLocation in Python
        let altitude_module = py.import("astra_astro.altitude")
            .map_err(|e| format!("Failed to import altitude module: {}", e))?;

        let py_location = altitude_module
            .getattr("ObserverLocation")
            .map_err(|e| format!("Failed to get ObserverLocation: {}", e))?
            .call1((
                location.latitude,
                location.longitude,
                location.elevation,
                location.name.clone(),
            ))
            .map_err(|e| format!("Failed to create ObserverLocation: {}", e))?;

        // Call calculate_altitude
        let result = astra_astro
            .call_method1("calculate_altitude", (ra_deg, dec_deg, py_location))
            .map_err(|e| format!("Altitude calculation failed: {}", e))?;

        // Extract result
        let dict: &Bound<'_, PyDict> = result.downcast()
            .map_err(|e| format!("Expected dict result: {}", e))?;

        Ok(AltitudePoint {
            time: dict.get_item("time")
                .map_err(|e| format!("Missing time: {}", e))?
                .ok_or("Missing time field")?
                .extract()
                .map_err(|e| format!("Invalid time: {}", e))?,
            altitude: dict.get_item("altitude")
                .map_err(|e| format!("Missing altitude: {}", e))?
                .ok_or("Missing altitude field")?
                .extract()
                .map_err(|e| format!("Invalid altitude: {}", e))?,
            azimuth: dict.get_item("azimuth")
                .map_err(|e| format!("Missing azimuth: {}", e))?
                .ok_or("Missing azimuth field")?
                .extract()
                .map_err(|e| format!("Invalid azimuth: {}", e))?,
            compass_direction: dict.get_item("compassDirection")
                .map_err(|e| format!("Missing compassDirection: {}", e))?
                .ok_or("Missing compassDirection field")?
                .extract()
                .map_err(|e| format!("Invalid compassDirection: {}", e))?,
        })
    })
}

/// Calculate altitude data over a time range for plotting
pub fn calculate_altitude_data(
    ra_deg: f64,
    dec_deg: f64,
    location: &ObserverLocation,
    duration_hours: Option<f64>,
    interval_minutes: Option<i32>,
) -> Result<Vec<AltitudePoint>, String> {
    Python::with_gil(|py| {
        let altitude_module = py.import("astra_astro.altitude")
            .map_err(|e| format!("Failed to import altitude module: {}", e))?;

        // Create ObserverLocation in Python
        let py_location = altitude_module
            .getattr("ObserverLocation")
            .map_err(|e| format!("Failed to get ObserverLocation: {}", e))?
            .call1((
                location.latitude,
                location.longitude,
                location.elevation,
                location.name.clone(),
            ))
            .map_err(|e| format!("Failed to create ObserverLocation: {}", e))?;

        // Build kwargs
        let kwargs = PyDict::new(py);
        kwargs.set_item("location", py_location)
            .map_err(|e| format!("Failed to set location: {}", e))?;
        if let Some(duration) = duration_hours {
            kwargs.set_item("duration_hours", duration)
                .map_err(|e| format!("Failed to set duration_hours: {}", e))?;
        }
        if let Some(interval) = interval_minutes {
            kwargs.set_item("interval_minutes", interval)
                .map_err(|e| format!("Failed to set interval_minutes: {}", e))?;
        }

        // Call calculate_altitude_data
        let result = altitude_module
            .getattr("calculate_altitude_data")
            .map_err(|e| format!("Failed to get calculate_altitude_data: {}", e))?
            .call((ra_deg, dec_deg), Some(&kwargs))
            .map_err(|e| format!("Altitude data calculation failed: {}", e))?;

        // Extract result list
        let list: &Bound<'_, PyList> = result.downcast()
            .map_err(|e| format!("Expected list result: {}", e))?;

        let mut points = Vec::new();
        for item in list.iter() {
            let dict: &Bound<'_, PyDict> = item.downcast()
                .map_err(|e| format!("Expected dict item: {}", e))?;

            points.push(AltitudePoint {
                time: dict.get_item("time")
                    .map_err(|e| format!("Missing time: {}", e))?
                    .ok_or("Missing time field")?
                    .extract()
                    .map_err(|e| format!("Invalid time: {}", e))?,
                altitude: dict.get_item("altitude")
                    .map_err(|e| format!("Missing altitude: {}", e))?
                    .ok_or("Missing altitude field")?
                    .extract()
                    .map_err(|e| format!("Invalid altitude: {}", e))?,
                azimuth: dict.get_item("azimuth")
                    .map_err(|e| format!("Missing azimuth: {}", e))?
                    .ok_or("Missing azimuth field")?
                    .extract()
                    .map_err(|e| format!("Invalid azimuth: {}", e))?,
                compass_direction: dict.get_item("compassDirection")
                    .map_err(|e| format!("Missing compassDirection: {}", e))?
                    .ok_or("Missing compassDirection field")?
                    .extract()
                    .map_err(|e| format!("Invalid compassDirection: {}", e))?,
            });
        }

        Ok(points)
    })
}

/// Get sunrise, sunset, and twilight times for a location
pub fn get_sun_times(location: &ObserverLocation) -> Result<SunTimes, String> {
    Python::with_gil(|py| {
        let altitude_module = py.import("astra_astro.altitude")
            .map_err(|e| format!("Failed to import altitude module: {}", e))?;

        // Create ObserverLocation in Python
        let py_location = altitude_module
            .getattr("ObserverLocation")
            .map_err(|e| format!("Failed to get ObserverLocation: {}", e))?
            .call1((
                location.latitude,
                location.longitude,
                location.elevation,
                location.name.clone(),
            ))
            .map_err(|e| format!("Failed to create ObserverLocation: {}", e))?;

        // Call get_sunset_sunrise
        let result = altitude_module
            .call_method1("get_sunset_sunrise", (py_location,))
            .map_err(|e| format!("Sun times calculation failed: {}", e))?;

        // Extract result
        let dict: &Bound<'_, PyDict> = result.downcast()
            .map_err(|e| format!("Expected dict result: {}", e))?;

        Ok(SunTimes {
            sunrise: dict.get_item("sunrise").ok().flatten().and_then(|v| v.extract().ok()),
            sunset: dict.get_item("sunset").ok().flatten().and_then(|v| v.extract().ok()),
            civil_twilight_start: dict.get_item("civilTwilightStart").ok().flatten().and_then(|v| v.extract().ok()),
            civil_twilight_end: dict.get_item("civilTwilightEnd").ok().flatten().and_then(|v| v.extract().ok()),
            nautical_twilight_start: dict.get_item("nauticalTwilightStart").ok().flatten().and_then(|v| v.extract().ok()),
            nautical_twilight_end: dict.get_item("nauticalTwilightEnd").ok().flatten().and_then(|v| v.extract().ok()),
            astronomical_twilight_start: dict.get_item("astronomicalTwilightStart").ok().flatten().and_then(|v| v.extract().ok()),
            astronomical_twilight_end: dict.get_item("astronomicalTwilightEnd").ok().flatten().and_then(|v| v.extract().ok()),
        })
    })
}
