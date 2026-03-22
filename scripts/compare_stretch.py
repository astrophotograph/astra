#!/usr/bin/env python3
"""Compare stretch results against ASI Air reference preview.

Usage:
    cd python && uv run python ../scripts/compare_stretch.py <fits_path> [reference_jpg]

Generates side-by-side comparison images and prints per-channel statistics.
"""

import sys
from pathlib import Path

import numpy as np
from astropy.io import fits
from PIL import Image, ImageDraw, ImageFont

from processinator import StretchAlgorithm, fits_to_image, read_fits, stretch


def analyze_raw(fits_path: str):
    """Print raw FITS channel statistics."""
    with fits.open(fits_path) as hdul:
        raw = hdul[0].data.astype(np.float64)

    print(f"\n{'='*60}")
    print(f"Raw FITS: {Path(fits_path).name}")
    print(f"Shape: {raw.shape}, dtype: {raw.dtype}")
    print(f"{'='*60}")

    if raw.ndim == 3:
        names = ['R', 'G', 'B'] if raw.shape[0] == 3 else [f'Ch{i}' for i in range(raw.shape[0])]
        for i, name in enumerate(names):
            ch = raw[i]
            p = np.percentile(ch, [0.1, 1, 25, 50, 75, 99, 99.9, 99.99])
            print(f"  {name}: min={ch.min():.0f} p0.1={p[0]:.0f} p1={p[1]:.0f} "
                  f"p25={p[2]:.0f} median={p[3]:.0f} p75={p[4]:.0f} "
                  f"p99={p[5]:.0f} p99.9={p[6]:.0f} p99.99={p[7]:.0f} max={ch.max():.0f}")
    else:
        p = np.percentile(raw, [0.1, 1, 25, 50, 75, 99, 99.9, 99.99])
        print(f"  min={raw.min():.0f} p0.1={p[0]:.0f} median={p[3]:.0f} "
              f"p99={p[5]:.0f} p99.99={p[7]:.0f} max={raw.max():.0f}")


def analyze_image(img_array: np.ndarray, label: str):
    """Print per-channel statistics for a 0-1 or 0-255 image."""
    if img_array.max() > 1.0:
        img_array = img_array / 255.0

    print(f"\n  {label}:")
    if img_array.ndim == 3:
        for i, name in enumerate(['R', 'G', 'B']):
            ch = img_array[:, :, i]
            print(f"    {name}: min={ch.min():.4f} median={np.median(ch):.4f} "
                  f"mean={ch.mean():.4f} p95={np.percentile(ch, 95):.4f} max={ch.max():.4f}")
    else:
        print(f"    min={img_array.min():.4f} median={np.median(img_array):.4f} "
              f"mean={img_array.mean():.4f} max={img_array.max():.4f}")


def stretch_and_compare(fits_path: str, reference_path: str | None = None):
    """Generate multiple stretch variants and compare to reference."""
    analyze_raw(fits_path)

    # Load reference if available
    ref = None
    if reference_path and Path(reference_path).exists():
        ref = np.array(Image.open(reference_path)).astype(np.float64)
        analyze_image(ref, "Reference (ASI Air)")

    # Try multiple stretch configurations
    configs = [
        ("MTF 15% 3σ (default)", StretchAlgorithm.MTF, {"bg_percent": 0.15, "sigma": 3.0}),
        ("MTF 20% 3σ", StretchAlgorithm.MTF, {"bg_percent": 0.20, "sigma": 3.0}),
        ("MTF 25% 3σ", StretchAlgorithm.MTF, {"bg_percent": 0.25, "sigma": 3.0}),
        ("MTF 30% 2σ", StretchAlgorithm.MTF, {"bg_percent": 0.30, "sigma": 2.0}),
        ("MTF 20% 3σ unlinked", StretchAlgorithm.MTF, {"bg_percent": 0.20, "sigma": 3.0, "linked": False}),
        ("Arcsinh 0.15", StretchAlgorithm.ARCSINH, {"factor": 0.15}),
        ("Statistical 0.15", StretchAlgorithm.STATISTICAL, {"target_median": 0.15}),
    ]

    data, _ = read_fits(fits_path)
    output_dir = Path("/tmp/stretch_comparison")
    output_dir.mkdir(exist_ok=True)

    results = []
    for label, algo, kwargs in configs:
        print(f"\n{'─'*60}")
        print(f"Stretch: {label}")
        stretched = stretch(data, algorithm=algo, **kwargs)
        analyze_image(stretched, label)

        # Save individual result
        img_8bit = (stretched * 255).clip(0, 255).astype(np.uint8)
        pil = Image.fromarray(img_8bit, mode="RGB" if img_8bit.ndim == 3 else "L")

        safe_name = label.replace(" ", "_").replace("%", "pct").replace("σ", "s")
        out_path = output_dir / f"{safe_name}.jpg"
        pil.save(out_path, quality=95)
        print(f"  Saved: {out_path}")

        results.append((label, pil))

        # Compare to reference
        if ref is not None:
            stretched_resized = np.array(pil.resize((ref.shape[1], ref.shape[0]))).astype(np.float64)
            diff = np.abs(stretched_resized - ref)
            print(f"  vs Reference: mean_diff={diff.mean():.1f}/255, "
                  f"brightness_ratio={stretched_resized.mean() / max(ref.mean(), 0.01):.2f}")

    # Create comparison grid
    print(f"\n{'='*60}")
    print("Creating comparison grid...")

    thumb_w, thumb_h = 640, 427
    cols = 3
    rows = (len(results) + (1 if ref is not None else 0) + cols - 1) // cols

    grid = Image.new("RGB", (cols * thumb_w, rows * thumb_h), (30, 30, 30))
    draw = ImageDraw.Draw(grid)

    all_images = []
    if ref is not None:
        ref_pil = Image.fromarray(ref.clip(0, 255).astype(np.uint8))
        all_images.append(("Reference (ASI Air)", ref_pil))
    all_images.extend(results)

    for idx, (label, img) in enumerate(all_images):
        row, col = divmod(idx, cols)
        x, y = col * thumb_w, row * thumb_h
        thumb = img.resize((thumb_w, thumb_h), Image.Resampling.LANCZOS)
        grid.paste(thumb, (x, y))
        # Draw label
        draw.rectangle((x, y, x + thumb_w, y + 20), fill=(0, 0, 0, 180))
        draw.text((x + 5, y + 3), label, fill=(255, 255, 255))

    grid_path = output_dir / "comparison_grid.jpg"
    grid.save(grid_path, quality=95)
    print(f"Comparison grid: {grid_path}")
    print(f"\nAll outputs in: {output_dir}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: compare_stretch.py <fits_path> [reference_jpg]")
        sys.exit(1)

    fits_path = sys.argv[1]
    ref_path = sys.argv[2] if len(sys.argv) > 2 else None

    # Auto-find reference: look for _thn.jpg or _preview.jpg
    if ref_path is None:
        for suffix in ["_thn.jpg", "_preview.jpg"]:
            candidate = fits_path.replace(".fit", suffix)
            if Path(candidate).exists():
                ref_path = candidate
                print(f"Auto-found reference: {ref_path}")
                break

    stretch_and_compare(fits_path, ref_path)
