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
    contrast: float = 1.3  # 1.0=none, 1.3=Seestar-like, 1.5=moderate, 2.0=strong

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
            "contrast": self.contrast,
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

    Given current median x and target median t, find m such that
    MTF(m, x) = t.

    Derivation from MTF(m, x) = (m - 1) * x / ((2m - 1) * x - m) = t:
    m = x * (t - 1) / (2 * t * x - t - x)
    """
    if median <= 0 or median >= 1:
        return 0.5

    x, t = median, target
    denominator = 2 * t * x - t - x

    if abs(denominator) < 1e-10:
        return 0.5

    m = x * (t - 1) / denominator
    return np.clip(m, 0.0001, 0.9999)


def _statistical_stretch(data: np.ndarray, target_median: float = 0.15) -> np.ndarray:
    """
    Apply statistical stretch to image data.

    Uses percentile-based stretching with gamma correction and contrast
    enhancement, optimized for astrophotography images.

    Args:
        data: Image data (can be raw or normalized)
        target_median: Target median value after stretch (0.1-0.2 typical)

    Returns:
        Stretched image data (0-1 range)
    """
    logger.debug(
        f"Statistical stretch: input median={np.median(data):.6f}, "
        f"min={np.min(data):.6f}, max={np.max(data):.6f}"
    )

    # Use percentile-based clipping to preserve dynamic range
    black_point = np.percentile(data, 0.5)  # Clip shadows at 0.5th percentile
    white_point = np.percentile(data, 99.9)  # Clip highlights at 99.9th percentile

    logger.debug(f"Percentile clip: black={black_point:.4f}, white={white_point:.4f}")

    # Handle edge case of flat image
    if white_point <= black_point:
        logger.warning("Flat image detected, returning as-is")
        return np.clip(data, 0, 1) if np.max(data) <= 1 else data / np.max(data)

    # Stretch to 0-1 range using percentile clipping
    stretched = (data - black_point) / (white_point - black_point)
    stretched = np.clip(stretched, 0, 1)

    current_median = np.median(stretched)
    logger.debug(f"After percentile stretch: median={current_median:.4f}")

    # Apply gamma correction to achieve target median
    # If stretched median^gamma = target_median, then:
    # gamma = log(target_median) / log(current_median)
    if 0.001 < current_median < 0.999:
        gamma = np.log(target_median) / np.log(current_median)
        # Clamp gamma to reasonable range (0.2 to 2.0)
        gamma = np.clip(gamma, 0.2, 2.0)
        logger.debug(f"Applying gamma={gamma:.3f}")
        stretched = np.power(stretched, gamma)
    else:
        logger.debug("Skipping gamma (median at extreme)")

    logger.debug(f"Final median={np.median(stretched):.4f}, std={np.std(stretched):.4f}")
    return stretched


def _apply_contrast_curve(data: np.ndarray, strength: float = 1.5) -> np.ndarray:
    """
    Apply contrast enhancement by scaling around the mean.

    This preserves the overall brightness (mean) while increasing
    the spread (standard deviation) of values.

    Args:
        data: Image data (0-1 range)
        strength: Contrast strength (1.0 = no change, 1.5 = 50% more contrast)

    Returns:
        Contrast-enhanced data (0-1 range)
    """
    if strength <= 1.0:
        return data

    # Scale around the mean to increase contrast
    # new_data = mean + (data - mean) * strength
    mean = np.mean(data)
    logger.debug(f"Contrast adjustment: mean={mean:.4f}, strength={strength}")

    result = mean + (data - mean) * strength

    return np.clip(result, 0, 1)


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
            background[:, :, i] = ndimage.median_filter(data[:, :, i], size=int(sigma * 2))
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
    Load FITS file and return data and header.

    Args:
        fits_path: Path to FITS file

    Returns:
        Tuple of (image data as float64, header dict)
        Note: Data is NOT normalized - stretching functions handle normalization
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

    # Don't normalize here - let the stretching functions handle it
    # This preserves the original dynamic range for better processing

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
    # Exclude keywords that define data format - these are set by astropy based on actual data
    EXCLUDED_KEYS = {
        "SIMPLE",
        "BITPIX",
        "NAXIS",
        "NAXIS1",
        "NAXIS2",
        "NAXIS3",
        "EXTEND",
        "BZERO",
        "BSCALE",  # These would corrupt float data interpretation
        "BLANK",  # Only valid for integer data
    }
    if header:
        for key, value in header.items():
            if key not in EXCLUDED_KEYS:
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
    progress_callback: Optional[callable] = None,
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
        progress_callback: Optional callback function(step: str, progress: float, message: str)

    Returns:
        ProcessingResult with status and output paths
    """
    start_time = time.time()

    def report_progress(step: str, progress: float, message: str = ""):
        """Report progress if callback is provided."""
        if progress_callback:
            try:
                progress_callback(step, progress, message)
            except Exception as e:
                logger.warning(f"Progress callback failed: {e}")

    # Default parameters
    if params is None:
        params = ProcessingParams()

    try:
        report_progress("init", 0.0, "Initializing processing")

        # Create output directory
        os.makedirs(output_dir, exist_ok=True)

        # Generate output paths with timestamp to avoid overwriting
        base_name = Path(input_fits_path).stem
        timestamp = time.strftime("%Y%m%d_%H%M%S")
        output_fits_path = os.path.join(output_dir, f"{base_name}_processed_{timestamp}.fits")
        output_preview_path = os.path.join(output_dir, f"{base_name}_preview_{timestamp}.png")

        # Load FITS
        report_progress("loading", 0.05, "Loading FITS file")
        logger.info(f"Loading FITS: {input_fits_path}")
        data, header = _load_fits(input_fits_path)
        logger.info(f"Loaded image shape: {data.shape}")
        report_progress("loading", 0.15, f"Loaded image ({data.shape[1]}x{data.shape[0]})")

        # Determine target type
        report_progress("classifying", 0.18, "Classifying target type")
        target_type = TargetType.UNKNOWN
        if params.target_type == "auto" and object_name:
            target_info = classify_from_name(object_name)
            target_type = target_info.target_type
            logger.info(f"Auto-classified {object_name} as {target_type.value}")
            report_progress("classifying", 0.20, f"Classified as {target_type.value}")
        elif params.target_type != "auto":
            try:
                target_type = TargetType(params.target_type)
            except ValueError:
                target_type = TargetType.UNKNOWN
            report_progress("classifying", 0.20, f"Using target type: {target_type.value}")

        # Get target-specific parameters
        target_params = TARGET_PARAMS.get(target_type, TARGET_PARAMS[TargetType.UNKNOWN])

        # Merge with user params
        if params.stretch_factor > 0:
            stretch_factor = params.stretch_factor
        else:
            stretch_factor = target_params["stretch_factor"]
        background_removal = params.background_removal
        star_reduction = params.star_reduction or target_params.get("star_reduction", False)

        logger.info(
            f"Processing with: stretch={stretch_factor}, "
            f"bg_removal={background_removal}, star_reduction={star_reduction}"
        )

        # Process pipeline
        processed = data.copy()

        # 1. Background removal
        if background_removal:
            report_progress("background", 0.25, "Removing background gradient")
            logger.info("Removing background gradient")
            processed = _remove_background(processed)
            report_progress("background", 0.40, "Background gradient removed")
        else:
            report_progress("background", 0.40, "Skipping background removal")

        # 2. Color calibration (RGB only)
        if params.color_calibration and len(processed.shape) == 3:
            report_progress("calibration", 0.42, "Applying color calibration")
            logger.info("Applying color calibration")
            processed = _color_calibrate(processed)
            report_progress("calibration", 0.50, "Color calibration complete")
        else:
            report_progress("calibration", 0.50, "Skipping color calibration")

        # 3. Apply stretch
        stretch_name = params.stretch_method.replace("_", " ").title()
        report_progress("stretch", 0.52, f"Applying {stretch_name} stretch")
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
        report_progress("stretch", 0.70, f"{stretch_name} stretch complete")

        # 3b. Apply contrast adjustment if requested
        if params.contrast > 1.0:
            report_progress("contrast", 0.72, f"Applying contrast ({params.contrast:.1f})")
            logger.info(f"Applying contrast: {params.contrast}")
            processed = _apply_contrast_curve(processed, params.contrast)
            report_progress("contrast", 0.74, "Contrast adjustment complete")

        # 4. Star reduction (optional)
        if star_reduction:
            report_progress("stars", 0.72, "Reducing star brightness")
            logger.info("Reducing star brightness")
            processed = _reduce_stars(processed)
            report_progress("stars", 0.80, "Star reduction complete")
        else:
            report_progress("stars", 0.80, "Skipping star reduction")

        # 5. Noise reduction (optional)
        if params.noise_reduction > 0:
            nr_pct = int(params.noise_reduction * 100)
            report_progress("noise", 0.82, f"Applying noise reduction ({nr_pct}%)")
            logger.info(f"Applying noise reduction: {params.noise_reduction}")
            processed = _apply_noise_reduction(processed, params.noise_reduction)
            report_progress("noise", 0.88, "Noise reduction complete")
        else:
            report_progress("noise", 0.88, "Skipping noise reduction")

        # Ensure output is in valid range
        processed = np.clip(processed, 0, 1)

        # Save outputs
        report_progress("saving", 0.90, "Saving processed FITS")
        logger.info(f"Saving processed FITS: {output_fits_path}")
        _save_fits(processed, output_fits_path, header)

        report_progress("saving", 0.95, "Generating preview image")
        logger.info(f"Saving preview PNG: {output_preview_path}")
        _save_preview(processed, output_preview_path)

        report_progress("complete", 1.0, "Processing complete")
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
    progress_callback: Optional[callable] = None,
) -> dict:
    """
    Process image with parameters from dictionary.

    This is the main entry point called from Rust via PyO3.

    Args:
        input_fits_path: Path to input FITS file
        output_dir: Directory for output files
        params_dict: Processing parameters as dictionary
        object_name: Object name for auto-classification
        progress_callback: Optional callback function(step: str, progress: float, message: str)

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
        if "contrast" in params_dict:
            params.contrast = float(params_dict["contrast"])

    result = process_image(input_fits_path, output_dir, params, object_name, progress_callback)
    return result.to_dict()
