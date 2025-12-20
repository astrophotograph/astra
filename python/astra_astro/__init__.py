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

__all__ = [
    "lookup_object",
    "SimbadResult",
    "calculate_altitude",
    "calculate_altitude_data",
    "AltitudePoint",
    "ObserverLocation",
]

__version__ = "0.1.0"
