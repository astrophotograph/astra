"""Target type classification for astrophotography processing.

This module provides target type classification from object names using
SIMBAD lookups and catalog pattern matching.
"""

import re
from dataclasses import dataclass
from enum import Enum
from typing import Optional

from astroquery.simbad import Simbad


class TargetType(Enum):
    """Types of astronomical targets for processing optimization."""

    EMISSION_NEBULA = "emission_nebula"  # M42, NGC 7000, etc.
    REFLECTION_NEBULA = "reflection_nebula"  # M78, NGC 1999
    PLANETARY_NEBULA = "planetary_nebula"  # M57, NGC 6543
    GALAXY = "galaxy"  # M31, NGC 891
    GLOBULAR_CLUSTER = "globular_cluster"  # M13, NGC 5139
    OPEN_CLUSTER = "open_cluster"  # M45, NGC 869
    STAR_FIELD = "star_field"  # Generic star field
    UNKNOWN = "unknown"


@dataclass
class TargetInfo:
    """Information about a classified target."""

    target_type: TargetType
    object_name: str
    confidence: float  # 0.0-1.0
    simbad_type: Optional[str] = None

    def to_dict(self) -> dict:
        """Convert to dictionary for JSON serialization."""
        return {
            "targetType": self.target_type.value,
            "objectName": self.object_name,
            "confidence": self.confidence,
            "simbadType": self.simbad_type,
        }


# SIMBAD object type to TargetType mapping
# See: https://simbad.cds.unistra.fr/guide/otypes.htx
SIMBAD_TYPE_MAP = {
    # Emission nebulae
    "HII": TargetType.EMISSION_NEBULA,
    "EmN": TargetType.EMISSION_NEBULA,
    "SNR": TargetType.EMISSION_NEBULA,  # Supernova remnants
    "HH": TargetType.EMISSION_NEBULA,  # Herbig-Haro objects
    "SFR": TargetType.EMISSION_NEBULA,  # Star forming regions
    # Reflection nebulae
    "RNe": TargetType.REFLECTION_NEBULA,
    # Planetary nebulae
    "PN": TargetType.PLANETARY_NEBULA,
    "pA*": TargetType.PLANETARY_NEBULA,  # Post-AGB stars (often PN)
    # Galaxies
    "G": TargetType.GALAXY,
    "GiC": TargetType.GALAXY,
    "GiG": TargetType.GALAXY,
    "GiP": TargetType.GALAXY,
    "HzG": TargetType.GALAXY,
    "AGN": TargetType.GALAXY,
    "Sy1": TargetType.GALAXY,
    "Sy2": TargetType.GALAXY,
    "Sy*": TargetType.GALAXY,
    "QSO": TargetType.GALAXY,
    "BLL": TargetType.GALAXY,
    "rG": TargetType.GALAXY,
    "LIN": TargetType.GALAXY,
    "SBG": TargetType.GALAXY,
    "bCG": TargetType.GALAXY,
    "GrG": TargetType.GALAXY,
    "BiC": TargetType.GALAXY,
    # Globular clusters
    "GlC": TargetType.GLOBULAR_CLUSTER,
    # Open clusters
    "OpC": TargetType.OPEN_CLUSTER,
    "As*": TargetType.OPEN_CLUSTER,  # Stellar associations
    "Cl*": TargetType.OPEN_CLUSTER,  # Star clusters
    "MGr": TargetType.OPEN_CLUSTER,  # Moving groups
    # Stars and star fields (default)
    "*": TargetType.STAR_FIELD,
    "**": TargetType.STAR_FIELD,
}

# Known object name patterns with their target types
KNOWN_PATTERNS = [
    # Sharpless catalog - emission nebulae
    (r"^Sh\s*2[-\s]*\d+", TargetType.EMISSION_NEBULA, 0.9),
    # Barnard catalog - dark nebulae (treat as star field)
    (r"^B\s*\d+", TargetType.STAR_FIELD, 0.7),
    # LBN - Lynds Bright Nebulae
    (r"^LBN\s*\d+", TargetType.EMISSION_NEBULA, 0.8),
    # LDN - Lynds Dark Nebulae
    (r"^LDN\s*\d+", TargetType.STAR_FIELD, 0.7),
    # vdB catalog - reflection nebulae
    (r"^vdB\s*\d+", TargetType.REFLECTION_NEBULA, 0.9),
    # Abell - planetary nebulae or galaxy clusters
    (r"^Abell\s*\d+", TargetType.PLANETARY_NEBULA, 0.6),  # Could be galaxy cluster
]

# Well-known objects with definite types
KNOWN_OBJECTS = {
    # Famous emission nebulae
    "M42": TargetType.EMISSION_NEBULA,
    "M43": TargetType.EMISSION_NEBULA,
    "M1": TargetType.EMISSION_NEBULA,  # Crab Nebula
    "M8": TargetType.EMISSION_NEBULA,  # Lagoon
    "M16": TargetType.EMISSION_NEBULA,  # Eagle
    "M17": TargetType.EMISSION_NEBULA,  # Omega
    "M20": TargetType.EMISSION_NEBULA,  # Trifid
    "M78": TargetType.REFLECTION_NEBULA,
    "NGC 7000": TargetType.EMISSION_NEBULA,  # North America
    "NGC 6992": TargetType.EMISSION_NEBULA,  # Veil
    "NGC 6960": TargetType.EMISSION_NEBULA,  # Veil
    "IC 1805": TargetType.EMISSION_NEBULA,  # Heart
    "IC 1848": TargetType.EMISSION_NEBULA,  # Soul
    "IC 434": TargetType.EMISSION_NEBULA,  # Horsehead region
    # Famous planetary nebulae
    "M27": TargetType.PLANETARY_NEBULA,  # Dumbbell
    "M57": TargetType.PLANETARY_NEBULA,  # Ring
    "M76": TargetType.PLANETARY_NEBULA,  # Little Dumbbell
    "M97": TargetType.PLANETARY_NEBULA,  # Owl
    "NGC 6543": TargetType.PLANETARY_NEBULA,  # Cat's Eye
    "NGC 7293": TargetType.PLANETARY_NEBULA,  # Helix
    # Famous galaxies
    "M31": TargetType.GALAXY,  # Andromeda
    "M32": TargetType.GALAXY,
    "M33": TargetType.GALAXY,  # Triangulum
    "M51": TargetType.GALAXY,  # Whirlpool
    "M81": TargetType.GALAXY,  # Bode's
    "M82": TargetType.GALAXY,  # Cigar
    "M101": TargetType.GALAXY,  # Pinwheel
    "M104": TargetType.GALAXY,  # Sombrero
    "NGC 253": TargetType.GALAXY,  # Sculptor
    "NGC 891": TargetType.GALAXY,
    # Famous globular clusters
    "M2": TargetType.GLOBULAR_CLUSTER,
    "M3": TargetType.GLOBULAR_CLUSTER,
    "M5": TargetType.GLOBULAR_CLUSTER,
    "M13": TargetType.GLOBULAR_CLUSTER,  # Great Hercules
    "M15": TargetType.GLOBULAR_CLUSTER,
    "M22": TargetType.GLOBULAR_CLUSTER,
    "M92": TargetType.GLOBULAR_CLUSTER,
    "NGC 5139": TargetType.GLOBULAR_CLUSTER,  # Omega Centauri
    # Famous open clusters
    "M6": TargetType.OPEN_CLUSTER,  # Butterfly
    "M7": TargetType.OPEN_CLUSTER,  # Ptolemy
    "M11": TargetType.OPEN_CLUSTER,  # Wild Duck
    "M35": TargetType.OPEN_CLUSTER,
    "M36": TargetType.OPEN_CLUSTER,
    "M37": TargetType.OPEN_CLUSTER,
    "M38": TargetType.OPEN_CLUSTER,
    "M44": TargetType.OPEN_CLUSTER,  # Beehive
    "M45": TargetType.OPEN_CLUSTER,  # Pleiades
    "M67": TargetType.OPEN_CLUSTER,
    "NGC 869": TargetType.OPEN_CLUSTER,  # Double Cluster
    "NGC 884": TargetType.OPEN_CLUSTER,  # Double Cluster
}


def _normalize_name(name: str) -> str:
    """Normalize an object name for comparison."""
    # Remove extra spaces and standardize format
    name = name.strip().upper()
    # Normalize M prefix
    name = re.sub(r"^MESSIER\s*", "M", name)
    # Normalize NGC/IC spacing
    name = re.sub(r"^NGC\s*", "NGC ", name)
    name = re.sub(r"^IC\s*", "IC ", name)
    return name


def _classify_from_known(object_name: str) -> Optional[TargetInfo]:
    """Check if object is in our known objects list."""
    normalized = _normalize_name(object_name)

    # Check known objects first
    if normalized in KNOWN_OBJECTS:
        return TargetInfo(
            target_type=KNOWN_OBJECTS[normalized],
            object_name=object_name,
            confidence=1.0,
            simbad_type=None,
        )

    # Check known patterns
    for pattern, target_type, confidence in KNOWN_PATTERNS:
        if re.match(pattern, normalized, re.IGNORECASE):
            return TargetInfo(
                target_type=target_type,
                object_name=object_name,
                confidence=confidence,
                simbad_type=None,
            )

    return None


def _query_simbad(object_name: str) -> Optional[TargetInfo]:
    """Query SIMBAD for object type classification."""
    try:
        simbad = Simbad()
        result = simbad.query_object(object_name)

        if result is None or len(result) == 0:
            return None

        # Get the object type
        otype = result["OTYPE"][0]
        if hasattr(otype, "mask") and otype.mask:
            return None

        otype_str = str(otype).strip()

        # Map SIMBAD type to our TargetType
        target_type = TargetType.UNKNOWN
        confidence = 0.5

        for simbad_type, mapped_type in SIMBAD_TYPE_MAP.items():
            if otype_str.startswith(simbad_type) or otype_str == simbad_type:
                target_type = mapped_type
                confidence = 0.85
                break

        # If no match, try partial matching
        if target_type == TargetType.UNKNOWN:
            # Check for common substrings
            if "Neb" in otype_str or "HII" in otype_str:
                target_type = TargetType.EMISSION_NEBULA
                confidence = 0.7
            elif "PN" in otype_str:
                target_type = TargetType.PLANETARY_NEBULA
                confidence = 0.8
            elif "G" in otype_str and "Cl" not in otype_str:
                target_type = TargetType.GALAXY
                confidence = 0.6
            elif "GlC" in otype_str:
                target_type = TargetType.GLOBULAR_CLUSTER
                confidence = 0.8
            elif "OpC" in otype_str or "Cl*" in otype_str:
                target_type = TargetType.OPEN_CLUSTER
                confidence = 0.8
            else:
                target_type = TargetType.STAR_FIELD
                confidence = 0.3

        return TargetInfo(
            target_type=target_type,
            object_name=object_name,
            confidence=confidence,
            simbad_type=otype_str,
        )

    except Exception as e:
        # Log error but don't fail - return None to fall back to defaults
        import logging

        logging.warning(f"SIMBAD query failed for {object_name}: {e}")
        return None


def classify_from_name(object_name: str) -> TargetInfo:
    """
    Classify target type from object name.

    Classification strategy:
    1. Check known objects list (highest confidence)
    2. Check name patterns (Sharpless, Barnard, etc.)
    3. Query SIMBAD for object type
    4. Fall back to UNKNOWN

    Args:
        object_name: The object name to classify (e.g., "M42", "NGC 7000")

    Returns:
        TargetInfo with target type and confidence
    """
    if not object_name or not object_name.strip():
        return TargetInfo(
            target_type=TargetType.UNKNOWN,
            object_name="",
            confidence=0.0,
            simbad_type=None,
        )

    # Try known objects first
    result = _classify_from_known(object_name)
    if result and result.confidence >= 0.9:
        return result

    # Try SIMBAD lookup
    simbad_result = _query_simbad(object_name)
    if simbad_result and simbad_result.confidence > 0.5:
        return simbad_result

    # Use pattern match if we have one
    if result:
        return result

    # Fall back to unknown
    return TargetInfo(
        target_type=TargetType.UNKNOWN,
        object_name=object_name,
        confidence=0.0,
        simbad_type=None,
    )


def classify_target(object_name: str) -> dict:
    """
    Classify target type from object name.

    This is the main entry point called from Rust via PyO3.

    Args:
        object_name: The object name to classify

    Returns:
        Dictionary with classification results
    """
    info = classify_from_name(object_name)
    return info.to_dict()
