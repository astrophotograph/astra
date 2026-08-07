/**
 * MTF stretch solution math for the WebGL live-stretch preview.
 *
 * The `get_stretch_data` command sends pre-stretch pixel data once, plus
 * per-channel statistics and a reference-channel histogram computed at full
 * resolution. From those, this module recomputes the exact shadows/scale/
 * midtone the Rust pipeline would use for any (bgPercent, sigma) — so
 * slider changes never leave the GPU path.
 *
 * Transcribed from processinator-rs `stretch.rs`; the `frontend_*` functions
 * in its `tests/display_test.rs` are the same math and pin it against the
 * exact pipeline solution. Keep the two in sync.
 */

/** Per-channel order statistics from the Rust payload header. */
export interface MtfChannelStats {
  median: number;
  p25: number;
  mad: number;
  /** Number of valid samples; 0 means the stretch is a no-op. */
  count: number;
}

/** Parsed `get_stretch_data` payload. */
export interface StretchPayload {
  version: number;
  /** Dimensions of the (possibly downsampled) pixel block. */
  width: number;
  height: number;
  channels: number;
  /** Full-resolution dimensions the stats/histogram were computed at. */
  fullWidth: number;
  fullHeight: number;
  histBins: number;
  refChannel: number;
  stats: MtfChannelStats[];
  /** Post-stretch constants applied in the shader (match the final JPEG). */
  greenRemoval: number;
  saturation: number;
  /** Reference-channel histogram; null for mono. */
  histogram: Uint32Array | null;
  /** Planar float pixels, `channels × width × height`, [0, 1]. */
  pixels: Float32Array;
}

/**
 * What the shader applies per pixel:
 * `v' = MTF(midtone, clamp((v - shadows[c]) * scale, 0, 1))`.
 */
export interface MtfSolution {
  shadows: [number, number, number];
  scale: number;
  midtone: number;
}

/**
 * Parse the binary payload: `[u32 headerLen][JSON header (4-byte padded)]
 * [u32 × histBins histogram][f32 planar pixels]`, little-endian.
 */
export function parseStretchPayload(buf: ArrayBuffer): StretchPayload {
  if (buf.byteLength < 8) throw new Error("stretch payload truncated");
  const headerLen = new DataView(buf).getUint32(0, true);
  const header = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buf, 4, headerLen)),
  );
  if (header.version !== 1) {
    throw new Error(`unsupported stretch payload version ${header.version}`);
  }

  let offset = 4 + headerLen;
  let histogram: Uint32Array | null = null;
  if (header.histBins > 0) {
    histogram = new Uint32Array(buf, offset, header.histBins);
    offset += header.histBins * 4;
  }

  const pixelCount = header.width * header.height * header.channels;
  if (offset + pixelCount * 4 > buf.byteLength) {
    throw new Error(
      `stretch payload truncated: need ${offset + pixelCount * 4} bytes, got ${buf.byteLength}`,
    );
  }
  const pixels = new Float32Array(buf, offset, pixelCount);

  return { ...header, histogram, pixels };
}

/** The solution the Rust pipeline would use for these parameters. */
export function computeMtfSolution(
  payload: StretchPayload,
  bgPercent: number,
  sigma: number,
): MtfSolution {
  if (payload.channels === 1) {
    return monoSolution(payload.stats[0], bgPercent, sigma);
  }
  if (!payload.histogram) throw new Error("color payload missing histogram");
  return linkedSolution(payload.stats, payload.histogram, payload.refChannel, bgPercent, sigma);
}

/** Linked color: offset-neutralized shadows, shared midtone from green. */
function linkedSolution(
  stats: MtfChannelStats[],
  hist: Uint32Array,
  refChannel: number,
  bgPercent: number,
  sigma: number,
): MtfSolution {
  const k = sigma * 1.4826;
  let residual = Infinity;
  for (const s of stats) {
    residual = Math.min(residual, s.median - s.p25 + k * s.mad);
  }
  const shadows = stats.map((s) => Math.max(s.median - residual, 0));
  const maxShadow = Math.max(...shadows);
  const scale = 1 / Math.max(1 - maxShadow, 1e-6);

  // The midtone anchors on the reference channel's median *after* shadow
  // subtraction — recovered from the histogram as the median of values
  // above the shadow, mapped through the same linear transform.
  const mc = conditionalMedian(hist, shadows[refChannel]);
  const refMedian =
    mc === null ? 0 : clamp((mc - shadows[refChannel]) * scale, 0, 1);

  return {
    shadows: [shadows[0], shadows[1] ?? shadows[0], shadows[2] ?? shadows[0]],
    scale,
    midtone: midtoneForBackground(refMedian, bgPercent),
  };
}

/** Mono: quartile-anchored shadow clip, analytic midtone. */
function monoSolution(
  stats: MtfChannelStats,
  bgPercent: number,
  sigma: number,
): MtfSolution {
  if (stats.count === 0) {
    // No valid samples — identity (MTF at 0.5 is the identity map)
    return { shadows: [0, 0, 0], scale: 1, midtone: 0.5 };
  }
  const shadow = Math.max(stats.p25 - sigma * stats.mad * 1.4826, 0);
  const range = 1 - shadow;
  const medianNorm = (stats.median - shadow) / range;
  return {
    shadows: [shadow, shadow, shadow],
    scale: 1 / range,
    midtone: midtoneForBackground(medianNorm, bgPercent),
  };
}

/**
 * Median of the histogrammed values strictly above `threshold`, assuming a
 * uniform distribution inside each bin. Null when nothing lies above.
 */
function conditionalMedian(hist: Uint32Array, threshold: number): number | null {
  const bins = hist.length;
  const t = Math.max(threshold, 0);
  const tb = Math.min(Math.floor(t * bins), bins - 1);
  const binLo = tb / bins;
  const binHi = (tb + 1) / bins;
  const fracAbove = t <= binLo ? 1 : Math.max((binHi - t) * bins, 0);

  const first = hist[tb] * fracAbove;
  let total = first;
  for (let i = tb + 1; i < bins; i++) total += hist[i];
  if (total <= 0) return null;

  const target = total / 2;
  if (first >= target) return t + (target / first) * (binHi - t);
  let acc = first;
  for (let i = tb + 1; i < bins; i++) {
    const c = hist[i];
    if (acc + c >= target) return (i + (target - acc) / c) / bins;
    acc += c;
  }
  return (bins - 0.5) / bins;
}

/** Midtone balance that lands a background at `median` on `bgPercent`. */
function midtoneForBackground(median: number, bgPercent: number): number {
  if (median > 0 && median < 1 && bgPercent > 0) {
    const m =
      (median * (bgPercent - 1)) /
      (2 * bgPercent * median - bgPercent - median);
    return clamp(m, 1e-4, 0.9999);
  }
  return 0.5;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}
