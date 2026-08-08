//! Native image stretching for astrophotography — thin adapter over the
//! `processinator` crate.
//!
//! The pipeline that used to live in this module (FITS reading, autocrop,
//! per-channel normalization, gradient removal, MTF stretch, JPEG output)
//! was extracted into the standalone processinator library and is
//! maintained there. This module keeps astra's original call-site API:
//! [`StretchParams`] and [`generate_preview`] for FITS → JPEG previews.

pub mod display;

use std::path::Path;

use processinator::{fits_to_image, PipelineConfig, StretchAlgorithm};

/// Parameters for the stretch pipeline.
pub struct StretchParams {
    pub bg_percent: f64,
    pub sigma: f64,
    pub gradient_removal: bool,
    pub autocrop: bool,
    /// SCNR green-removal amount: 0 disables, 1 full suppression.
    pub green_removal: f64,
    /// Chroma scale around per-pixel luminance; 1.0 is a no-op.
    pub saturation: f64,
}

impl Default for StretchParams {
    fn default() -> Self {
        // The cosmetic constants come from the library defaults so there is
        // one source of truth — the payload header ships these same values
        // as the live editor's initial slider positions.
        let lib = PipelineConfig::default();
        Self {
            bg_percent: 0.15,
            sigma: 3.0,
            gradient_removal: true,
            autocrop: true,
            green_removal: lib.green_removal,
            saturation: lib.saturation,
        }
    }
}

impl StretchParams {
    /// Map to the library's pipeline configuration (linked MTF stretch,
    /// matching the pre-extraction behavior).
    pub fn to_pipeline_config(&self) -> PipelineConfig {
        PipelineConfig {
            autocrop: self.autocrop,
            gradient_removal: self.gradient_removal,
            stretch: StretchAlgorithm::Mtf {
                bg_percent: self.bg_percent,
                sigma: self.sigma,
                linked: true,
            },
            green_removal: self.green_removal,
            saturation: self.saturation,
            ..Default::default()
        }
    }
}

/// Generate a JPEG preview from a FITS file using the processinator
/// pipeline.
///
/// Returns the output path on success.
pub fn generate_preview(
    fits_path: &Path,
    output_path: &Path,
    params: &StretchParams,
) -> Result<String, String> {
    let start = std::time::Instant::now();
    log::info!(
        "stretch: params bg_percent={}, sigma={}, gradient={}, autocrop={}",
        params.bg_percent,
        params.sigma,
        params.gradient_removal,
        params.autocrop
    );

    fits_to_image(fits_path, Some(output_path), &params.to_pipeline_config())
        .map_err(|e| e.to_string())?;

    let file_size = std::fs::metadata(output_path).map(|m| m.len()).unwrap_or(0);
    log::info!(
        "stretch: total pipeline in {:?} ({} bytes)",
        start.elapsed(),
        file_size
    );

    Ok(output_path.to_string_lossy().to_string())
}
