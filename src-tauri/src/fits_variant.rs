//! FITS variant generator for HoardFS.
//!
//! Implements the HoardFS VariantGenerator trait for FITS files,
//! using the processinator stretch pipeline to produce JPEG thumbnails
//! and previews.

use async_trait::async_trait;
use hoardfs_core::{Quality, Result as HoardResult};
use hoardfs_variant::{VariantGenerator, VariantOutput};
use processinator::{read_fits, stretch, to_dynamic_image, StretchAlgorithm, StretchOptions};
use std::io::Cursor;

use crate::stretch::StretchParams;

/// Variant generator for FITS astrophotography files.
///
/// Generates JPEG thumbnails and previews by running the MTF stretch
/// pipeline on raw FITS data. Registered with HoardFS's VariantPipeline
/// at app startup.
pub struct FitsVariantGenerator {
    params: StretchParams,
}

impl FitsVariantGenerator {
    pub fn new() -> Self {
        Self {
            params: StretchParams::default(),
        }
    }
}

#[async_trait]
impl VariantGenerator for FitsVariantGenerator {
    fn supported_types(&self) -> &[&str] {
        &["image/fits", "application/fits", "application/x-fits"]
    }

    async fn generate(
        &self,
        source: &[u8],
        _source_type: &str,
        quality: &Quality,
    ) -> HoardResult<Option<VariantOutput>> {
        // Only generate Thumbnail and Preview
        let max_dim = match quality {
            Quality::Thumbnail => 256u32,
            Quality::Preview => 1920u32,
            Quality::Full => 4096u32,
            _ => return Ok(None),
        };

        let jpeg_quality = match quality {
            Quality::Thumbnail => 70u8,
            Quality::Preview => 85u8,
            _ => 90u8,
        };

        // The FITS reader only works from file paths, so write to a temp file
        let tmp = std::env::temp_dir().join(format!("astra_fits_{}.fits", uuid::Uuid::new_v4()));
        std::fs::write(&tmp, source)
            .map_err(|e| hoardfs_core::HoardError::Backend(format!("Temp write: {}", e)))?;
        let result = read_fits(&tmp);
        let _ = std::fs::remove_file(&tmp);
        let data = result
            .map_err(|e| hoardfs_core::HoardError::Backend(format!("FITS parse: {}", e)))?;

        // Normalize + MTF stretch (no autocrop for variants, matching the
        // pre-processinator behavior)
        let stretched = stretch(
            data,
            &StretchOptions {
                algorithm: StretchAlgorithm::Mtf {
                    bg_percent: self.params.bg_percent,
                    sigma: self.params.sigma,
                    linked: true,
                },
                autocrop: false,
                pre_normalized: false,
            },
        );

        // Mono comes back as Luma8; variants are always RGB JPEGs
        let img = to_dynamic_image(&stretched).to_rgb8();
        let (width, height) = (img.width(), img.height());

        // Resize if needed
        let (out_w, out_h) = if width > max_dim || height > max_dim {
            let scale = max_dim as f64 / (width.max(height) as f64);
            ((width as f64 * scale) as u32, (height as f64 * scale) as u32)
        } else {
            (width, height)
        };

        let resized = if out_w != width || out_h != height {
            image::imageops::resize(&img, out_w, out_h, image::imageops::FilterType::Lanczos3)
        } else {
            image::imageops::resize(&img, out_w, out_h, image::imageops::FilterType::Nearest)
        };

        // Encode as JPEG
        let mut buf = Cursor::new(Vec::new());
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, jpeg_quality);
        encoder.encode(
            resized.as_raw(),
            out_w,
            out_h,
            image::ExtendedColorType::Rgb8,
        ).map_err(|e| hoardfs_core::HoardError::Backend(format!("JPEG encode: {}", e)))?;

        Ok(Some(VariantOutput {
            data: buf.into_inner(),
            content_type: "image/jpeg".to_string(),
            width: out_w,
            height: out_h,
            metadata: None,
        }))
    }
}
