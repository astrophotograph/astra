"""SIMBAD astronomical object lookup.

This module provides functions to query the SIMBAD database for astronomical
object information including coordinates, magnitude, size, and identifiers.
"""

import math
import re
from dataclasses import dataclass, field
from typing import Optional

import numpy as np
from astroquery.simbad import Simbad


def _is_valid_value(val) -> bool:
    """Check if a value is valid (not None, not masked, not NaN)."""
    if val is None:
        return False
    # Check for numpy masked values
    if hasattr(val, "mask"):
        if np.ma.is_masked(val):
            return False
    # Check for NaN
    try:
        if math.isnan(float(val)):
            return False
    except (ValueError, TypeError):
        pass
    return True


def _safe_float(val, default=None) -> Optional[float]:
    """Safely convert a value to float, handling masked values and NaN."""
    if not _is_valid_value(val):
        return default
    try:
        result = float(val)
        if math.isnan(result):
            return default
        return result
    except (ValueError, TypeError):
        return default


@dataclass
class Coordinates:
    """Celestial coordinates."""

    ra: float  # Right ascension in degrees
    dec: float  # Declination in degrees
    ra_str: str  # RA as formatted string
    dec_str: str  # Dec as formatted string


@dataclass
class Size:
    """Object size information."""

    major_axis: Optional[float] = None  # arcseconds
    minor_axis: Optional[float] = None  # arcseconds
    position_angle: Optional[float] = None  # degrees
    formatted: Optional[str] = None
    type: Optional[str] = None  # "point_source" or "unknown"


@dataclass
class Distance:
    """Distance information."""

    parsecs: float
    light_years: float


@dataclass
class ProperMotion:
    """Proper motion in mas/yr."""

    ra: float
    dec: float


@dataclass
class SimbadResult:
    """Result from a SIMBAD query."""

    name: str
    object_type: str
    coordinates: Coordinates
    size: Size = field(default_factory=Size)
    visual_magnitude: Optional[float] = None
    distance: Optional[Distance] = None
    spectral_type: Optional[str] = None
    proper_motion: Optional[ProperMotion] = None
    radial_velocity: Optional[float] = None
    alternative_names: list[str] = field(default_factory=list)
    catalogs: dict[str, str] = field(default_factory=dict)
    common_name: Optional[str] = None

    def to_dict(self) -> dict:
        """Convert to dictionary for JSON serialization."""
        result = {
            "name": self.name,
            "objectType": self.object_type,
            "ra": self.coordinates.ra_str,
            "dec": self.coordinates.dec_str,
            "raDeg": self.coordinates.ra,
            "decDeg": self.coordinates.dec,
        }

        if self.visual_magnitude is not None:
            result["magnitude"] = str(self.visual_magnitude)

        if self.size.formatted:
            result["size"] = self.size.formatted
        elif self.size.major_axis:
            result["size"] = f"{self.size.major_axis:.1f}″"
        else:
            result["size"] = "N/A"

        if self.common_name:
            result["commonName"] = self.common_name

        if self.distance:
            result["distance"] = {
                "parsecs": self.distance.parsecs,
                "lightYears": self.distance.light_years,
            }

        if self.spectral_type:
            result["spectralType"] = self.spectral_type

        if self.alternative_names:
            result["alternativeNames"] = self.alternative_names

        if self.catalogs:
            result["catalogs"] = self.catalogs

        return result


def _decode_bytes(value) -> str:
    """Decode bytes to string if needed."""
    if isinstance(value, bytes):
        return value.decode("utf-8")
    return str(value) if value is not None else ""


def _extract_common_name(name_list: list[str]) -> Optional[str]:
    """Extract the common name of an astronomical object from its identifiers."""
    name_patterns = [
        (
            r"((?:[A-Z][a-z]+\s?)+(?:Nebula|Galaxy|Cluster|Cloud|Star|Pulsar|Quasar|Supernova|Remnant|Void|Group))",
            1,
        ),
        (r"NAME\s+(.*)", 2),
        (r"ASTERISM\s+(.*)", 3),
        (r"((?:[A-Z][a-z]+){1,2})\s*$", 4),
        (r"((?:[A-Z][a-z]+\s?)+)", 5),
    ]

    potential_names = []

    for name in name_list:
        if name is None:
            continue
        name = name.strip()

        for pattern, priority in name_patterns:
            match = re.search(pattern, name)
            if match:
                common_name = match.group(1).strip()

                # Skip catalog designations
                if re.match(
                    r"^(M|NGC|IC|HD|HIP|Sh2|B|C|HCG|UGC|Abell|PGC|ESO|LBN|SAO|HR|2MASS)\s*\d+",
                    common_name,
                    re.IGNORECASE,
                ):
                    continue

                if len(common_name) < 3:
                    continue

                if re.match(r"^\d+$", common_name):
                    continue

                potential_names.append((common_name, priority))

    if potential_names:
        potential_names.sort(key=lambda x: x[1])
        return potential_names[0][0]

    return None


def _extract_catalog_references(name_list: list[str]) -> dict[str, str]:
    """Extract catalog references from alternative names."""
    catalog_patterns = {
        "Messier": r"^M\s*(\d+)",
        "NGC": r"^NGC\s*(\d+)",
        "IC": r"^IC\s*(\d+)",
        "Caldwell": r"^C\s*(\d+)",
        "Sharpless": r"^Sh\s*2[-\s]*(\d+)",
        "Barnard": r"^B\s*(\d+)",
        "UGC": r"^UGC\s*(\d+)",
        "PGC": r"^PGC\s*(\d+)",
        "Abell": r"^Abell\s*(\d+)",
        "HD": r"^HD\s*(\d+)",
        "HIP": r"^HIP\s*(\d+)",
        "SAO": r"^SAO\s*(\d+)",
        "HR": r"^HR\s*(\d+)",
    }

    catalogs = {}
    for name in name_list:
        if name is None:
            continue
        for catalog, pattern in catalog_patterns.items():
            match = re.match(pattern, name, re.IGNORECASE)
            if match and catalog not in catalogs:
                catalogs[catalog] = match.group(1)

    return catalogs


def _format_ra(ra_deg: float) -> str:
    """Format RA in degrees to hours:minutes:seconds string."""
    ra_hours = ra_deg / 15.0
    hours = int(ra_hours)
    minutes = int((ra_hours - hours) * 60)
    seconds = ((ra_hours - hours) * 60 - minutes) * 60
    return f"{hours:02d}h {minutes:02d}m {seconds:05.2f}s"


def _format_dec(dec_deg: float) -> str:
    """Format Dec in degrees to degrees:arcmin:arcsec string."""
    sign = "+" if dec_deg >= 0 else "-"
    dec_abs = abs(dec_deg)
    degrees = int(dec_abs)
    arcmin = int((dec_abs - degrees) * 60)
    arcsec = ((dec_abs - degrees) * 60 - arcmin) * 60
    return f"{sign}{degrees:02d}° {arcmin:02d}' {arcsec:05.2f}\""


def lookup_object(object_name: str) -> Optional[dict]:
    """
    Look up an astronomical object in the SIMBAD database.

    Args:
        object_name: Name or identifier of the object (e.g., "M31", "NGC 224", "Andromeda")

    Returns:
        Dictionary with object information or None if not found
    """
    simbad = Simbad()

    try:
        # Use TAP query for more complete data
        result_table = simbad.query_tap(
            f"""SELECT basic."main_id", basic."ra", basic."dec",
                       basic."coo_err_maj", basic."coo_err_min",
                       allfluxes."V",
                       basic."galdim_minaxis", basic."otype", basic."oid",
                       basic."pmdec", basic."galdim_angle", basic."pmra",
                       basic."galdim_majaxis", basic."sp_type",
                       basic."plx_value",
                       ident."id" AS "matched_id"
                  FROM basic
                  LEFT JOIN allfluxes ON basic."oid" = allfluxes."oidref"
                  JOIN ident ON basic."oid" = ident."oidref"
                 WHERE id = '{object_name}'
            """
        )

        if result_table is None or len(result_table) == 0:
            return None

        obj = result_table[0]

        # Parse coordinates
        ra_deg = float(obj["ra"])
        dec_deg = float(obj["dec"])
        coordinates = Coordinates(
            ra=ra_deg,
            dec=dec_deg,
            ra_str=_format_ra(ra_deg),
            dec_str=_format_dec(dec_deg),
        )

        # Parse size
        size = Size()
        major_axis = _safe_float(obj["galdim_majaxis"])
        if major_axis is not None and major_axis > 0:
            minor_axis = _safe_float(obj["galdim_minaxis"], default=major_axis)
            pa = _safe_float(obj["galdim_angle"], default=0)

            size.major_axis = major_axis
            size.minor_axis = minor_axis
            size.position_angle = pa

            if major_axis >= 60:
                major_arcmin = major_axis / 60
                minor_arcmin = minor_axis / 60
                size.formatted = f"{major_arcmin:.1f}′ × {minor_arcmin:.1f}′"
            else:
                size.formatted = f"{major_axis:.1f}″ × {minor_axis:.1f}″"
        else:
            otype = _decode_bytes(obj["otype"])
            if "Star" in otype or "*" in otype:
                size.type = "point_source"
            else:
                size.type = "unknown"

        # Parse magnitude
        visual_magnitude = _safe_float(obj["V"])

        # Parse distance from parallax
        distance = None
        plx = _safe_float(obj["plx_value"])
        if plx is not None and plx > 0:
            dist_pc = 1000.0 / plx
            dist_ly = dist_pc * 3.26156
            distance = Distance(parsecs=dist_pc, light_years=dist_ly)

        # Parse spectral type
        spectral_type = None
        if obj["sp_type"] is not None:
            spectral_type = _decode_bytes(obj["sp_type"])

        # Parse proper motion
        proper_motion = None
        pmra = _safe_float(obj["pmra"])
        pmdec = _safe_float(obj["pmdec"])
        if pmra is not None and pmdec is not None:
            proper_motion = ProperMotion(ra=pmra, dec=pmdec)

        # Get alternative identifiers
        alternative_names = []
        other_names = simbad.query_objectids(object_name)
        if other_names is not None and len(other_names) > 0:
            alternative_names = [
                _decode_bytes(name["id"]) for name in other_names if name["id"]
            ]

        # Create result
        main_name = _decode_bytes(obj["main_id"])
        if main_name.startswith("NAME "):
            main_name = main_name[5:]

        result = SimbadResult(
            name=main_name,
            object_type=_decode_bytes(obj["otype"]),
            coordinates=coordinates,
            size=size,
            visual_magnitude=visual_magnitude,
            distance=distance,
            spectral_type=spectral_type,
            proper_motion=proper_motion,
            alternative_names=alternative_names,
            catalogs=_extract_catalog_references([main_name] + alternative_names),
            common_name=_extract_common_name([main_name] + alternative_names),
        )

        return result.to_dict()

    except Exception as e:
        raise RuntimeError(f"Error querying SIMBAD: {e}") from e
