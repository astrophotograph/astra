//! Full preview generation pipeline: FITS → stretch → JPEG.
//!
//! Replaces the Python/processinator path for `regenerate_preview`.

use std::path::Path;

use rayon::prelude::*;

use super::autocrop;
use super::gradient;
use super::mtf;

/// Parameters for the stretch pipeline.
pub struct StretchParams {
    pub bg_percent: f64,
    pub sigma: f64,
    pub gradient_removal: bool,
    pub autocrop: bool,
}

impl Default for StretchParams {
    fn default() -> Self {
        Self {
            bg_percent: 0.15,
            sigma: 3.0,
            gradient_removal: true,
            autocrop: true,
        }
    }
}

/// Generate a JPEG preview from a FITS file using the native Rust pipeline.
///
/// Returns the output path on success.
pub fn generate_preview(
    fits_path: &Path,
    output_path: &Path,
    params: &StretchParams,
) -> Result<String, String> {
    let start = std::time::Instant::now();

    log::info!("stretch: params bg_percent={}, sigma={}, gradient={}, autocrop={}",
        params.bg_percent, params.sigma, params.gradient_removal, params.autocrop);

    // Step 1: Read FITS
    let (width, height, pixels, is_color) = read_fits_pixels(fits_path)?;
    let channel_size = width * height;
    log::info!(
        "stretch: read FITS {}x{} {} in {:?}",
        width,
        height,
        if is_color { "RGB" } else { "mono" },
        start.elapsed()
    );

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

    // Step 2: Autocrop — detect edges from averaged channels
    let crop_bounds = if params.autocrop {
        let mono: Vec<f64> = if is_color {
            (0..channel_size)
                .map(|i| (channels[0][i] + channels[1][i] + channels[2][i]) / 3.0)
                .collect()
        } else {
            channels[0].clone()
        };
        let bounds = autocrop::detect_edges(&mono, width, height);
        if bounds.0 > 0 || bounds.1 > 0 || bounds.2 > 0 || bounds.3 > 0 {
            log::info!(
                "stretch: autocrop edges top={} bottom={} left={} right={}",
                bounds.0, bounds.1, bounds.2, bounds.3
            );
        }
        bounds
    } else {
        (0, 0, 0, 0)
    };

    // Step 3: Normalize — compute percentiles from interior, apply to full frame
    let t_norm = std::time::Instant::now();
    let (top, bottom, left, right) = crop_bounds;
    let interior_y0 = top;
    let interior_y1 = height - bottom;
    let interior_x0 = left;
    let interior_x1 = width - right;

    channels.par_iter_mut().for_each(|ch| {
        // Extract interior for statistics
        let mut interior: Vec<f64> = if top > 0 || bottom > 0 || left > 0 || right > 0 {
            let mut v = Vec::new();
            for y in interior_y0..interior_y1 {
                for x in interior_x0..interior_x1 {
                    v.push(ch[y * width + x]);
                }
            }
            v
        } else {
            ch.clone()
        };

        let (vmin, vmax) = percentiles_in_place(&mut interior, 0.001, 0.9999);
        let range = vmax - vmin;
        if range > 0.0 {
            for v in ch.iter_mut() {
                *v = ((*v - vmin) / range).clamp(0.0, 1.0);
            }
        }
    });
    log::info!("stretch: normalize in {:?}", t_norm.elapsed());

    // Step 4: Gradient removal (parallel per channel)
    if params.gradient_removal {
        let t_grad = std::time::Instant::now();
        let order = 2;
        channels.par_iter_mut().for_each(|ch| {
            let corrected = gradient::remove_gradient(ch, width, height, order);
            ch.copy_from_slice(&corrected);
        });
        log::info!("stretch: gradient removal in {:?}", t_grad.elapsed());
    }

    // Step 5: MTF stretch
    let t_mtf = std::time::Instant::now();
    mtf::stretch_mtf_rgb(&mut channels, params.bg_percent, params.sigma);
    log::info!("stretch: MTF in {:?}", t_mtf.elapsed());

    // Step 6: Interleave channels → RGB bytes → JPEG
    let t_save = std::time::Instant::now();
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
        .ok_or("Failed to create image buffer")?;

    img.save(output_path)
        .map_err(|e| format!("Failed to save JPEG: {}", e))?;

    let file_size = std::fs::metadata(output_path).map(|m| m.len()).unwrap_or(0);
    log::info!("stretch: save in {:?} ({} bytes)", t_save.elapsed(), file_size);
    log::info!("stretch: total pipeline in {:?}", start.elapsed());

    Ok(output_path.to_string_lossy().to_string())
}

/// Read FITS pixel data as f64 channels.
/// Returns (width, height, flat pixel data, is_color).
/// For RGB, data is laid out as [R..., G..., B...] (channel-first).
pub fn read_fits_pixels(path: &Path) -> Result<(usize, usize, Vec<f64>, bool), String> {
    use fitrs::Fits;

    let fits = Fits::open(path).map_err(|e| format!("Failed to open FITS: {}", e))?;
    let hdu = fits.into_iter().next().ok_or("No HDU in FITS file")?;

    let (width, height, pixels) = match hdu.read_data() {
        fitrs::FitsData::FloatingPoint32(data) => {
            let (w, h) = extract_dims(&data.shape);
            let pixels: Vec<f64> = data.data.iter().map(|&x| x as f64).collect();
            (w, h, pixels)
        }
        fitrs::FitsData::FloatingPoint64(data) => {
            let (w, h) = extract_dims(&data.shape);
            (w, h, data.data.clone())
        }
        fitrs::FitsData::IntegersI32(data) => {
            let (w, h) = extract_dims(&data.shape);
            let pixels: Vec<f64> = data.data.iter().map(|x| x.unwrap_or(0) as f64).collect();
            (w, h, pixels)
        }
        fitrs::FitsData::IntegersU32(data) => {
            let (w, h) = extract_dims(&data.shape);
            let pixels: Vec<f64> = data.data.iter().map(|x| x.unwrap_or(0) as f64).collect();
            (w, h, pixels)
        }
        _ => return Err("Unsupported FITS pixel format".to_string()),
    };

    let channel_size = width * height;
    let is_color = pixels.len() >= channel_size * 3;

    Ok((width, height, pixels, is_color))
}

/// Extract width and height from FITS shape.
/// fitrs shape is in FITS axis order: [NAXIS1, NAXIS2] or [NAXIS1, NAXIS2, NAXIS3].
/// For 3D (RGB) FITS, the shape is [width, height, 3] in fitrs order.
fn extract_dims(shape: &[usize]) -> (usize, usize) {
    match shape.len() {
        2 => (shape[0], shape[1]),       // [width, height]
        3 => (shape[0], shape[1]),       // [width, height, channels]
        _ => (shape[0], shape.get(1).copied().unwrap_or(1)),
    }
}

/// Compute two percentiles using quickselect (O(n) each).
/// Reuses the input slice to avoid allocation when possible.
fn percentiles_in_place(data: &mut [f64], lo_frac: f64, hi_frac: f64) -> (f64, f64) {
    if data.is_empty() {
        return (0.0, 1.0);
    }
    let cmp = |a: &f64, b: &f64| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal);
    let lo_idx = ((data.len() as f64 * lo_frac) as usize).min(data.len() - 1);
    data.select_nth_unstable_by(lo_idx, cmp);
    let lo_val = data[lo_idx];

    let hi_idx = ((data.len() as f64 * hi_frac) as usize).min(data.len() - 1);
    data.select_nth_unstable_by(hi_idx, cmp);
    let hi_val = data[hi_idx];

    (lo_val, hi_val)
}
