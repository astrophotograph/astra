//! Astronomy commands for celestial object lookups and calculations

use serde::{Deserialize, Serialize};

use crate::python::{altitude, simbad};

/// Observer location input
#[derive(Debug, Serialize, Deserialize)]
pub struct LocationInput {
    pub latitude: f64,
    pub longitude: f64,
    #[serde(default)]
    pub elevation: f64,
    pub name: Option<String>,
}

impl From<LocationInput> for altitude::ObserverLocation {
    fn from(input: LocationInput) -> Self {
        altitude::ObserverLocation {
            latitude: input.latitude,
            longitude: input.longitude,
            elevation: input.elevation,
            name: input.name,
        }
    }
}

/// Look up an astronomical object in SIMBAD
#[tauri::command]
pub fn lookup_astronomy_object(
    name: String,
) -> Result<Option<simbad::SimbadObject>, String> {
    simbad::lookup_object(&name)
}

/// Calculate current altitude and azimuth for an object
#[tauri::command]
pub fn calculate_object_altitude(
    ra_deg: f64,
    dec_deg: f64,
    location: LocationInput,
) -> Result<altitude::AltitudePoint, String> {
    altitude::calculate_altitude(ra_deg, dec_deg, &location.into())
}

/// Calculate altitude data over a time range for plotting
#[tauri::command]
pub fn calculate_altitude_data(
    ra_deg: f64,
    dec_deg: f64,
    location: LocationInput,
    duration_hours: Option<f64>,
    interval_minutes: Option<i32>,
) -> Result<Vec<altitude::AltitudePoint>, String> {
    altitude::calculate_altitude_data(
        ra_deg,
        dec_deg,
        &location.into(),
        duration_hours,
        interval_minutes,
    )
}

/// Get sunrise, sunset, and twilight times for a location
#[tauri::command]
pub fn get_sun_times(
    location: LocationInput,
) -> Result<altitude::SunTimes, String> {
    altitude::get_sun_times(&location.into())
}
