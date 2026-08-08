//! Native (no-Python) image processing over the processinator pipeline.
//!
//! The desktop `process_fits_image` command still runs through PyO3; this
//! module is the daemon's equivalent — the staging daemon has no usable
//! Python runtime, so the server path maps the same `ProcessingParams`
//! onto `processinator::PipelineConfig` and runs natively. It also hosts
//! the target-classification table (ported from
//! `python/astra_astro/target_classify.py`, minus the SIMBAD network
//! fallback — that's the separate "SIMBAD proxy" task) and the
//! per-target-type defaults shared with the desktop
//! `get_processing_defaults` command.

use std::path::Path;

use image::imageops::FilterType;
use processinator::{process, read_fits, to_dynamic_image, PipelineConfig, StretchAlgorithm};
use serde::Serialize;

use crate::python::image_process::{ProcessingParams, TargetInfo};

/// Astronomical target categories, mirroring the Python `TargetType` enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetType {
    EmissionNebula,
    ReflectionNebula,
    PlanetaryNebula,
    Galaxy,
    GlobularCluster,
    OpenCluster,
    StarField,
    Unknown,
}

impl TargetType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::EmissionNebula => "emission_nebula",
            Self::ReflectionNebula => "reflection_nebula",
            Self::PlanetaryNebula => "planetary_nebula",
            Self::Galaxy => "galaxy",
            Self::GlobularCluster => "globular_cluster",
            Self::OpenCluster => "open_cluster",
            Self::StarField => "star_field",
            Self::Unknown => "unknown",
        }
    }

    pub fn from_str(value: &str) -> Self {
        match value {
            "emission_nebula" => Self::EmissionNebula,
            "reflection_nebula" => Self::ReflectionNebula,
            "planetary_nebula" => Self::PlanetaryNebula,
            "galaxy" => Self::Galaxy,
            "globular_cluster" => Self::GlobularCluster,
            "open_cluster" => Self::OpenCluster,
            "star_field" => Self::StarField,
            _ => Self::Unknown,
        }
    }
}

/// Per-target processing defaults (`TARGET_PARAMS` in the Python module):
/// (stretch_factor, background_removal, star_reduction).
fn target_defaults(target: TargetType) -> (f64, bool, bool) {
    match target {
        TargetType::EmissionNebula => (0.18, true, true),
        TargetType::ReflectionNebula => (0.15, true, false),
        TargetType::PlanetaryNebula => (0.20, true, false),
        TargetType::Galaxy => (0.12, true, false),
        TargetType::GlobularCluster => (0.10, true, false),
        TargetType::OpenCluster => (0.08, true, false),
        TargetType::StarField => (0.05, false, false),
        TargetType::Unknown => (0.15, true, false),
    }
}

/// Default processing parameters for a target type — the table behind the
/// desktop `get_processing_defaults` command and the daemon's
/// `/api/processing/defaults`.
pub fn processing_defaults(target_type: &str) -> ProcessingParams {
    let target = TargetType::from_str(target_type);
    let (stretch_factor, background_removal, star_reduction) = target_defaults(target);
    ProcessingParams {
        target_type: target_type.to_string(),
        stretch_factor,
        background_removal,
        star_reduction,
        ..ProcessingParams::default()
    }
}

/// Normalize an object name for table lookup (Python `_normalize_name`,
/// plus collapsing "M 42" → "M42": astra stores Messier summaries with the
/// space, and without the SIMBAD fallback the spaced form would never hit
/// the table).
fn normalize_name(name: &str) -> String {
    let mut n = name.trim().to_uppercase();
    if let Some(rest) = n.strip_prefix("MESSIER") {
        n = format!("M{}", rest.trim_start());
    }
    if let Some(rest) = n.strip_prefix("NGC") {
        n = format!("NGC {}", rest.trim_start());
    } else if let Some(rest) = n.strip_prefix("IC") {
        n = format!("IC {}", rest.trim_start());
    } else if let Some(rest) = n.strip_prefix("M") {
        let trimmed = rest.trim_start();
        if !trimmed.is_empty() && trimmed.chars().all(|c| c.is_ascii_digit()) {
            n = format!("M{trimmed}");
        }
    }
    n
}

/// Well-known objects with definite types (`KNOWN_OBJECTS`).
fn known_object(normalized: &str) -> Option<TargetType> {
    Some(match normalized {
        "M42" | "M43" | "M1" | "M8" | "M16" | "M17" | "M20" | "NGC 7000" | "NGC 6992"
        | "NGC 6960" | "IC 1805" | "IC 1848" | "IC 434" => TargetType::EmissionNebula,
        "M78" => TargetType::ReflectionNebula,
        "M27" | "M57" | "M76" | "M97" | "NGC 6543" | "NGC 7293" => TargetType::PlanetaryNebula,
        "M31" | "M32" | "M33" | "M51" | "M81" | "M82" | "M101" | "M104" | "NGC 253"
        | "NGC 891" => TargetType::Galaxy,
        "M2" | "M3" | "M5" | "M13" | "M15" | "M22" | "M92" | "NGC 5139" => {
            TargetType::GlobularCluster
        }
        "M6" | "M7" | "M11" | "M35" | "M36" | "M37" | "M38" | "M44" | "M45" | "M67"
        | "NGC 869" | "NGC 884" => TargetType::OpenCluster,
        _ => return None,
    })
}

/// `prefix` then optional spaces/`extra` separators then a digit.
fn catalog_number(name: &str, prefix: &str, extra: &[char]) -> bool {
    name.strip_prefix(prefix).is_some_and(|rest| {
        let rest = rest.trim_start_matches(|c: char| c == ' ' || extra.contains(&c));
        rest.starts_with(|c: char| c.is_ascii_digit())
    })
}

/// Catalog name patterns (`KNOWN_PATTERNS`), checked in the Python order.
fn known_pattern(normalized: &str) -> Option<(TargetType, f64)> {
    // Sharpless: "SH" [spaces] "2" [spaces/dashes] digits
    let sharpless = normalized.strip_prefix("SH").is_some_and(|rest| {
        rest.trim_start()
            .strip_prefix('2')
            .is_some_and(|rest| {
                rest.trim_start_matches([' ', '-'])
                    .starts_with(|c: char| c.is_ascii_digit())
            })
    });
    if sharpless {
        return Some((TargetType::EmissionNebula, 0.9));
    }
    if catalog_number(normalized, "LBN", &[]) {
        return Some((TargetType::EmissionNebula, 0.8));
    }
    if catalog_number(normalized, "LDN", &[]) {
        return Some((TargetType::StarField, 0.7));
    }
    if catalog_number(normalized, "VDB", &[]) {
        return Some((TargetType::ReflectionNebula, 0.9));
    }
    if catalog_number(normalized, "ABELL", &[]) {
        return Some((TargetType::PlanetaryNebula, 0.6));
    }
    if catalog_number(normalized, "B", &[]) {
        return Some((TargetType::StarField, 0.7));
    }
    None
}

/// Classify a target from its object name using the known-objects table and
/// catalog patterns. No SIMBAD fallback (network lookups belong to the
/// daemon's future SIMBAD proxy) — unmatched names come back `unknown` with
/// zero confidence.
pub fn classify_target_native(object_name: &str) -> TargetInfo {
    let name = object_name.trim();
    if name.is_empty() {
        return TargetInfo {
            target_type: TargetType::Unknown.as_str().to_string(),
            object_name: String::new(),
            confidence: 0.0,
            simbad_type: None,
        };
    }

    let normalized = normalize_name(name);
    let (target, confidence) = if let Some(t) = known_object(&normalized) {
        (t, 1.0)
    } else if let Some((t, c)) = known_pattern(&normalized) {
        (t, c)
    } else {
        (TargetType::Unknown, 0.0)
    };

    TargetInfo {
        target_type: target.as_str().to_string(),
        object_name: name.to_string(),
        confidence,
        simbad_type: None,
    }
}

/// The parameters actually applied after target-default resolution —
/// recorded in the image's processing metadata and echoed to the client.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedParams {
    pub target_type: String,
    pub stretch_method: String,
    pub stretch_factor: f64,
    pub background_removal: bool,
    pub star_reduction: bool,
    pub color_calibration: bool,
    pub noise_reduction: f64,
    pub contrast: f64,
}

/// Output of a native processing run.
pub struct ProcessedImage {
    pub preview_jpeg: Vec<u8>,
    pub thumbnail_jpeg: Vec<u8>,
    pub preview_dims: (u32, u32),
    pub thumbnail_dims: (u32, u32),
    pub applied: AppliedParams,
}

/// Map processing parameters onto the native pipeline. `stretch_factor`
/// and `star_reduction` are the target-default-resolved values.
fn pipeline_config(
    params: &ProcessingParams,
    stretch_factor: f64,
    star_reduction: bool,
) -> PipelineConfig {
    PipelineConfig {
        gradient_removal: params.background_removal,
        color_calibration: params.color_calibration,
        stretch: match params.stretch_method.as_str() {
            "arcsinh" => StretchAlgorithm::Arcsinh {
                factor: stretch_factor,
            },
            "log" => StretchAlgorithm::Log {
                factor: stretch_factor,
            },
            // "statistical" and anything unrecognized, like the Python flow
            _ => StretchAlgorithm::Statistical {
                target_median: stretch_factor,
                low_percentile: 0.5,
                high_percentile: 99.9,
            },
        },
        contrast: params.contrast,
        star_reduction,
        // Wavelet denoise stands in for the Python path's gaussian blur:
        // strength (0-1) maps onto the threshold in noise sigmas, hitting
        // the library default (3.0) at strength ~0.33
        denoise: params.noise_reduction > 0.0,
        denoise_threshold: 2.0 + params.noise_reduction.clamp(0.0, 1.0) * 3.0,
        ..Default::default()
    }
}

/// Process FITS bytes into preview + thumbnail JPEGs using the native
/// pipeline. Auto-classification uses `object_name` when
/// `params.target_type` is "auto".
///
/// Takes the bytes by value so a 150 MB source file isn't kept in memory
/// while the pipeline runs — the buffer is released as soon as it lands
/// in the temp file the FITS reader wants.
pub fn process_fits_bytes(
    fits_bytes: Vec<u8>,
    params: &ProcessingParams,
    object_name: Option<&str>,
) -> Result<ProcessedImage, String> {
    // The FITS reader is path-based; stage the bytes in a temp file
    let tmp = std::env::temp_dir().join(format!("astra_process_{}.fits", uuid::Uuid::new_v4()));
    std::fs::write(&tmp, &fits_bytes).map_err(|e| format!("temp write: {e}"))?;
    drop(fits_bytes);
    let result = process_fits_file(&tmp, params, object_name);
    let _ = std::fs::remove_file(&tmp);
    result
}

fn process_fits_file(
    fits_path: &Path,
    params: &ProcessingParams,
    object_name: Option<&str>,
) -> Result<ProcessedImage, String> {
    // Resolve target type: explicit wins; "auto" classifies from the name
    let target = if params.target_type == "auto" {
        match object_name {
            Some(name) => TargetType::from_str(&classify_target_native(name).target_type),
            None => TargetType::Unknown,
        }
    } else {
        TargetType::from_str(&params.target_type)
    };
    let (default_factor, _, default_star_reduction) = target_defaults(target);
    let stretch_factor = if params.stretch_factor > 0.0 {
        params.stretch_factor
    } else {
        default_factor
    };
    let star_reduction = params.star_reduction || default_star_reduction;

    let config = pipeline_config(params, stretch_factor, star_reduction);
    let data = read_fits(fits_path).map_err(|e| format!("FITS read: {e}"))?;
    let processed = process(data, &config);
    let rgb = to_dynamic_image(&processed).to_rgb8();
    // The f64 planes are ~8x the u8 copy; release them before encoding
    drop(processed);

    let (preview_jpeg, preview_dims) = encode_jpeg(&rgb, 1920, 85)?;
    let (thumbnail_jpeg, thumbnail_dims) = encode_jpeg(&rgb, 256, 70)?;

    Ok(ProcessedImage {
        preview_jpeg,
        thumbnail_jpeg,
        preview_dims,
        thumbnail_dims,
        applied: AppliedParams {
            target_type: target.as_str().to_string(),
            stretch_method: params.stretch_method.clone(),
            stretch_factor,
            background_removal: params.background_removal,
            star_reduction,
            color_calibration: params.color_calibration,
            noise_reduction: params.noise_reduction,
            contrast: params.contrast,
        },
    })
}

/// Resize (if needed) and JPEG-encode, matching the FITS variant
/// generator's quality settings.
fn encode_jpeg(rgb: &image::RgbImage, max_dim: u32, quality: u8) -> Result<(Vec<u8>, (u32, u32)), String> {
    let (w, h) = (rgb.width(), rgb.height());
    let resized;
    let out = if w > max_dim || h > max_dim {
        let scale = max_dim as f64 / w.max(h) as f64;
        resized = image::imageops::resize(
            rgb,
            (w as f64 * scale) as u32,
            (h as f64 * scale) as u32,
            FilterType::Lanczos3,
        );
        &resized
    } else {
        rgb
    };

    let mut buf = std::io::Cursor::new(Vec::new());
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality);
    encoder
        .encode(
            out.as_raw(),
            out.width(),
            out.height(),
            image::ExtendedColorType::Rgb8,
        )
        .map_err(|e| format!("JPEG encode: {e}"))?;
    Ok((buf.into_inner(), (out.width(), out.height())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classification_matches_python_table() {
        for (name, expected, confidence) in [
            ("M42", "emission_nebula", 1.0),
            ("messier 42", "emission_nebula", 1.0),
            ("NGC7000", "emission_nebula", 1.0),
            ("M 78", "reflection_nebula", 1.0),
            ("m31", "galaxy", 1.0),
            ("Sh2-155", "emission_nebula", 0.9),
            ("SH 2 155", "emission_nebula", 0.9),
            ("vdB 141", "reflection_nebula", 0.9),
            ("B33", "star_field", 0.7),
            ("LBN 437", "emission_nebula", 0.8),
            ("Abell 39", "planetary_nebula", 0.6),
            ("Some Random Star", "unknown", 0.0),
            ("", "unknown", 0.0),
        ] {
            let info = classify_target_native(name);
            assert_eq!(info.target_type, expected, "{name}");
            assert_eq!(info.confidence, confidence, "{name}");
        }
    }

    #[test]
    fn m78_is_reflection_not_pattern_b() {
        // "M78" must hit the known-objects table, not fall through
        assert_eq!(classify_target_native("M78").target_type, "reflection_nebula");
    }

    #[test]
    fn defaults_match_desktop_command_table() {
        let emission = processing_defaults("emission_nebula");
        assert_eq!(emission.stretch_factor, 0.18);
        assert!(emission.star_reduction);
        let star_field = processing_defaults("star_field");
        assert_eq!(star_field.stretch_factor, 0.05);
        assert!(!star_field.background_removal);
        let unknown = processing_defaults("something_else");
        assert_eq!(unknown.stretch_factor, 0.15);
    }

    #[test]
    fn process_synthetic_fits_end_to_end() {
        let field = processinator::make_test_image(&processinator::SyntheticParams {
            rgb: true,
            seed: 42,
            ..Default::default()
        });
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.fits");
        processinator::write_fits(&field.data, &path).unwrap();
        let bytes = std::fs::read(&path).unwrap();

        let params = ProcessingParams {
            noise_reduction: 0.3,
            star_reduction: true,
            ..ProcessingParams::default()
        };
        let out = process_fits_bytes(bytes, &params, Some("M42")).unwrap();

        assert!(!out.preview_jpeg.is_empty());
        assert!(!out.thumbnail_jpeg.is_empty());
        assert!(out.thumbnail_dims.0 <= 256 && out.thumbnail_dims.1 <= 256);
        assert_eq!(out.applied.target_type, "emission_nebula");
        // Explicit stretch_factor (default 0.15) wins over the target table
        assert_eq!(out.applied.stretch_factor, 0.15);
        assert!(out.applied.star_reduction);
        // JPEG magic bytes
        assert_eq!(&out.preview_jpeg[..2], &[0xFF, 0xD8]);
    }
}
