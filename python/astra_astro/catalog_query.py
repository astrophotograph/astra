"""Catalog queries for astronomical objects in a field of view.

This module queries various astronomical catalogs (NGC, Messier, IC, Barnard,
LDN, LBN, Sharpless, Abell, PGC, bright stars) for objects within a given
sky region using VizieR and SIMBAD.
"""

from dataclasses import dataclass, field
from typing import Optional
import math

from astropy import units as u
from astropy.coordinates import SkyCoord
from astroquery.vizier import Vizier
from astroquery.simbad import Simbad
import numpy as np


@dataclass
class CatalogObject:
    """An astronomical object from a catalog."""

    name: str
    catalog: str
    object_type: str
    ra: float           # degrees
    dec: float          # degrees
    magnitude: Optional[float] = None
    size: Optional[str] = None  # formatted size string
    size_arcmin: Optional[float] = None  # size in arcminutes
    common_name: Optional[str] = None

    def to_dict(self) -> dict:
        """Convert to dictionary for JSON serialization."""
        result = {
            "name": self.name,
            "catalog": self.catalog,
            "objectType": self.object_type,
            "ra": self.ra,
            "dec": self.dec,
        }
        if self.magnitude is not None:
            result["magnitude"] = self.magnitude
        if self.size is not None:
            result["size"] = self.size
        if self.size_arcmin is not None:
            result["sizeArcmin"] = self.size_arcmin
        if self.common_name is not None:
            result["commonName"] = self.common_name
        return result


def _safe_float(val, default=None) -> Optional[float]:
    """Safely convert a value to float."""
    if val is None:
        return default
    if hasattr(val, "mask") and np.ma.is_masked(val):
        return default
    try:
        result = float(val)
        if math.isnan(result):
            return default
        return result
    except (ValueError, TypeError):
        return default


def _parse_sexagesimal_ra(ra_str: str) -> Optional[float]:
    """Parse RA in sexagesimal format (HH MM.m or HH MM SS) to decimal degrees."""
    if ra_str is None:
        return None
    try:
        ra_str = str(ra_str).strip()
        parts = ra_str.split()
        if len(parts) >= 2:
            hours = float(parts[0])
            minutes = float(parts[1])
            seconds = float(parts[2]) if len(parts) > 2 else 0.0
            # Convert to decimal degrees: hours * 15 + minutes * 15/60 + seconds * 15/3600
            return hours * 15 + minutes * 0.25 + seconds * (15/3600)
        return None
    except (ValueError, TypeError):
        return None


def _parse_sexagesimal_dec(dec_str: str) -> Optional[float]:
    """Parse Dec in sexagesimal format (+DD MM or +DD MM SS) to decimal degrees."""
    if dec_str is None:
        return None
    try:
        dec_str = str(dec_str).strip()
        # Handle sign
        sign = 1
        if dec_str.startswith('-'):
            sign = -1
            dec_str = dec_str[1:]
        elif dec_str.startswith('+'):
            dec_str = dec_str[1:]

        parts = dec_str.split()
        if len(parts) >= 2:
            degrees = float(parts[0])
            arcmin = float(parts[1])
            arcsec = float(parts[2]) if len(parts) > 2 else 0.0
            return sign * (degrees + arcmin/60 + arcsec/3600)
        elif len(parts) == 1:
            return sign * float(parts[0])
        return None
    except (ValueError, TypeError):
        return None


def _format_size(size_arcmin: Optional[float]) -> Optional[str]:
    """Format size in arcminutes to a readable string."""
    if size_arcmin is None:
        return None
    if size_arcmin >= 60:
        return f"{size_arcmin / 60:.1f}°"
    elif size_arcmin >= 1:
        return f"{size_arcmin:.1f}'"
    else:
        return f"{size_arcmin * 60:.0f}\""


def query_ngc_ic(center_ra: float, center_dec: float, radius_deg: float) -> list[CatalogObject]:
    """Query NGC/IC catalog (VII/118) for objects in the field."""
    objects = []

    try:
        coord = SkyCoord(ra=center_ra, dec=center_dec, unit="deg")
        v = Vizier(columns=["*"])  # Get all columns
        v.ROW_LIMIT = 500

        result = v.query_region(coord, radius=radius_deg * u.deg, catalog="VII/118/ngc2000")

        if result and len(result) > 0:
            table = result[0]
            # Get actual column names
            col_names = table.colnames

            for row in table:
                # Find the name column (could be "Name", "NGC/IC", etc.)
                name = None
                for col in ["Name", "NGC/IC", "_Name"]:
                    if col in col_names:
                        name = str(row[col]).strip()
                        break
                if name is None:
                    continue

                # Get object type
                obj_type = "Unknown"
                for col in ["Type", "OType"]:
                    if col in col_names and row[col]:
                        obj_type = str(row[col]).strip()
                        break

                # Determine catalog prefix
                if name.startswith("I") and not name.startswith("IC"):
                    catalog = "IC"
                    display_name = f"IC {name[1:]}"
                elif name.startswith("IC"):
                    catalog = "IC"
                    display_name = name
                else:
                    catalog = "NGC"
                    display_name = f"NGC {name}" if not name.startswith("NGC") else name

                # Get coordinates - try decimal first, then sexagesimal
                ra = None
                dec = None

                # Try decimal degree columns first
                for ra_col in ["RAJ2000", "_RAJ2000", "RA_ICRS"]:
                    if ra_col in col_names:
                        ra = _safe_float(row[ra_col])
                        if ra is not None:
                            break

                # Try sexagesimal format (RAB2000 is in "HH MM.m" format)
                if ra is None:
                    for ra_col in ["RAB2000", "RA"]:
                        if ra_col in col_names:
                            ra = _parse_sexagesimal_ra(str(row[ra_col]))
                            if ra is not None:
                                break

                for dec_col in ["DEJ2000", "_DEJ2000", "DE_ICRS"]:
                    if dec_col in col_names:
                        dec = _safe_float(row[dec_col])
                        if dec is not None:
                            break

                # Try sexagesimal format (DEB2000 is in "+DD MM" format)
                if dec is None:
                    for dec_col in ["DEB2000", "DE"]:
                        if dec_col in col_names:
                            dec = _parse_sexagesimal_dec(str(row[dec_col]))
                            if dec is not None:
                                break

                if ra is None or dec is None:
                    continue

                # Get magnitude
                mag = None
                for mag_col in ["Bmag", "Vmag", "mag"]:
                    if mag_col in col_names:
                        mag = _safe_float(row[mag_col])
                        if mag is not None:
                            break

                # Get size
                size_arcmin = None
                for size_col in ["MajAx", "Diam", "Size"]:
                    if size_col in col_names:
                        size_arcmin = _safe_float(row[size_col])
                        if size_arcmin is not None:
                            break

                objects.append(CatalogObject(
                    name=display_name,
                    catalog=catalog,
                    object_type=obj_type,
                    ra=ra,
                    dec=dec,
                    magnitude=mag,
                    size=_format_size(size_arcmin),
                    size_arcmin=size_arcmin,
                ))
    except Exception as e:
        print(f"NGC/IC query error: {e}")

    return objects


def query_messier(center_ra: float, center_dec: float, radius_deg: float) -> list[CatalogObject]:
    """Query Messier catalog objects via SIMBAD."""
    objects = []

    try:
        coord = SkyCoord(ra=center_ra, dec=center_dec, unit="deg")

        # Query SIMBAD for Messier objects in region using simpler TAP query
        simbad = Simbad()

        # Use simpler TAP query with correct column names
        query = f"""
        SELECT main_id, ra, dec, otype, galdim_majaxis
        FROM basic
        JOIN ident ON basic.oid = ident.oidref
        WHERE ident.id LIKE 'M %' OR ident.id LIKE 'M%'
        AND CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {center_ra}, {center_dec}, {radius_deg})) = 1
        """

        result = simbad.query_tap(query)

        if result is not None and len(result) > 0:
            for row in result:
                main_id = str(row["main_id"]).strip()

                # Extract Messier number from main_id or look for M pattern
                messier_num = None
                # Try to find M number in the identifier
                import re
                m_match = re.search(r'\bM\s*(\d+)\b', main_id)
                if m_match:
                    messier_num = m_match.group(1)

                if messier_num is None:
                    continue

                display_name = f"M{messier_num}"

                ra = _safe_float(row["ra"])
                dec = _safe_float(row["dec"])
                if ra is None or dec is None:
                    continue

                obj_type = str(row["otype"]).strip() if row["otype"] else "Unknown"
                size_arcsec = _safe_float(row["galdim_majaxis"])
                size_arcmin = size_arcsec / 60 if size_arcsec else None

                objects.append(CatalogObject(
                    name=display_name,
                    catalog="Messier",
                    object_type=obj_type,
                    ra=ra,
                    dec=dec,
                    magnitude=None,  # Skip magnitude for now
                    size=_format_size(size_arcmin),
                    size_arcmin=size_arcmin,
                ))
    except Exception as e:
        print(f"Messier query error: {e}")

    return objects


def query_barnard(center_ra: float, center_dec: float, radius_deg: float) -> list[CatalogObject]:
    """Query Barnard dark nebulae catalog (VII/220A)."""
    objects = []

    try:
        coord = SkyCoord(ra=center_ra, dec=center_dec, unit="deg")
        v = Vizier(columns=["*"])
        v.ROW_LIMIT = 200

        result = v.query_region(coord, radius=radius_deg * u.deg, catalog="VII/220A")

        if result and len(result) > 0:
            table = result[0]
            col_names = table.colnames

            for row in table:
                # Find Barnard number
                barn_num = None
                for col in ["Barn", "Name", "_Name", "B"]:
                    if col in col_names:
                        barn_num = str(row[col]).strip()
                        break
                if barn_num is None:
                    continue

                display_name = f"B {barn_num}"

                # Get coordinates
                ra = None
                dec = None
                for ra_col in ["_RAJ2000", "RAJ2000", "RA_ICRS"]:
                    if ra_col in col_names:
                        ra = _safe_float(row[ra_col])
                        if ra is not None:
                            break
                for dec_col in ["_DEJ2000", "DEJ2000", "DE_ICRS"]:
                    if dec_col in col_names:
                        dec = _safe_float(row[dec_col])
                        if dec is not None:
                            break

                if ra is None or dec is None:
                    continue

                # Get size
                size_arcmin = None
                for size_col in ["Diam", "Size", "MajAx"]:
                    if size_col in col_names:
                        size_arcmin = _safe_float(row[size_col])
                        if size_arcmin is not None:
                            break

                objects.append(CatalogObject(
                    name=display_name,
                    catalog="Barnard",
                    object_type="Dark Nebula",
                    ra=ra,
                    dec=dec,
                    size=_format_size(size_arcmin),
                    size_arcmin=size_arcmin,
                ))
    except Exception as e:
        print(f"Barnard query error: {e}")

    return objects


def query_ldn(center_ra: float, center_dec: float, radius_deg: float) -> list[CatalogObject]:
    """Query Lynds Dark Nebulae catalog (VII/7A)."""
    objects = []

    try:
        coord = SkyCoord(ra=center_ra, dec=center_dec, unit="deg")
        v = Vizier(columns=["*"])  # Get all columns
        v.ROW_LIMIT = 200

        result = v.query_region(coord, radius=radius_deg * u.deg, catalog="VII/7A")

        if result and len(result) > 0:
            table = result[0]
            col_names = table.colnames

            for row in table:
                # Find LDN number
                ldn_num = None
                for col in ["LDN", "Name", "_Name"]:
                    if col in col_names:
                        ldn_num = str(row[col]).strip()
                        break
                if ldn_num is None:
                    continue

                display_name = f"LDN {ldn_num}"

                # Get coordinates - try decimal first, then sexagesimal
                ra = None
                dec = None

                # Try decimal columns first
                for ra_col in ["_RAJ2000", "RAJ2000", "RA_ICRS"]:
                    if ra_col in col_names:
                        ra = _safe_float(row[ra_col])
                        if ra is not None:
                            break

                # Try sexagesimal format
                if ra is None:
                    for ra_col in ["_RA.icrs", "RA1950"]:
                        if ra_col in col_names:
                            ra = _parse_sexagesimal_ra(str(row[ra_col]))
                            if ra is not None:
                                break

                for dec_col in ["_DEJ2000", "DEJ2000", "DE_ICRS"]:
                    if dec_col in col_names:
                        dec = _safe_float(row[dec_col])
                        if dec is not None:
                            break

                if dec is None:
                    for dec_col in ["_DE.icrs", "DE1950"]:
                        if dec_col in col_names:
                            dec = _parse_sexagesimal_dec(str(row[dec_col]))
                            if dec is not None:
                                break

                if ra is None or dec is None:
                    continue

                # Area is in square degrees, convert to approx diameter
                area = None
                for area_col in ["Area", "Size"]:
                    if area_col in col_names:
                        area = _safe_float(row[area_col])
                        if area is not None:
                            break
                size_arcmin = math.sqrt(area) * 60 if area else None

                objects.append(CatalogObject(
                    name=display_name,
                    catalog="LDN",
                    object_type="Dark Nebula",
                    ra=ra,
                    dec=dec,
                    size=_format_size(size_arcmin),
                    size_arcmin=size_arcmin,
                ))
    except Exception as e:
        print(f"LDN query error: {e}")

    return objects


def query_lbn(center_ra: float, center_dec: float, radius_deg: float) -> list[CatalogObject]:
    """Query Lynds Bright Nebulae catalog (VII/9)."""
    objects = []

    try:
        coord = SkyCoord(ra=center_ra, dec=center_dec, unit="deg")
        v = Vizier(columns=["*"])
        v.ROW_LIMIT = 200

        result = v.query_region(coord, radius=radius_deg * u.deg, catalog="VII/9")

        if result and len(result) > 0:
            table = result[0]
            col_names = table.colnames

            for row in table:
                # Find LBN number
                lbn_num = None
                for col in ["LBN", "Name", "_Name"]:
                    if col in col_names:
                        lbn_num = str(row[col]).strip()
                        break
                if lbn_num is None:
                    continue

                # Get the Seq number for unique identification
                seq_num = None
                if "Seq" in col_names:
                    seq_num = _safe_float(row["Seq"])

                display_name = f"LBN {lbn_num}" if lbn_num else f"LBN {int(seq_num)}" if seq_num else None
                if not display_name:
                    continue

                # Get coordinates - try decimal first, then sexagesimal
                ra = None
                dec = None

                for ra_col in ["_RAJ2000", "RAJ2000", "RA_ICRS"]:
                    if ra_col in col_names:
                        ra = _safe_float(row[ra_col])
                        if ra is not None:
                            break

                if ra is None:
                    for ra_col in ["_RA.icrs", "RA1950"]:
                        if ra_col in col_names:
                            ra = _parse_sexagesimal_ra(str(row[ra_col]))
                            if ra is not None:
                                break

                for dec_col in ["_DEJ2000", "DEJ2000", "DE_ICRS"]:
                    if dec_col in col_names:
                        dec = _safe_float(row[dec_col])
                        if dec is not None:
                            break

                if dec is None:
                    for dec_col in ["_DE.icrs", "DE1950"]:
                        if dec_col in col_names:
                            dec = _parse_sexagesimal_dec(str(row[dec_col]))
                            if dec is not None:
                                break

                if ra is None or dec is None:
                    continue

                # Area is in square degrees
                area = None
                for area_col in ["Area", "Size"]:
                    if area_col in col_names:
                        area = _safe_float(row[area_col])
                        if area is not None:
                            break
                size_arcmin = math.sqrt(area) * 60 if area else None

                objects.append(CatalogObject(
                    name=display_name,
                    catalog="LBN",
                    object_type="Bright Nebula",
                    ra=ra,
                    dec=dec,
                    size=_format_size(size_arcmin),
                    size_arcmin=size_arcmin,
                ))
    except Exception as e:
        print(f"LBN query error: {e}")

    return objects


def query_sharpless(center_ra: float, center_dec: float, radius_deg: float) -> list[CatalogObject]:
    """Query Sharpless HII regions catalog (VII/20)."""
    objects = []

    try:
        coord = SkyCoord(ra=center_ra, dec=center_dec, unit="deg")
        v = Vizier(columns=["*"])
        v.ROW_LIMIT = 200

        result = v.query_region(coord, radius=radius_deg * u.deg, catalog="VII/20")

        if result and len(result) > 0:
            table = result[0]
            col_names = table.colnames

            for row in table:
                # Find Sharpless number
                sh2_num = None
                for col in ["Sh2", "Name", "_Name", "Sh2-"]:
                    if col in col_names:
                        sh2_num = str(row[col]).strip()
                        break
                if sh2_num is None:
                    continue

                display_name = f"Sh2-{sh2_num}"

                # Get coordinates
                ra = None
                dec = None
                for ra_col in ["_RAJ2000", "RAJ2000", "RA_ICRS"]:
                    if ra_col in col_names:
                        ra = _safe_float(row[ra_col])
                        if ra is not None:
                            break
                for dec_col in ["_DEJ2000", "DEJ2000", "DE_ICRS"]:
                    if dec_col in col_names:
                        dec = _safe_float(row[dec_col])
                        if dec is not None:
                            break

                if ra is None or dec is None:
                    continue

                # Get size
                size_arcmin = None
                for size_col in ["Diam", "Size", "MajAx"]:
                    if size_col in col_names:
                        size_arcmin = _safe_float(row[size_col])
                        if size_arcmin is not None:
                            break

                objects.append(CatalogObject(
                    name=display_name,
                    catalog="Sharpless",
                    object_type="HII Region",
                    ra=ra,
                    dec=dec,
                    size=_format_size(size_arcmin),
                    size_arcmin=size_arcmin,
                ))
    except Exception as e:
        print(f"Sharpless query error: {e}")

    return objects


def query_abell(center_ra: float, center_dec: float, radius_deg: float) -> list[CatalogObject]:
    """Query Abell galaxy clusters catalog (VII/110A)."""
    objects = []

    try:
        coord = SkyCoord(ra=center_ra, dec=center_dec, unit="deg")
        v = Vizier(columns=["*"])
        v.ROW_LIMIT = 200

        result = v.query_region(coord, radius=radius_deg * u.deg, catalog="VII/110A")

        if result and len(result) > 0:
            table = result[0]
            col_names = table.colnames

            for row in table:
                # Find Abell number
                aco_num = None
                for col in ["ACO", "Abell", "Name", "_Name"]:
                    if col in col_names:
                        aco_num = str(row[col]).strip()
                        break
                if aco_num is None:
                    continue

                display_name = f"Abell {aco_num}"

                # Get coordinates
                ra = None
                dec = None
                for ra_col in ["_RAJ2000", "RAJ2000", "RA_ICRS"]:
                    if ra_col in col_names:
                        ra = _safe_float(row[ra_col])
                        if ra is not None:
                            break
                for dec_col in ["_DEJ2000", "DEJ2000", "DE_ICRS"]:
                    if dec_col in col_names:
                        dec = _safe_float(row[dec_col])
                        if dec is not None:
                            break

                if ra is None or dec is None:
                    continue

                # Get magnitude
                mag = None
                for mag_col in ["m10", "Bmag", "Vmag"]:
                    if mag_col in col_names:
                        mag = _safe_float(row[mag_col])
                        if mag is not None:
                            break

                objects.append(CatalogObject(
                    name=display_name,
                    catalog="Abell",
                    object_type="Galaxy Cluster",
                    ra=ra,
                    dec=dec,
                    magnitude=mag,
                ))
    except Exception as e:
        print(f"Abell query error: {e}")

    return objects


def query_pgc(center_ra: float, center_dec: float, radius_deg: float) -> list[CatalogObject]:
    """Query PGC galaxies catalog (VII/237)."""
    objects = []

    try:
        coord = SkyCoord(ra=center_ra, dec=center_dec, unit="deg")
        v = Vizier(columns=["*"])
        v.ROW_LIMIT = 300

        result = v.query_region(coord, radius=radius_deg * u.deg, catalog="VII/237")

        if result and len(result) > 0:
            table = result[0]
            col_names = table.colnames

            for row in table:
                # Find PGC number
                pgc_num = None
                for col in ["PGC", "Name", "_Name"]:
                    if col in col_names:
                        pgc_num = str(row[col]).strip()
                        break
                if pgc_num is None:
                    continue

                display_name = f"PGC {pgc_num}"

                # Get coordinates
                ra = None
                dec = None
                for ra_col in ["_RAJ2000", "RAJ2000", "RA_ICRS"]:
                    if ra_col in col_names:
                        ra = _safe_float(row[ra_col])
                        if ra is not None:
                            break
                for dec_col in ["_DEJ2000", "DEJ2000", "DE_ICRS"]:
                    if dec_col in col_names:
                        dec = _safe_float(row[dec_col])
                        if dec is not None:
                            break

                if ra is None or dec is None:
                    continue

                # Get magnitude
                mag = None
                for mag_col in ["BT", "Bmag", "Vmag"]:
                    if mag_col in col_names:
                        mag = _safe_float(row[mag_col])
                        if mag is not None:
                            break

                # logD25 is log of diameter in 0.1 arcmin, convert to arcmin
                size_arcmin = None
                if "logD25" in col_names:
                    log_d25 = _safe_float(row["logD25"])
                    if log_d25 is not None:
                        size_arcmin = (10 ** log_d25) * 0.1

                # Get morphological type
                morph_type = "Galaxy"
                for type_col in ["MType", "Type"]:
                    if type_col in col_names and row[type_col]:
                        morph_type = str(row[type_col]).strip() or "Galaxy"
                        break

                objects.append(CatalogObject(
                    name=display_name,
                    catalog="PGC",
                    object_type=morph_type,
                    ra=ra,
                    dec=dec,
                    magnitude=mag,
                    size=_format_size(size_arcmin),
                    size_arcmin=size_arcmin,
                ))
    except Exception as e:
        print(f"PGC query error: {e}")

    return objects


def query_bright_stars(center_ra: float, center_dec: float, radius_deg: float,
                       mag_limit: float = 6.0) -> list[CatalogObject]:
    """Query bright stars from Yale Bright Star Catalog (V/50)."""
    objects = []

    try:
        coord = SkyCoord(ra=center_ra, dec=center_dec, unit="deg")
        v = Vizier(columns=["*"])
        v.ROW_LIMIT = 500

        result = v.query_region(
            coord,
            radius=radius_deg * u.deg,
            catalog="V/50",
            column_filters={"Vmag": f"<{mag_limit}"}
        )

        if result and len(result) > 0:
            table = result[0]
            col_names = table.colnames

            for row in table:
                # Get HR number
                hr_num = None
                for col in ["HR", "Name", "_Name"]:
                    if col in col_names:
                        hr_num = str(row[col]).strip()
                        break
                if hr_num is None:
                    continue

                # Get coordinates
                ra = None
                dec = None
                for ra_col in ["_RAJ2000", "RAJ2000", "RA_ICRS"]:
                    if ra_col in col_names:
                        ra = _safe_float(row[ra_col])
                        if ra is not None:
                            break
                for dec_col in ["_DEJ2000", "DEJ2000", "DE_ICRS"]:
                    if dec_col in col_names:
                        dec = _safe_float(row[dec_col])
                        if dec is not None:
                            break

                if ra is None or dec is None:
                    continue

                # Get magnitude
                mag = None
                for mag_col in ["Vmag", "Bmag"]:
                    if mag_col in col_names:
                        mag = _safe_float(row[mag_col])
                        if mag is not None:
                            break

                # Get common name if available
                common_name = None
                for name_col in ["Name", "CommonName"]:
                    if name_col in col_names and row[name_col]:
                        name_val = str(row[name_col]).strip()
                        if name_val:
                            common_name = name_val
                            break

                display_name = common_name if common_name else f"HR {hr_num}"

                # Get spectral type
                sp_type = "Star"
                for sp_col in ["SpType", "Sp"]:
                    if sp_col in col_names and row[sp_col]:
                        sp_type = str(row[sp_col]).strip() or "Star"
                        break

                objects.append(CatalogObject(
                    name=display_name,
                    catalog="Bright Stars",
                    object_type=f"Star ({sp_type})" if sp_type != "Star" else "Star",
                    ra=ra,
                    dec=dec,
                    magnitude=mag,
                    common_name=common_name,
                ))
    except Exception as e:
        print(f"Bright stars query error: {e}")

    return objects


def _is_in_fov(obj_ra: float, obj_dec: float, center_ra: float, center_dec: float,
               width_deg: float, height_deg: float) -> bool:
    """Check if an object is within the rectangular field of view."""
    # Calculate RA difference
    ra_diff = obj_ra - center_ra

    # Handle RA wrap-around at 0/360
    if ra_diff > 180:
        ra_diff -= 360
    elif ra_diff < -180:
        ra_diff += 360

    # RA offset in degrees (not corrected for cos(dec) since width_deg is in sky degrees)
    # The width_deg from plate solving is actual sky width, and catalog RA differences
    # at this declination need the same cos(dec) factor applied
    cos_dec = math.cos(math.radians(center_dec))
    ra_offset_sky = abs(ra_diff) * cos_dec
    dec_offset = abs(obj_dec - center_dec)

    # Check if within rectangular bounds
    # Use generous margin (50%) to account for coordinate precision differences
    # and objects that may be partially in the FOV
    margin = 0.5
    half_width = width_deg / 2 * (1 + margin)
    half_height = height_deg / 2 * (1 + margin)

    in_fov = ra_offset_sky <= half_width and dec_offset <= half_height

    return in_fov


def query_objects_in_fov(
    center_ra: float,
    center_dec: float,
    width_deg: float,
    height_deg: float,
    catalogs: Optional[list[str]] = None,
    star_mag_limit: float = 5.0,
) -> list[dict]:
    """
    Query multiple catalogs for objects in a field of view.

    Args:
        center_ra: Center RA in degrees
        center_dec: Center Dec in degrees
        width_deg: Field width in degrees
        height_deg: Field height in degrees
        catalogs: List of catalogs to query. If None, queries all.
                  Options: "ngc", "ic", "messier", "barnard", "ldn", "lbn",
                           "sharpless", "abell", "pgc", "stars"
        star_mag_limit: Magnitude limit for bright stars (default 5.0)

    Returns:
        List of CatalogObject dictionaries
    """
    # Calculate search radius (diagonal of FOV / 2, with margin)
    radius_deg = math.sqrt(width_deg**2 + height_deg**2) / 2 * 1.1

    all_objects: list[CatalogObject] = []

    # Default to all catalogs
    if catalogs is None:
        catalogs = ["ngc", "ic", "messier", "barnard", "ldn", "lbn",
                    "sharpless", "abell", "pgc", "stars"]

    catalog_lower = [c.lower() for c in catalogs]

    # Query each requested catalog
    if "ngc" in catalog_lower or "ic" in catalog_lower:
        all_objects.extend(query_ngc_ic(center_ra, center_dec, radius_deg))

    if "messier" in catalog_lower:
        all_objects.extend(query_messier(center_ra, center_dec, radius_deg))

    if "barnard" in catalog_lower:
        all_objects.extend(query_barnard(center_ra, center_dec, radius_deg))

    if "ldn" in catalog_lower:
        all_objects.extend(query_ldn(center_ra, center_dec, radius_deg))

    if "lbn" in catalog_lower:
        all_objects.extend(query_lbn(center_ra, center_dec, radius_deg))

    if "sharpless" in catalog_lower:
        all_objects.extend(query_sharpless(center_ra, center_dec, radius_deg))

    if "abell" in catalog_lower:
        all_objects.extend(query_abell(center_ra, center_dec, radius_deg))

    if "pgc" in catalog_lower:
        all_objects.extend(query_pgc(center_ra, center_dec, radius_deg))

    if "stars" in catalog_lower:
        all_objects.extend(query_bright_stars(center_ra, center_dec, radius_deg, star_mag_limit))

    # Remove duplicates (same position within 1 arcmin)
    unique_objects = []
    for obj in all_objects:
        is_duplicate = False
        for existing in unique_objects:
            # Check if positions are within 1 arcmin
            ra_diff = abs(obj.ra - existing.ra) * math.cos(math.radians(obj.dec))
            dec_diff = abs(obj.dec - existing.dec)
            sep_deg = math.sqrt(ra_diff**2 + dec_diff**2)
            if sep_deg < 1/60:  # 1 arcmin
                # Keep the one with more specific catalog (Messier > NGC > IC > PGC)
                priority = {"Messier": 0, "NGC": 1, "IC": 2, "Barnard": 3,
                           "LDN": 4, "LBN": 5, "Sharpless": 6, "Abell": 7, "PGC": 8}
                if priority.get(obj.catalog, 99) < priority.get(existing.catalog, 99):
                    unique_objects.remove(existing)
                    unique_objects.append(obj)
                is_duplicate = True
                break
        if not is_duplicate:
            unique_objects.append(obj)

    # Filter to only objects actually within the rectangular FOV
    fov_objects = [
        obj for obj in unique_objects
        if _is_in_fov(obj.ra, obj.dec, center_ra, center_dec, width_deg, height_deg)
    ]

    # Sort by magnitude (brightest first), then by catalog priority
    def sort_key(obj):
        mag = obj.magnitude if obj.magnitude is not None else 99
        priority = {"Messier": 0, "NGC": 1, "IC": 2, "Barnard": 3,
                   "LDN": 4, "LBN": 5, "Sharpless": 6, "Abell": 7,
                   "PGC": 8, "Bright Stars": 9}
        return (priority.get(obj.catalog, 99), mag)

    fov_objects.sort(key=sort_key)

    return [obj.to_dict() for obj in fov_objects]
