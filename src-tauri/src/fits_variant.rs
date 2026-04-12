//! FITS variant generator for HoardFS.
//!
//! Implements the HoardFS VariantGenerator trait for FITS files,
//! using Astra's stretch pipeline to produce JPEG thumbnails and previews.

use async_trait::async_trait;
use hoardfs_core::{Quality, Result as HoardResult};
use hoardfs_variant::{VariantGenerator, VariantOutput};
use std::io::Cursor;

use crate::stretch::StretchParams;
use crate::stretch::mtf;

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

        // fitrs only reads from file paths, so write to a temp file
        let tmp = std::env::temp_dir().join(format!("astra_fits_{}.fits", uuid::Uuid::new_v4()));
        std::fs::write(&tmp, source)
            .map_err(|e| hoardfs_core::HoardError::Backend(format!("Temp write: {}", e)))?;
        let result = crate::stretch::read_fits_pixels(&tmp);
        let _ = std::fs::remove_file(&tmp);
        let (width, height, pixels, is_color) = result
            .map_err(|e| hoardfs_core::HoardError::Backend(format!("FITS parse: {}", e)))?;

        let channel_size = width * height;

        // Split into channels
        let mut channels: Vec<Vec<f64>> = if is_color {
            vec![
                pixels[0..channel_size].to_vec(),
                pixels[channel_size..channel_size * 2].to_vec(),
                pixels[channel_size * 2..channel_size * 3].to_vec(),
            ]
        } else {
            vec![pixels[0..channel_size].to_vec()]
        };

        // Normalize
        for ch in channels.iter_mut() {
            let mut sorted = ch.clone();
            let lo_idx = (sorted.len() as f64 * 0.001) as usize;
            let hi_idx = ((sorted.len() as f64 * 0.9999) as usize).min(sorted.len() - 1);
            sorted.select_nth_unstable_by(lo_idx, |a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let lo = sorted[lo_idx];
            sorted.select_nth_unstable_by(hi_idx, |a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let hi = sorted[hi_idx];
            let range = hi - lo;
            if range > 0.0 {
                for v in ch.iter_mut() {
                    *v = ((*v - lo) / range).clamp(0.0, 1.0);
                }
            }
        }

        // MTF stretch
        mtf::stretch_mtf_rgb(&mut channels, self.params.bg_percent, self.params.sigma);

        // Convert to RGB bytes
        let mut rgb = vec![0u8; channel_size * 3];
        if is_color {
            for i in 0..channel_size {
                rgb[i * 3] = (channels[0][i] * 255.0).clamp(0.0, 255.0) as u8;
                rgb[i * 3 + 1] = (channels[1][i] * 255.0).clamp(0.0, 255.0) as u8;
                rgb[i * 3 + 2] = (channels[2][i] * 255.0).clamp(0.0, 255.0) as u8;
            }
        } else {
            for i in 0..channel_size {
                let v = (channels[0][i] * 255.0).clamp(0.0, 255.0) as u8;
                rgb[i * 3] = v;
                rgb[i * 3 + 1] = v;
                rgb[i * 3 + 2] = v;
            }
        }

        let img = image::RgbImage::from_raw(width as u32, height as u32, rgb)
            .ok_or_else(|| hoardfs_core::HoardError::Backend("Failed to create image buffer".into()))?;

        // Resize if needed
        let (out_w, out_h) = if width as u32 > max_dim || height as u32 > max_dim {
            let scale = max_dim as f64 / (width.max(height) as f64);
            ((width as f64 * scale) as u32, (height as f64 * scale) as u32)
        } else {
            (width as u32, height as u32)
        };

        let resized = if out_w != width as u32 || out_h != height as u32 {
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
