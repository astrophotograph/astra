"""Image processing for astrophotography.

This module provides image processing algorithms for astrophotography,
including stretching, background removal, and color calibration.

The core stretching algorithm uses the Midtones Transfer Function (MTF):
MTF(m, x) = (m - 1) * x / ((2m - 1) * x - m)

where m is the midtones balance parameter (0 < m < 1) and x is the input value.
"""

import logging
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np
from astropy.io import fits
from PIL import Image
from scipy import ndimage

from astra_astro.target_classify import TargetType, classify_from_name

logger = logging.getLogger(__name__)


@dataclass
class ProcessingParams:
    """Parameters for image processing."""

    target_type: str = "auto"  # "auto" or specific type from TargetType enum
    stretch_method: str = "statistical"  # "statistical", "arcsinh", "log"
    stretch_factor: float = 0.15  # Target median for stretch (0.05-0.30)
    background_removal: bool = True
    star_reduction: bool = False  # Reduce star brightness for nebulae
    color_calibration: bool = True
    noise_reduction: float = 0.0  # 0-1 strength

    def to_dict(self) -> dict:
        """Convert to dictionary for JSON serialization."""
        return {
            "targetType": self.target_type,
            "stretchMethod": self.stretch_method,
            "stretchFactor": self.stretch_factor,
            "backgroundRemoval": self.background_removal,
            "starReduction": self.star_reduction,
            "colorCalibration": self.color_calibration,
            "noiseReduction": self.noise_reduction,
        }


@dataclass
class ProcessingResult:
    """Result of image processing."""

    success: bool
    output_fits_path: str = ""
    output_preview_path: str = ""
    target_type: str = ""
    processing_params: dict = field(default_factory=dict)
    processing_time: float = 0.0
    error_message: Optional[str] = None

    def to_dict(self) -> dict:
        """Convert to dictionary for JSON serialization."""
        return {
            "success": self.success,
            "outputFitsPath": self.output_fits_path,
            "outputPreviewPath": self.output_preview_path,
            "targetType": self.target_type,
            "processingParams": self.processing_params,
            "processingTime": self.processing_time,
            "errorMessage": self.error_message,
        }


# Target-specific processing parameters
TARGET_PARAMS = {
    TargetType.EMISSION_NEBULA: {
        "stretch_factor": 0.18,
        "background_removal": True,
        "star_reduction": True,
        "saturation_boost": 1.2,
    },
    TargetType.REFLECTION_NEBULA: {
        "stretch_factor": 0.15,
        "background_removal": True,
        "star_reduction": False,  # Preserve blue tones around stars
        "saturation_boost": 1.1,
    },
    TargetType.PLANETARY_NEBULA: {
        "stretch_factor": 0.20,
        "background_removal": True,
        "star_reduction": False,  # Small targets
        "saturation_boost": 1.15,
    },
    TargetType.GALAXY: {
        "stretch_factor": 0.12,
        "background_removal": True,
        "star_reduction": False,  # Preserve galaxy structure
        "saturation_boost": 1.0,
    },
    TargetType.GLOBULAR_CLUSTER: {
        "stretch_factor": 0.10,
        "background_removal": True,
        "star_reduction": False,  # Stars are the subject
        "saturation_boost": 1.0,
    },
    TargetType.OPEN_CLUSTER: {
        "stretch_factor": 0.08,
        "background_removal": True,
        "star_reduction": False,  # Stars are the subject
        "saturation_boost": 1.0,
    },
    TargetType.STAR_FIELD: {
        "stretch_factor": 0.05,
        "background_removal": False,
        "star_reduction": False,
        "saturation_boost": 1.0,
    },
    TargetType.UNKNOWN: {
        "stretch_factor": 0.15,
        "background_removal": True,
        "star_reduction": False,
        "saturation_boost": 1.0,
    },
}


def _mtf(m: float, x: np.ndarray) -> np.ndarray:
    """
    Apply Midtones Transfer Function.

    MTF(m, x) = (m - 1) * x / ((2m - 1) * x - m)

    Args:
        m: Midtones balance parameter (0 < m < 1)
        x: Input values (normalized 0-1)

    Returns:
        Stretched values
    """
    # Ensure m is in valid range
    m = np.clip(m, 0.0001, 0.9999)

    # Avoid division by zero
    denominator = (2 * m - 1) * x - m
    denominator = np.where(np.abs(denominator) < 1e-10, 1e-10, denominator)

    result = (m - 1) * x / denominator
    return np.clip(result, 0, 1)


def _calculate_mtf_balance(median: float, target: float) -> float:
    """
    Calculate MTF balance parameter to achieve target median.

    Given current median and target median, find m such that
    MTF(m, median) = target.

    Solving for m:
    m = (target * (2 * median - 1) - median) / ((target - 1) * (2 * median - 1) - 1)
    """
    if median <= 0 or median >= 1:
        return 0.5

    # Simplified formula
    numerator = target * (2 * median - 1) - median
    denominator = (target - 1) * (2 * median - 1) - 1

    if abs(denominator) < 1e-10:
        return 0.5

    m = numerator / denominator
    return np.clip(m, 0.0001, 0.9999)


def _statistical_stretch(
    data: np.ndarray, target_median: float = 0.15
) -> np.ndarray:
    """
    Apply statistical stretch to image data.

    This stretch normalizes data based on median and MAD (median absolute deviation)
    to clip black point, then applies MTF to achieve target median.

    Args:
        data: Image data (normalized 0-1)
        target_median: Target median value after stretch

    Returns:
        Stretched image data
    """
    # Calculate statistics
    median = np.median(data)
    mad = np.median(np.abs(data - median))

    if mad < 1e-10:
        # Flat image, just normalize
        return data

    # Calculate shadows clipping point (2.8 sigma below median)
    shadows = median - 2.8 * mad * 1.4826  # 1.4826 converts MAD to sigma

    # Normalize: clip shadows and scale to 0-1
    normalized = (data - shadows) / (1.0 - shadows)
    normalized = np.clip(normalized, 0, 1)

    # Calculate current median after normalization
    new_median = np.median(normalized)

    if new_median <= 0 or new_median >= 1:
        return normalized

    # Calculate MTF balance to achieve target median
    m = _calculate_mtf_balance(new_median, target_median)

    # Apply MTF stretch
    return _mtf(m, normalized)


def _arcsinh_stretch(data: np.ndarray, factor: float = 0.15) -> np.ndarray:
    """
    Apply arcsinh stretch.

    Arcsinh is similar to log but handles negative values and
    preserves color ratios better.

    Args:
        data: Image data (normalized 0-1)
        factor: Stretch factor (lower = more aggressive)

    Returns:
        Stretched image data
    """
    if factor <= 0:
        factor = 0.15

    scale = 1.0 / factor
    stretched = np.arcsinh(data * scale) / np.arcsinh(scale)
    return np.clip(stretched, 0, 1)


def _log_stretch(data: np.ndarray, factor: float = 0.15) -> np.ndarray:
    """
    Apply logarithmic stretch.

    Args:
        data: Image data (normalized 0-1)
        factor: Stretch factor (affects black point)

    Returns:
        Stretched image data
    """
    # Avoid log(0)
    offset = factor * 0.01
    stretched = np.log1p(data / offset) / np.log1p(1.0 / offset)
    return np.clip(stretched, 0, 1)


def _remove_background(data: np.ndarray, sigma: float = 50.0) -> np.ndarray:
    """
    Remove background gradient using large-scale median filtering.

    Args:
        data: Image data
        sigma: Size of the background estimation filter

    Returns:
        Background-subtracted image
    """
    # Estimate background using large median filter
    # For multi-channel, process each channel separately
    if len(data.shape) == 3:
        background = np.zeros_like(data)
        for i in range(data.shape[2]):
            background[:, :, i] = ndimage.median_filter(
                data[:, :, i], size=int(sigma * 2)
            )
    else:
        background = ndimage.median_filter(data, size=int(sigma * 2))

    # Subtract background but keep minimum at 0
    result = data - background
    result = result - np.min(result)

    # Normalize
    max_val = np.max(result)
    if max_val > 0:
        result = result / max_val

    return result


def _color_calibrate(data: np.ndarray) -> np.ndarray:
    """
    Apply simple color calibration (background neutralization).

    This adjusts each channel to have similar background levels.

    Args:
        data: RGB image data (H, W, 3)

    Returns:
        Color-calibrated image
    """
    if len(data.shape) != 3 or data.shape[2] != 3:
        return data

    # Sample background from corners
    h, w = data.shape[:2]
    corner_size = max(10, min(h, w) // 20)

    # Get corner samples
    corners = [
        data[:corner_size, :corner_size],
        data[:corner_size, -corner_size:],
        data[-corner_size:, :corner_size],
        data[-corner_size:, -corner_size:],
    ]

    # Calculate median for each channel across corners
    corner_data = np.concatenate([c.reshape(-1, 3) for c in corners], axis=0)
    bg_medians = np.median(corner_data, axis=0)

    # Neutralize: scale channels so backgrounds are equal
    target_bg = np.mean(bg_medians)

    if target_bg > 0:
        result = data.copy()
        for i in range(3):
            if bg_medians[i] > 0:
                scale = target_bg / bg_medians[i]
                result[:, :, i] = np.clip(data[:, :, i] * scale, 0, 1)
        return result

    return data


def _apply_noise_reduction(data: np.ndarray, strength: float = 0.5) -> np.ndarray:
    """
    Apply light noise reduction using Gaussian blur.

    Args:
        data: Image data
        strength: Reduction strength (0-1)

    Returns:
        Noise-reduced image
    """
    if strength <= 0:
        return data

    sigma = strength * 1.5  # Max sigma of 1.5 pixels

    if len(data.shape) == 3:
        result = np.zeros_like(data)
        for i in range(data.shape[2]):
            result[:, :, i] = ndimage.gaussian_filter(data[:, :, i], sigma=sigma)
    else:
        result = ndimage.gaussian_filter(data, sigma=sigma)

    return result


def _reduce_stars(data: np.ndarray, threshold: float = 0.8) -> np.ndarray:
    """
    Reduce star brightness to emphasize nebulosity.

    This uses a simple approach: identify bright peaks and reduce their intensity
    while preserving surrounding structures.

    Args:
        data: Image data
        threshold: Brightness threshold for star detection (0-1)

    Returns:
        Star-reduced image
    """
    # Create star mask using local maxima detection
    if len(data.shape) == 3:
        # Use luminance for detection
        luminance = 0.299 * data[:, :, 0] + 0.587 * data[:, :, 1] + 0.114 * data[:, :, 2]
    else:
        luminance = data

    # Find local maxima
    local_max = ndimage.maximum_filter(luminance, size=5)
    peaks = (luminance == local_max) & (luminance > threshold)

    # Dilate peaks to create star regions
    star_mask = ndimage.binary_dilation(peaks, iterations=3)

    # Create reduction map
    reduction = np.ones_like(luminance)
    reduction[star_mask] = 0.7  # Reduce stars to 70% brightness

    # Smooth the reduction map
    reduction = ndimage.gaussian_filter(reduction, sigma=2)

    # Apply reduction
    if len(data.shape) == 3:
        result = data * reduction[:, :, np.newaxis]
    else:
        result = data * reduction

    return np.clip(result, 0, 1)


def _load_fits(fits_path: str) -> tuple[np.ndarray, dict]:
    """
    Load FITS file and return normalized data and header.

    Args:
        fits_path: Path to FITS file

    Returns:
        Tuple of (image data normalized to 0-1, header dict)
    """
    with fits.open(fits_path) as hdul:
        data = hdul[0].data.astype(np.float64)
        header = dict(hdul[0].header)

    # Handle different data shapes
    # FITS can be (H, W), (C, H, W), or (H, W, C)
    if len(data.shape) == 3:
        # Check if channels are first or last
        if data.shape[0] in (1, 3, 4):
            # (C, H, W) -> (H, W, C)
            data = np.moveaxis(data, 0, -1)
        if data.shape[2] == 1:
            # Single channel, squeeze
            data = data[:, :, 0]

    # Normalize to 0-1
    data_min = np.min(data)
    data_max = np.max(data)

    if data_max > data_min:
        data = (data - data_min) / (data_max - data_min)
    else:
        data = np.zeros_like(data)

    return data, header


def _save_fits(data: np.ndarray, output_path: str, header: Optional[dict] = None) -> None:
    """
    Save processed data as FITS file.

    Args:
        data: Image data (0-1 normalized)
        output_path: Output path
        header: Optional FITS header to include
    """
    # Convert back to 32-bit float for FITS
    output_data = data.astype(np.float32)

    # If RGB, move channels to first axis for FITS convention
    if len(output_data.shape) == 3:
        output_data = np.moveaxis(output_data, -1, 0)

    # Create HDU
    hdu = fits.PrimaryHDU(output_data)

    # Add header info
    if header:
        for key, value in header.items():
            if key not in ("SIMPLE", "BITPIX", "NAXIS", "NAXIS1", "NAXIS2", "NAXIS3", "EXTEND"):
                try:
                    hdu.header[key] = value
                except (ValueError, TypeError):
                    pass  # Skip invalid header values

    # Add processing marker
    hdu.header["ASTRA_PR"] = "processed"
    hdu.header["HISTORY"] = "Processed by Astra image_process.py"

    # Write file
    hdu.writeto(output_path, overwrite=True)


def _save_preview(data: np.ndarray, output_path: str) -> None:
    """
    Save preview as PNG.

    Args:
        data: Image data (0-1 normalized)
        output_path: Output path
    """
    # Convert to 8-bit
    img_data = (data * 255).astype(np.uint8)

    # Create PIL image
    if len(img_data.shape) == 2:
        # Grayscale
        img = Image.fromarray(img_data, mode="L")
    else:
        # RGB
        img = Image.fromarray(img_data, mode="RGB")

    # Save
    img.save(output_path, "PNG")


def process_image(
    input_fits_path: str,
    output_dir: str,
    params: Optional[ProcessingParams] = None,
    object_name: Optional[str] = None,
) -> ProcessingResult:
    """
    Process a FITS image with stretch and enhancements.

    Pipeline:
    1. Load FITS data (32-bit float)
    2. Detect target type if auto
    3. Remove background gradient (if enabled)
    4. Apply color calibration (if enabled)
    5. Apply stretch algorithm
    6. Optional: star reduction for nebulae
    7. Optional: noise reduction
    8. Save processed FITS
    9. Generate PNG preview

    Args:
        input_fits_path: Path to input FITS file
        output_dir: Directory for output files
        params: Processing parameters (uses defaults if None)
        object_name: Object name for auto-classification

    Returns:
        ProcessingResult with status and output paths
    """
    start_time = time.time()

    # Default parameters
    if params is None:
        params = ProcessingParams()

    try:
        # Create output directory
        os.makedirs(output_dir, exist_ok=True)

        # Generate output paths
        base_name = Path(input_fits_path).stem
        output_fits_path = os.path.join(output_dir, f"{base_name}_processed.fits")
        output_preview_path = os.path.join(output_dir, f"{base_name}_preview.png")

        # Load FITS
        logger.info(f"Loading FITS: {input_fits_path}")
        data, header = _load_fits(input_fits_path)
        logger.info(f"Loaded image shape: {data.shape}")

        # Determine target type
        target_type = TargetType.UNKNOWN
        if params.target_type == "auto" and object_name:
            target_info = classify_from_name(object_name)
            target_type = target_info.target_type
            logger.info(f"Auto-classified {object_name} as {target_type.value}")
        elif params.target_type != "auto":
            try:
                target_type = TargetType(params.target_type)
            except ValueError:
                target_type = TargetType.UNKNOWN

        # Get target-specific parameters
        target_params = TARGET_PARAMS.get(target_type, TARGET_PARAMS[TargetType.UNKNOWN])

        # Merge with user params
        stretch_factor = params.stretch_factor if params.stretch_factor > 0 else target_params["stretch_factor"]
        background_removal = params.background_removal
        star_reduction = params.star_reduction or target_params.get("star_reduction", False)

        logger.info(f"Processing with: stretch={stretch_factor}, bg_removal={background_removal}, star_reduction={star_reduction}")

        # Process pipeline
        processed = data.copy()

        # 1. Background removal
        if background_removal:
            logger.info("Removing background gradient")
            processed = _remove_background(processed)

        # 2. Color calibration (RGB only)
        if params.color_calibration and len(processed.shape) == 3:
            logger.info("Applying color calibration")
            processed = _color_calibrate(processed)

        # 3. Apply stretch
        logger.info(f"Applying {params.stretch_method} stretch")
        if params.stretch_method == "statistical":
            processed = _statistical_stretch(processed, stretch_factor)
        elif params.stretch_method == "arcsinh":
            processed = _arcsinh_stretch(processed, stretch_factor)
        elif params.stretch_method == "log":
            processed = _log_stretch(processed, stretch_factor)
        else:
            # Default to statistical
            processed = _statistical_stretch(processed, stretch_factor)

        # 4. Star reduction (optional)
        if star_reduction:
            logger.info("Reducing star brightness")
            processed = _reduce_stars(processed)

        # 5. Noise reduction (optional)
        if params.noise_reduction > 0:
            logger.info(f"Applying noise reduction: {params.noise_reduction}")
            processed = _apply_noise_reduction(processed, params.noise_reduction)

        # Ensure output is in valid range
        processed = np.clip(processed, 0, 1)

        # Save outputs
        logger.info(f"Saving processed FITS: {output_fits_path}")
        _save_fits(processed, output_fits_path, header)

        logger.info(f"Saving preview PNG: {output_preview_path}")
        _save_preview(processed, output_preview_path)

        processing_time = time.time() - start_time
        logger.info(f"Processing completed in {processing_time:.2f}s")

        return ProcessingResult(
            success=True,
            output_fits_path=output_fits_path,
            output_preview_path=output_preview_path,
            target_type=target_type.value,
            processing_params=params.to_dict(),
            processing_time=processing_time,
        )

    except Exception as e:
        logger.exception(f"Processing failed: {e}")
        return ProcessingResult(
            success=False,
            error_message=str(e),
            processing_time=time.time() - start_time,
        )


def process_image_from_dict(
    input_fits_path: str,
    output_dir: str,
    params_dict: Optional[dict] = None,
    object_name: Optional[str] = None,
) -> dict:
    """
    Process image with parameters from dictionary.

    This is the main entry point called from Rust via PyO3.

    Args:
        input_fits_path: Path to input FITS file
        output_dir: Directory for output files
        params_dict: Processing parameters as dictionary
        object_name: Object name for auto-classification

    Returns:
        Dictionary with processing results
    """
    params = ProcessingParams()

    if params_dict:
        if "targetType" in params_dict:
            params.target_type = params_dict["targetType"]
        if "stretchMethod" in params_dict:
            params.stretch_method = params_dict["stretchMethod"]
        if "stretchFactor" in params_dict:
            params.stretch_factor = float(params_dict["stretchFactor"])
        if "backgroundRemoval" in params_dict:
            params.background_removal = bool(params_dict["backgroundRemoval"])
        if "starReduction" in params_dict:
            params.star_reduction = bool(params_dict["starReduction"])
        if "colorCalibration" in params_dict:
            params.color_calibration = bool(params_dict["colorCalibration"])
        if "noiseReduction" in params_dict:
            params.noise_reduction = float(params_dict["noiseReduction"])

    result = process_image(input_fits_path, output_dir, params, object_name)
    return result.to_dict()
