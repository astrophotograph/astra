"""Astra Astronomy Utilities.

This module provides astronomy-related utilities for the Astra observation log,
including SIMBAD object lookups, altitude calculations, plate solving, and
image processing.
"""

from astra_astro.altitude import (
    AltitudePoint,
    ObserverLocation,
    calculate_altitude,
    calculate_altitude_data,
)
from astra_astro.catalog_query import (
    CatalogObject,
    query_objects_in_fov,
)
from astra_astro.image_process import (
    ProcessingParams,
    ProcessingResult,
    process_image,
    process_image_from_dict,
)
from astra_astro.plate_solve import (
    PlateSolveResult,
    SolverType,
    solve_image,
)
from astra_astro.simbad import SimbadResult, lookup_object
from astra_astro.skymap import (
    generate_skymap,
    generate_wide_skymap,
)
from astra_astro.target_classify import (
    TargetInfo,
    TargetType,
    classify_from_name,
    classify_target,
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
    # Target classification
    "classify_target",
    "classify_from_name",
    "TargetType",
    "TargetInfo",
    # Image processing
    "process_image",
    "process_image_from_dict",
    "ProcessingParams",
    "ProcessingResult",
]

__version__ = "0.1.0"
