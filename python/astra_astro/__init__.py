"""Astra Astronomy Utilities.

This module provides astronomy-related utilities for the Astra observation log,
including SIMBAD object lookups, altitude calculations, and plate solving.
"""

from astra_astro.simbad import lookup_object, SimbadResult
from astra_astro.altitude import (
    calculate_altitude,
    calculate_altitude_data,
    AltitudePoint,
    ObserverLocation,
)
from astra_astro.plate_solve import (
    solve_image,
    PlateSolveResult,
    SolverType,
)
from astra_astro.catalog_query import (
    query_objects_in_fov,
    CatalogObject,
)
from astra_astro.skymap import (
    generate_skymap,
    generate_wide_skymap,
)

__all__ = [
    # SIMBAD
    "lookup_object",
    "SimbadResult",
    # Altitude
    "calculate_altitude",
    "calculate_altitude_data",
    "AltitudePoint",
    "ObserverLocation",
    # Plate solving
    "solve_image",
    "PlateSolveResult",
    "SolverType",
    # Catalog queries
    "query_objects_in_fov",
    "CatalogObject",
    # Skymap
    "generate_skymap",
    "generate_wide_skymap",
]

__version__ = "0.1.0"
