//! Binary payload for the WebGL live-stretch preview.
//!
//! One call produces everything the frontend needs to re-stretch an image
//! per slider change without further Rust round-trips:
//!
//! - the pre-stretch pixel data (processinator `prepare`: normalize +
//!   gradient removal + renormalize), block-averaged down to a
//!   texture-friendly size,
//! - per-channel MTF statistics computed at **full** resolution, so the
//!   preview's transfer function matches what Apply will produce,
//! - a histogram of the reference (green) channel, from which the frontend
//!   reconstructs the parameter-dependent post-subtraction median that the
//!   linked MTF midtone needs (mono is fully analytic and skips it).
//!
//! Layout (little-endian): `[u32 header_len][JSON header, space-padded to a
//! 4-byte boundary][u32 × hist_bins histogram][f32 planar channel data]`.
//! The padding keeps the histogram and pixel blocks aligned for zero-copy
//! `Uint32Array`/`Float32Array` views on the JS side.

use std::path::Path;

use processinator::{mtf_stats_channel, mtf_stats_linked, prepare, read_fits, MtfStats};
use serde::Serialize;

use super::StretchParams;

/// Histogram resolution. Keep in sync with `HIST_BINS` in
/// `src/lib/stretch/mtf-solution.ts` and processinator's display tests.
const HIST_BINS: usize = 1 << 16;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatsJson {
    median: f64,
    p25: f64,
    mad: f64,
    count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HeaderJson {
    version: u32,
    /// Dimensions of the pixel block (possibly downsampled).
    width: usize,
    height: usize,
    channels: usize,
    /// Full-resolution dimensions the stats/histogram were computed at.
    full_width: usize,
    full_height: usize,
    /// 0 for mono (no histogram block present).
    hist_bins: usize,
    ref_channel: usize,
    stats: Vec<StatsJson>,
    /// Post-stretch constants from the pipeline config, applied in the
    /// shader so the preview matches the final JPEG.
    green_removal: f64,
    saturation: f64,
}

/// Build the live-stretch payload for a FITS file.
///
/// `params` selects the pre-stretch pipeline stages (gradient removal,
/// autocrop) — its bg/sigma are irrelevant here since the stretch itself
/// happens in the shader. `max_dim` caps the longer pixel-block edge.
pub fn build_stretch_payload(
    fits_path: &Path,
    params: &StretchParams,
    max_dim: u32,
) -> Result<Vec<u8>, String> {
    let start = std::time::Instant::now();
    let config = params.to_pipeline_config();

    let raw = read_fits(fits_path).map_err(|e| e.to_string())?;
    let prepared = prepare(raw, &config);

    let (w, h, n) = (prepared.width(), prepared.height(), prepared.num_channels());
    let is_color = prepared.is_color();
    let ref_channel = std::cmp::min(1, n - 1);

    // Full-resolution statistics — these define the transfer function, so
    // they must not see downsampled (noise-averaged) data
    let stats: Vec<StatsJson> = prepared
        .channels()
        .iter()
        .map(|ch| {
            let s: MtfStats = if is_color {
                mtf_stats_linked(ch)
            } else {
                mtf_stats_channel(ch)
            };
            StatsJson {
                median: s.median,
                p25: s.p25,
                mad: s.mad,
                count: s.count,
            }
        })
        .collect();

    let hist = if is_color {
        histogram(prepared.channel(ref_channel))
    } else {
        Vec::new()
    };

    // Downsample for the texture; k = 1 is a plain f32 cast
    let k = ((w.max(h)) as u32).div_ceil(max_dim.max(1)).max(1) as usize;
    let (out_w, out_h) = (w.div_ceil(k), h.div_ceil(k));
    let pixels: Vec<Vec<f32>> = prepared
        .channels()
        .iter()
        .map(|ch| downsample_channel(ch, w, h, k))
        .collect();

    let header = HeaderJson {
        version: 1,
        width: out_w,
        height: out_h,
        channels: n,
        full_width: w,
        full_height: h,
        hist_bins: hist.len(),
        ref_channel,
        stats,
        green_removal: config.green_removal,
        saturation: config.saturation,
    };

    let payload = assemble(&header, &hist, &pixels)?;
    log::info!(
        "stretch-data: {}x{} {} → {}x{} texture, {} bytes in {:?}",
        w,
        h,
        if is_color { "RGB" } else { "mono" },
        out_w,
        out_h,
        payload.len(),
        start.elapsed()
    );
    Ok(payload)
}

/// Counts of the positive samples over (0, 1], `HIST_BINS` uniform bins.
fn histogram(data: &[f64]) -> Vec<u32> {
    let mut hist = vec![0u32; HIST_BINS];
    for &v in data {
        if v > 0.0 {
            let bin = ((v * HIST_BINS as f64) as usize).min(HIST_BINS - 1);
            hist[bin] += 1;
        }
    }
    hist
}

/// Block-average a channel by integer factor `k` (partial edge blocks
/// average over their actual pixel count), casting to f32 for the texture.
fn downsample_channel(data: &[f64], w: usize, h: usize, k: usize) -> Vec<f32> {
    if k <= 1 {
        return data.iter().map(|&v| v as f32).collect();
    }
    let (ow, oh) = (w.div_ceil(k), h.div_ceil(k));
    let mut out = vec![0f32; ow * oh];
    for oy in 0..oh {
        let y0 = oy * k;
        let y1 = (y0 + k).min(h);
        for ox in 0..ow {
            let x0 = ox * k;
            let x1 = (x0 + k).min(w);
            let mut sum = 0.0f64;
            for y in y0..y1 {
                for x in x0..x1 {
                    sum += data[y * w + x];
                }
            }
            out[oy * ow + ox] = (sum / ((y1 - y0) * (x1 - x0)) as f64) as f32;
        }
    }
    out
}

fn assemble(header: &HeaderJson, hist: &[u32], pixels: &[Vec<f32>]) -> Result<Vec<u8>, String> {
    let mut json = serde_json::to_vec(header).map_err(|e| e.to_string())?;
    while json.len() % 4 != 0 {
        json.push(b' ');
    }

    let pixel_bytes: usize = pixels.iter().map(|ch| ch.len() * 4).sum();
    let mut buf = Vec::with_capacity(4 + json.len() + hist.len() * 4 + pixel_bytes);
    buf.extend_from_slice(&(json.len() as u32).to_le_bytes());
    buf.extend_from_slice(&json);
    for &c in hist {
        buf.extend_from_slice(&c.to_le_bytes());
    }
    for ch in pixels {
        for &v in ch {
            buf.extend_from_slice(&v.to_le_bytes());
        }
    }
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use processinator::{make_test_image, write_fits, SyntheticParams};

    fn payload_for(rgb: bool, max_dim: u32) -> Vec<u8> {
        let field = make_test_image(&SyntheticParams {
            rgb,
            seed: 42,
            ..Default::default()
        });
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.fits");
        write_fits(&field.data, &path).unwrap();
        build_stretch_payload(&path, &StretchParams::default(), max_dim).unwrap()
    }

    fn parse(payload: &[u8]) -> (serde_json::Value, usize) {
        let header_len = u32::from_le_bytes(payload[0..4].try_into().unwrap()) as usize;
        assert_eq!(header_len % 4, 0, "header must be 4-byte aligned");
        let header: serde_json::Value = serde_json::from_slice(&payload[4..4 + header_len]).unwrap();
        (header, 4 + header_len)
    }

    #[test]
    fn rgb_payload_roundtrips() {
        let payload = payload_for(true, 4096);
        let (header, body_off) = parse(&payload);

        assert_eq!(header["version"], 1);
        assert_eq!(header["channels"], 3);
        assert_eq!(header["histBins"], HIST_BINS);
        assert_eq!(header["refChannel"], 1);
        assert_eq!(header["stats"].as_array().unwrap().len(), 3);
        assert!(header["stats"][0]["median"].as_f64().unwrap() > 0.0);
        // Pins processinator's PipelineConfig::default() SCNR strength —
        // halved to 0.5 there (full strength tinted skies magenta)
        assert_eq!(header["greenRemoval"], 0.5);
        assert_eq!(header["saturation"], 1.25);

        let w = header["width"].as_u64().unwrap() as usize;
        let h = header["height"].as_u64().unwrap() as usize;
        assert_eq!(header["fullWidth"], w as u64); // no downsample at 4096
        let expected = body_off + HIST_BINS * 4 + w * h * 3 * 4;
        assert_eq!(payload.len(), expected);

        // Histogram counts every positive pixel of the full-res green channel
        let hist_total: u64 = payload[body_off..body_off + HIST_BINS * 4]
            .chunks_exact(4)
            .map(|c| u32::from_le_bytes(c.try_into().unwrap()) as u64)
            .sum();
        assert!(hist_total > 0 && hist_total <= (w * h) as u64);

        // Pixel block is [0, 1] floats
        let px_off = body_off + HIST_BINS * 4;
        for c in payload[px_off..px_off + 64].chunks_exact(4) {
            let v = f32::from_le_bytes(c.try_into().unwrap());
            assert!((0.0..=1.0).contains(&v), "pixel out of range: {v}");
        }
    }

    #[test]
    fn mono_payload_skips_histogram() {
        let payload = payload_for(false, 4096);
        let (header, body_off) = parse(&payload);

        assert_eq!(header["channels"], 1);
        assert_eq!(header["histBins"], 0);
        let w = header["width"].as_u64().unwrap() as usize;
        let h = header["height"].as_u64().unwrap() as usize;
        assert_eq!(payload.len(), body_off + w * h * 4);
    }

    #[test]
    fn downsample_caps_dimensions() {
        let payload = payload_for(true, 64);
        let (header, _) = parse(&payload);
        let w = header["width"].as_u64().unwrap();
        let h = header["height"].as_u64().unwrap();
        assert!(w <= 64 && h <= 64);
        assert!(header["fullWidth"].as_u64().unwrap() > w);
        // Stats stay full-res: unchanged vs the 4096 payload
        let (full_header, _) = parse(&payload_for(true, 4096));
        assert_eq!(header["stats"], full_header["stats"]);
    }
}
