"""Plate solving for astronomical images.

This module provides functions to plate solve astronomical images using
various backends (nova.astrometry.net API, local solve-field, ASTAP).
"""

import time
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Optional

from astropy.wcs import WCS
from astroquery.astrometry_net import AstrometryNet


class SolverType(Enum):
    """Available plate solving backends."""

    NOVA = "nova"  # nova.astrometry.net API
    LOCAL = "local"  # Local solve-field CLI
    ASTAP = "astap"  # ASTAP solver


@dataclass
class PlateSolveResult:
    """Result from plate solving an image."""

    success: bool
    center_ra: float = 0.0  # degrees
    center_dec: float = 0.0  # degrees
    pixel_scale: float = 0.0  # arcsec/pixel
    rotation: float = 0.0  # degrees, North through East
    width_deg: float = 0.0  # image width in degrees
    height_deg: float = 0.0  # image height in degrees
    image_width: int = 0  # pixels
    image_height: int = 0  # pixels
    solver: str = ""
    solve_time: float = 0.0  # seconds
    error_message: Optional[str] = None

    def to_dict(self) -> dict:
        """Convert to dictionary for JSON serialization."""
        result = {
            "success": self.success,
            "centerRa": self.center_ra,
            "centerDec": self.center_dec,
            "pixelScale": self.pixel_scale,
            "rotation": self.rotation,
            "widthDeg": self.width_deg,
            "heightDeg": self.height_deg,
            "imageWidth": self.image_width,
            "imageHeight": self.image_height,
            "solver": self.solver,
            "solveTime": self.solve_time,
        }
        if self.error_message:
            result["errorMessage"] = self.error_message
        return result


def _extract_wcs_info(wcs: WCS, image_width: int, image_height: int) -> dict:
    """Extract plate solve information from WCS."""
    # Get center coordinates
    center_x = image_width / 2
    center_y = image_height / 2
    center_coord = wcs.pixel_to_world(center_x, center_y)

    center_ra = center_coord.ra.deg
    center_dec = center_coord.dec.deg

    # Calculate pixel scale from CD matrix or CDELT
    if hasattr(wcs.wcs, "cd") and wcs.wcs.cd is not None:
        cd = wcs.wcs.cd
        # Pixel scale is sqrt of determinant in arcsec
        pixel_scale = abs(cd[0, 0] * cd[1, 1] - cd[0, 1] * cd[1, 0]) ** 0.5 * 3600
    elif hasattr(wcs.wcs, "cdelt") and wcs.wcs.cdelt is not None:
        pixel_scale = abs(wcs.wcs.cdelt[0]) * 3600  # Convert to arcsec
    else:
        pixel_scale = 0.0

    # Calculate rotation angle
    # Rotation is typically derived from the CD matrix or CROTA2
    rotation = 0.0
    if hasattr(wcs.wcs, "cd") and wcs.wcs.cd is not None:
        import math

        cd = wcs.wcs.cd
        # Rotation angle from CD matrix
        # This assumes standard orientation (N up, E left for standard images)
        rotation = math.degrees(math.atan2(cd[0, 1], cd[0, 0]))
        # Normalize to 0-360
        rotation = rotation % 360
    elif hasattr(wcs.wcs, "crota") and wcs.wcs.crota is not None:
        rotation = wcs.wcs.crota[1] if len(wcs.wcs.crota) > 1 else 0.0

    # Calculate image dimensions in degrees
    # Get coordinates of corners
    corners = [(0, 0), (image_width, 0), (0, image_height), (image_width, image_height)]

    coords = [wcs.pixel_to_world(x, y) for x, y in corners]

    # Calculate width (RA span at center dec)
    ra_coords = [c.ra.deg for c in coords]
    dec_coords = [c.dec.deg for c in coords]

    # Handle RA wrap-around
    ra_span = max(ra_coords) - min(ra_coords)
    if ra_span > 180:
        # Crosses RA=0
        ra_coords = [r if r < 180 else r - 360 for r in ra_coords]
        ra_span = max(ra_coords) - min(ra_coords)

    # Approximate field size
    width_deg = ra_span
    height_deg = max(dec_coords) - min(dec_coords)

    return {
        "center_ra": center_ra,
        "center_dec": center_dec,
        "pixel_scale": pixel_scale,
        "rotation": rotation,
        "width_deg": width_deg,
        "height_deg": height_deg,
    }


def solve_with_nova(
    image_path: str,
    api_key: str,
    api_url: Optional[str] = None,
    scale_lower: Optional[float] = None,
    scale_upper: Optional[float] = None,
    timeout: int = 300,
) -> PlateSolveResult:
    """
    Plate solve an image using nova.astrometry.net API or a local instance.

    Args:
        image_path: Path to the image file
        api_key: Astrometry.net API key
        api_url: Custom API URL for local astrometry.net instance (optional)
        scale_lower: Lower bound of image scale (arcsec/pixel)
        scale_upper: Upper bound of image scale (arcsec/pixel)
        timeout: Maximum time to wait for solution (seconds)

    Returns:
        PlateSolveResult with solution details
    """
    start_time = time.time()

    try:
        ast = AstrometryNet()
        ast.api_key = api_key

        # Set custom API URL if provided (for local astrometry.net instance)
        if api_url:
            # Normalize URL (remove trailing slash)
            base_url = api_url.rstrip("/")
            # Set both URL attributes - API_URL needs /api suffix
            ast.URL = base_url
            if base_url.endswith("/api"):
                ast.API_URL = base_url
            else:
                ast.API_URL = f"{base_url}/api"

        # Build solve parameters
        solve_kwargs = {
            "publicly_visible": "n",
            "allow_modifications": "n",
        }

        # Add scale hints if provided
        if scale_lower is not None and scale_upper is not None:
            solve_kwargs["scale_lower"] = scale_lower
            solve_kwargs["scale_upper"] = scale_upper
            solve_kwargs["scale_units"] = "arcsecperpix"
            solve_kwargs["scale_type"] = "ul"

        # Submit the image
        try:
            wcs_header = ast.solve_from_image(image_path, solve_timeout=timeout, **solve_kwargs)
        except Exception as e:
            return PlateSolveResult(
                success=False,
                solver="nova",
                solve_time=time.time() - start_time,
                error_message=f"Solve failed: {str(e)}",
            )

        if wcs_header is None:
            return PlateSolveResult(
                success=False,
                solver="nova",
                solve_time=time.time() - start_time,
                error_message="No solution found",
            )

        # Parse the WCS solution
        wcs = WCS(wcs_header)

        # Get image dimensions from WCS header
        image_width = int(wcs_header.get("IMAGEW", wcs_header.get("NAXIS1", 0)))
        image_height = int(wcs_header.get("IMAGEH", wcs_header.get("NAXIS2", 0)))

        # If dimensions not in header, try to get from image
        if image_width == 0 or image_height == 0:
            from PIL import Image

            with Image.open(image_path) as img:
                image_width, image_height = img.size

        # Extract WCS info
        info = _extract_wcs_info(wcs, image_width, image_height)

        return PlateSolveResult(
            success=True,
            center_ra=info["center_ra"],
            center_dec=info["center_dec"],
            pixel_scale=info["pixel_scale"],
            rotation=info["rotation"],
            width_deg=info["width_deg"],
            height_deg=info["height_deg"],
            image_width=image_width,
            image_height=image_height,
            solver="nova",
            solve_time=time.time() - start_time,
        )

    except Exception as e:
        return PlateSolveResult(
            success=False,
            solver="nova",
            solve_time=time.time() - start_time,
            error_message=str(e),
        )


def solve_with_local(
    image_path: str,
    scale_lower: Optional[float] = None,
    scale_upper: Optional[float] = None,
    timeout: int = 120,
) -> PlateSolveResult:
    """
    Plate solve using local solve-field (astrometry.net local install).

    This requires astrometry.net to be installed locally with index files.

    Args:
        image_path: Path to the image file
        scale_lower: Lower bound of image scale (arcsec/pixel)
        scale_upper: Upper bound of image scale (arcsec/pixel)
        timeout: Maximum solve time (seconds)

    Returns:
        PlateSolveResult with solution details
    """
    import os
    import subprocess
    import tempfile

    start_time = time.time()

    try:
        # Check if solve-field is available
        try:
            subprocess.run(["solve-field", "--version"], capture_output=True, check=True, timeout=5)
        except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
            return PlateSolveResult(
                success=False,
                solver="local",
                solve_time=time.time() - start_time,
                error_message="solve-field not found. Please install astrometry.net locally.",
            )

        # Create temp directory for output
        with tempfile.TemporaryDirectory() as tmpdir:
            output_base = os.path.join(tmpdir, "solution")

            # Build solve-field command
            cmd = [
                "solve-field",
                "--overwrite",
                "--no-plots",
                "--cpulimit",
                str(timeout),
                "--dir",
                tmpdir,
                "--out",
                "solution",
            ]

            if scale_lower is not None and scale_upper is not None:
                cmd.extend(["--scale-low", str(scale_lower)])
                cmd.extend(["--scale-high", str(scale_upper)])
                cmd.extend(["--scale-units", "arcsecperpix"])

            cmd.append(image_path)

            # Run solve-field
            subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 30)

            # Check for WCS output file
            wcs_file = output_base + ".wcs"
            if not os.path.exists(wcs_file):
                return PlateSolveResult(
                    success=False,
                    solver="local",
                    solve_time=time.time() - start_time,
                    error_message="No solution found",
                )

            # Read WCS solution
            from astropy.io import fits

            with fits.open(wcs_file) as hdul:
                wcs_header = hdul[0].header
                wcs = WCS(wcs_header)

            # Get image dimensions
            from PIL import Image

            with Image.open(image_path) as img:
                image_width, image_height = img.size

            # Extract WCS info
            info = _extract_wcs_info(wcs, image_width, image_height)

            return PlateSolveResult(
                success=True,
                center_ra=info["center_ra"],
                center_dec=info["center_dec"],
                pixel_scale=info["pixel_scale"],
                rotation=info["rotation"],
                width_deg=info["width_deg"],
                height_deg=info["height_deg"],
                image_width=image_width,
                image_height=image_height,
                solver="local",
                solve_time=time.time() - start_time,
            )

    except subprocess.TimeoutExpired:
        return PlateSolveResult(
            success=False,
            solver="local",
            solve_time=time.time() - start_time,
            error_message="Solve timed out",
        )
    except Exception as e:
        return PlateSolveResult(
            success=False,
            solver="local",
            solve_time=time.time() - start_time,
            error_message=str(e),
        )


def solve_with_astap(
    image_path: str,
    scale_lower: Optional[float] = None,
    scale_upper: Optional[float] = None,
    timeout: int = 120,
) -> PlateSolveResult:
    """
    Plate solve using ASTAP solver.

    This requires ASTAP to be installed with star database files.

    Args:
        image_path: Path to the image file
        scale_lower: Lower bound of image scale (arcsec/pixel)
        scale_upper: Upper bound of image scale (arcsec/pixel)
        timeout: Maximum solve time (seconds)

    Returns:
        PlateSolveResult with solution details
    """
    import os
    import subprocess

    start_time = time.time()

    try:
        # Check for ASTAP executable
        astap_cmd = None
        for cmd in ["astap", "astap_cli", "/opt/astap/astap_cli"]:
            try:
                subprocess.run([cmd, "-h"], capture_output=True, timeout=5)
                astap_cmd = cmd
                break
            except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
                continue

        if astap_cmd is None:
            return PlateSolveResult(
                success=False,
                solver="astap",
                solve_time=time.time() - start_time,
                error_message="ASTAP not found. Please install ASTAP solver.",
            )

        # Build ASTAP command
        cmd = [
            astap_cmd,
            "-f",
            image_path,
            "-z",
            "1",  # Downsample factor
        ]

        if scale_lower is not None:
            cmd.extend(["-s", str(scale_lower)])

        # Run ASTAP
        subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)

        # ASTAP creates a .wcs file next to the input
        wcs_file = os.path.splitext(image_path)[0] + ".wcs"
        if not os.path.exists(wcs_file):
            return PlateSolveResult(
                success=False,
                solver="astap",
                solve_time=time.time() - start_time,
                error_message="No solution found",
            )

        try:
            # Read WCS solution
            from astropy.io import fits

            with fits.open(wcs_file) as hdul:
                wcs_header = hdul[0].header
                wcs = WCS(wcs_header)

            # Get image dimensions
            from PIL import Image

            with Image.open(image_path) as img:
                image_width, image_height = img.size

            # Extract WCS info
            info = _extract_wcs_info(wcs, image_width, image_height)

            return PlateSolveResult(
                success=True,
                center_ra=info["center_ra"],
                center_dec=info["center_dec"],
                pixel_scale=info["pixel_scale"],
                rotation=info["rotation"],
                width_deg=info["width_deg"],
                height_deg=info["height_deg"],
                image_width=image_width,
                image_height=image_height,
                solver="astap",
                solve_time=time.time() - start_time,
            )
        finally:
            # Clean up WCS file
            try:
                os.remove(wcs_file)
            except OSError:
                pass

    except subprocess.TimeoutExpired:
        return PlateSolveResult(
            success=False,
            solver="astap",
            solve_time=time.time() - start_time,
            error_message="Solve timed out",
        )
    except Exception as e:
        return PlateSolveResult(
            success=False,
            solver="astap",
            solve_time=time.time() - start_time,
            error_message=str(e),
        )


def detect_solvers() -> dict:
    """Detect which plate solving backends are available.

    Returns:
        Dictionary with solver names as keys and info dicts as values.
        Each info dict contains:
        - available: bool
        - version: str or None
        - details: str (human-readable description)
    """
    import subprocess

    solvers: dict = {}

    # Nova (astrometry.net remote) — always available if you have an API key
    solvers["nova"] = {
        "available": True,
        "version": None,
        "details": "nova.astrometry.net remote service (requires API key)",
    }

    # Local solve-field (astrometry.net CLI)
    try:
        result = subprocess.run(
            ["solve-field", "--version"], capture_output=True, text=True, timeout=5
        )
        version = result.stdout.strip().split("\n")[0] if result.stdout else None
        solvers["local"] = {
            "available": True,
            "version": version,
            "details": "astrometry.net solve-field CLI",
        }
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
        solvers["local"] = {
            "available": False,
            "version": None,
            "details": "astrometry.net solve-field not found (install astrometry.net)",
        }

    # ASTAP
    astap_found = False
    for cmd in ["astap_cli", "astap", "/opt/astap/astap_cli"]:
        try:
            result = subprocess.run([cmd, "-h"], capture_output=True, text=True, timeout=5)
            solvers["astap"] = {
                "available": True,
                "version": None,
                "details": f"ASTAP solver ({cmd})",
            }
            astap_found = True
            break
        except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
            continue
    if not astap_found:
        solvers["astap"] = {
            "available": False,
            "version": None,
            "details": "ASTAP solver not found (install from hnsky.org/astap.htm)",
        }

    # tetra3 (native Rust solver — bundled with Astra, always available)
    solvers["tetra3"] = {
        "available": True,
        "version": None,
        "details": "Built-in tetra3rs solver (requires star database file)",
    }

    return solvers


def extract_solve_hints(image_path: str) -> dict:
    """Extract plate solving hints from FITS headers.

    Reads FITS metadata to determine pixel scale, approximate coordinates,
    and other hints that speed up plate solving.

    Args:
        image_path: Path to the FITS file.

    Returns:
        Dictionary with available hints:
        - scale_arcsec: pixel scale in arcsec/pixel (if derivable)
        - scale_lower: lower bound for scale search
        - scale_upper: upper bound for scale search
        - ra_hint: approximate RA in degrees (if available)
        - dec_hint: approximate Dec in degrees (if available)
        - fov_deg: approximate FOV diagonal in degrees
        - focal_length_mm: focal length in mm (if in header)
        - pixel_size_um: pixel size in microns (if in header)
        - image_width: image width in pixels
        - image_height: image height in pixels
    """
    from astropy.io import fits as astropy_fits

    hints: dict = {}
    path = Path(image_path)

    if not path.exists():
        return hints

    try:
        with astropy_fits.open(path) as hdul:
            header = None
            image_width = 0
            image_height = 0

            for hdu in hdul:
                if hdu.data is not None and hdu.data.ndim >= 2:
                    header = hdu.header
                    if hdu.data.ndim == 3:
                        image_height, image_width = hdu.data.shape[1], hdu.data.shape[2]
                        if hdu.data.shape[0] != 3:
                            image_height, image_width = hdu.data.shape[0], hdu.data.shape[1]
                    else:
                        image_height, image_width = hdu.data.shape
                    break

            if header is None:
                return hints

            hints["image_width"] = image_width
            hints["image_height"] = image_height

            # Try to get focal length
            focal_length = None
            for key in ["FOCALLEN", "FOCAL", "FOCALLNG"]:
                if key in header:
                    try:
                        focal_length = float(header[key])
                        hints["focal_length_mm"] = focal_length
                        break
                    except (ValueError, TypeError):
                        pass

            # Try to get pixel size
            pixel_size = None
            for key in ["XPIXSZ", "PIXSIZE", "PIXSCALE", "PIXSIZE1"]:
                if key in header:
                    try:
                        pixel_size = float(header[key])
                        hints["pixel_size_um"] = pixel_size
                        break
                    except (ValueError, TypeError):
                        pass

            # Calculate pixel scale from focal length and pixel size
            if focal_length and pixel_size and focal_length > 0:
                # scale = 206.265 * pixel_size_um / focal_length_mm
                scale_arcsec = 206.265 * pixel_size / focal_length
                hints["scale_arcsec"] = scale_arcsec
                # Give 20% margin for search bounds
                hints["scale_lower"] = scale_arcsec * 0.8
                hints["scale_upper"] = scale_arcsec * 1.2
                # FOV estimate
                diag_pixels = (image_width**2 + image_height**2) ** 0.5
                hints["fov_deg"] = (scale_arcsec * diag_pixels) / 3600.0

            # Try to get approximate coordinates (from mount/goto)
            ra_hint = None
            dec_hint = None

            # RA
            for key in ["RA", "OBJCTRA", "CRVAL1"]:
                if key in header:
                    try:
                        val = header[key]
                        if isinstance(val, str):
                            # Try HMS format: "12 34 56.7" or "12:34:56.7"
                            ra_hint = _parse_ra_string(val)
                        else:
                            ra_hint = float(val)
                        break
                    except (ValueError, TypeError):
                        pass

            # Dec
            for key in ["DEC", "OBJCTDEC", "CRVAL2"]:
                if key in header:
                    try:
                        val = header[key]
                        if isinstance(val, str):
                            dec_hint = _parse_dec_string(val)
                        else:
                            dec_hint = float(val)
                        break
                    except (ValueError, TypeError):
                        pass

            if ra_hint is not None:
                hints["ra_hint"] = ra_hint
            if dec_hint is not None:
                hints["dec_hint"] = dec_hint

    except Exception:
        pass

    return hints


def _parse_ra_string(s: str) -> Optional[float]:
    """Parse RA from string formats like '12 34 56.7' or '12:34:56.7'."""
    import re

    s = s.strip()
    parts = re.split(r"[\s:hms]+", s.strip())
    parts = [p for p in parts if p]
    if len(parts) >= 3:
        try:
            h, m, sec = float(parts[0]), float(parts[1]), float(parts[2])
            return (h + m / 60.0 + sec / 3600.0) * 15.0  # Convert hours to degrees
        except ValueError:
            pass
    elif len(parts) == 1:
        try:
            return float(parts[0])
        except ValueError:
            pass
    return None


def _parse_dec_string(s: str) -> Optional[float]:
    """Parse Dec from string formats like '+41 16 09.0' or '41:16:09.0'."""
    import re

    s = s.strip()
    sign = -1 if s.startswith("-") else 1
    s = s.lstrip("+-")
    parts = re.split(r"[\s:dms°'\"]+", s.strip())
    parts = [p for p in parts if p]
    if len(parts) >= 3:
        try:
            d, m, sec = float(parts[0]), float(parts[1]), float(parts[2])
            return sign * (d + m / 60.0 + sec / 3600.0)
        except ValueError:
            pass
    elif len(parts) == 1:
        try:
            return sign * float(parts[0])
        except ValueError:
            pass
    return None


def solve_image(
    image_path: str,
    solver: str = "nova",
    api_key: Optional[str] = None,
    api_url: Optional[str] = None,
    scale_lower: Optional[float] = None,
    scale_upper: Optional[float] = None,
    timeout: int = 300,
) -> dict:
    """
    Plate solve an image using the specified solver.

    Args:
        image_path: Path to the image file
        solver: Solver to use ("nova", "local", or "astap")
        api_key: API key for nova.astrometry.net (required for nova)
        api_url: Custom API URL for local astrometry.net instance (optional)
        scale_lower: Lower bound of image scale (arcsec/pixel), optional hint
        scale_upper: Upper bound of image scale (arcsec/pixel), optional hint
        timeout: Maximum time to wait for solution (seconds)

    Returns:
        Dictionary with plate solve result
    """
    # Validate image path
    path = Path(image_path)
    if not path.exists():
        return PlateSolveResult(
            success=False,
            error_message=f"Image file not found: {image_path}",
        ).to_dict()

    # Choose solver
    solver_lower = solver.lower()

    if solver_lower == "nova":
        if not api_key:
            return PlateSolveResult(
                success=False,
                solver="nova",
                error_message="API key required for nova.astrometry.net",
            ).to_dict()
        result = solve_with_nova(image_path, api_key, api_url, scale_lower, scale_upper, timeout)
    elif solver_lower == "local":
        result = solve_with_local(image_path, scale_lower, scale_upper, timeout)
    elif solver_lower == "astap":
        result = solve_with_astap(image_path, scale_lower, scale_upper, timeout)
    else:
        return PlateSolveResult(
            success=False,
            error_message=f"Unknown solver: {solver}. Use 'nova', 'local', or 'astap'.",
        ).to_dict()

    return result.to_dict()
