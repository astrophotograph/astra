"""
Skymap generation using starplot library.

Generates visualizations showing the position of an image on the sky.
"""

import base64
import io
from typing import Optional

try:
    from starplot import MapPlot
    from starplot.projections import Stereographic, Mollweide
    from starplot.styles import PlotStyle, PolygonStyle, LabelStyle, extensions
    from starplot.data.stars import _ as star_
    from starplot.data.dsos import _ as dso_

    STARPLOT_AVAILABLE = True
except ImportError:
    STARPLOT_AVAILABLE = False


def _get_dso_label(dso) -> str:
    """
    Generate a label for a DSO, preferring Messier, then NGC, then IC.
    """
    if dso.m:
        return f"M{dso.m}"
    if dso.ngc:
        return f"NGC {dso.ngc}"
    if dso.ic:
        return f"IC {dso.ic}"
    return ""


def generate_skymap(
    center_ra: float,
    center_dec: float,
    fov_width: Optional[float] = None,
    fov_height: Optional[float] = None,
    image_width: float = 0.0,
    image_height: float = 0.0,
    width_px: int = 600,  # Reduced for faster generation
    height_px: int = 450,
) -> dict:
    """
    Generate a skymap showing the location of an image on the celestial sphere.

    Args:
        center_ra: Right Ascension of image center in degrees (0-360)
        center_dec: Declination of image center in degrees (-90 to +90)
        fov_width: Field of view width in degrees for the map (auto-calculated if not provided)
        fov_height: Field of view height in degrees (defaults to fov_width * 0.75)
        image_width: Width of the image FOV in degrees (for overlay rectangle)
        image_height: Height of the image FOV in degrees (for overlay rectangle)
        width_px: Output image width in pixels
        height_px: Output image height in pixels

    Returns:
        dict with:
            - success: bool
            - image: base64-encoded PNG image (if success)
            - error: error message (if not success)
    """
    if not STARPLOT_AVAILABLE:
        return {
            "success": False,
            "error": "starplot library is not available. Install with: pip install starplot",
        }

    # Auto-calculate FOV to be ~5x the image rectangle size
    if fov_width is None:
        if image_width > 0:
            fov_width = image_width * 5.0  # 5x for good context
        else:
            fov_width = 10.0  # Fallback default

    if fov_height is None:
        if image_height > 0:
            fov_height = image_height * 5.0
        else:
            fov_height = fov_width * 0.75

    try:
        # Use dark style for astronomy
        style = PlotStyle().extend(extensions.GRAYSCALE_DARK)

        # Calculate RA bounds (handle wrap-around at 0/360)
        ra_min = center_ra - fov_width / 2
        ra_max = center_ra + fov_width / 2

        # Normalize RA to 0-360 range
        if ra_min < 0:
            ra_min += 360
        if ra_max > 360:
            ra_max -= 360

        # Calculate Dec bounds (clamp to -90 to 90)
        dec_min = max(-90, center_dec - fov_height / 2)
        dec_max = min(90, center_dec + fov_height / 2)

        # Create Stereographic projection centered on target
        projection = Stereographic()

        # Create a map plot centered on the target
        p = MapPlot(
            projection=projection,
            ra_min=ra_min,
            ra_max=ra_max,
            dec_min=dec_min,
            dec_max=dec_max,
            style=style,
            resolution=width_px,
        )

        # Plot stars - limit to bright stars only (mag < 5) for cleaner view
        p.stars(where=[star_.magnitude < 5])

        # Plot constellations
        p.constellations()
        p.constellation_borders()

        # Plot DSOs (deep sky objects) with NGC/IC/Messier labels
        # Filter to magnitude < 12 for visibility, label only brighter objects (mag < 10)
        p.dsos(
            where=[dso_.magnitude < 12],
            where_labels=[dso_.magnitude < 10],
            label_fn=_get_dso_label,
            true_size=True,
        )

        # Plot the Milky Way
        p.milky_way()

        # If we have image dimensions, draw a rectangle showing the FOV
        if image_width > 0 and image_height > 0:
            # Create a style for the FOV rectangle
            fov_style = PolygonStyle(
                fill_color=None,
                edge_color="#14b8a6",  # Teal color
                edge_width=2,
                alpha=0.9,
            )
            p.rectangle(
                center=(center_ra, center_dec),
                height_degrees=image_height,
                width_degrees=image_width,
                style=fov_style,
            )

        # Add a marker for the image center
        p.marker(
            ra=center_ra,
            dec=center_dec,
            style={
                "marker": {"symbol": "circle", "size": 12, "color": "#14b8a6", "alpha": 0.9},
            },
            label="Image Center",
        )

        # Export to bytes
        buffer = io.BytesIO()
        p.export(buffer, format="png", padding=0.1)
        buffer.seek(0)

        # Encode as base64
        img_base64 = base64.b64encode(buffer.getvalue()).decode("utf-8")

        return {
            "success": True,
            "image": f"data:image/png;base64,{img_base64}",
        }

    except Exception as e:
        return {
            "success": False,
            "error": str(e),
        }


def generate_wide_skymap(
    center_ra: float,
    center_dec: float,
    width_px: int = 400,  # Lower resolution for full-sky view (faster)
    height_px: int = 200,
) -> dict:
    """
    Generate a wide-field skymap showing the position on the entire visible sky.

    Uses Mollweide projection for full-sky view.

    Args:
        center_ra: Right Ascension of target in degrees
        center_dec: Declination of target in degrees
        width_px: Output image width in pixels
        height_px: Output image height in pixels

    Returns:
        dict with success, image (base64), or error
    """
    if not STARPLOT_AVAILABLE:
        return {
            "success": False,
            "error": "starplot library is not available",
        }

    try:
        style = PlotStyle().extend(extensions.GRAYSCALE_DARK)

        # Create a full-sky Mollweide projection
        projection = Mollweide()

        p = MapPlot(
            projection=projection,
            style=style,
            resolution=width_px,
        )

        # Plot constellations (no stars for speed)
        p.constellations()

        # Skip milky way for speed

        # Add a marker for the target location
        p.marker(
            ra=center_ra,
            dec=center_dec,
            style={
                "marker": {"symbol": "circle", "size": 15, "color": "#f97316", "alpha": 1.0},
            },
            label="Target",
        )

        # Export to bytes
        buffer = io.BytesIO()
        p.export(buffer, format="png", padding=0.05)
        buffer.seek(0)

        # Encode as base64
        img_base64 = base64.b64encode(buffer.getvalue()).decode("utf-8")

        return {
            "success": True,
            "image": f"data:image/png;base64,{img_base64}",
        }

    except Exception as e:
        return {
            "success": False,
            "error": str(e),
        }
