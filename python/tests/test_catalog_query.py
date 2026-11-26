"""Tests for astra_astro.catalog_query pure functions."""

import math

import numpy as np
import numpy.testing as npt
import pytest

from astra_astro import catalog_query
from astra_astro.catalog_query import (
    CatalogObject,
    _format_size,
    _is_in_fov,
    _parse_sexagesimal_dec,
    _parse_sexagesimal_ra,
    _safe_float,
    add_pixel_positions,
    query_objects_in_fov,
)


# ---------------------------------------------------------------------------
# _safe_float
# ---------------------------------------------------------------------------
class TestSafeFloat:
    def test_normal_float(self):
        assert _safe_float(3.14) == 3.14

    def test_int(self):
        assert _safe_float(42) == 42.0

    def test_string_number(self):
        assert _safe_float("2.5") == 2.5

    def test_none_returns_default(self):
        assert _safe_float(None) is None
        assert _safe_float(None, default=0.0) == 0.0

    def test_nan_returns_default(self):
        assert _safe_float(float("nan")) is None
        assert _safe_float(float("nan"), default=-1.0) == -1.0

    def test_invalid_string_returns_default(self):
        assert _safe_float("abc") is None
        assert _safe_float("abc", default=0.0) == 0.0

    def test_masked_value(self):
        val = np.ma.masked
        assert _safe_float(val) is None

    def test_numpy_float(self):
        assert _safe_float(np.float64(1.5)) == 1.5


# ---------------------------------------------------------------------------
# _parse_sexagesimal_ra
# ---------------------------------------------------------------------------
class TestParseSexagesimalRa:
    def test_hh_mm(self):
        """12 30 -> 12h 30m -> 187.5 degrees."""
        result = _parse_sexagesimal_ra("12 30")
        npt.assert_allclose(result, 12 * 15 + 30 * 0.25, atol=1e-6)

    def test_hh_mm_ss(self):
        """06 45 09 -> 6h 45m 9s."""
        result = _parse_sexagesimal_ra("06 45 09")
        expected = 6 * 15 + 45 * 0.25 + 9 * (15 / 3600)
        npt.assert_allclose(result, expected, atol=1e-6)

    def test_none_input(self):
        assert _parse_sexagesimal_ra(None) is None

    def test_single_value(self):
        """Single value should return None (needs at least 2 parts)."""
        assert _parse_sexagesimal_ra("12") is None

    def test_zero(self):
        result = _parse_sexagesimal_ra("00 00 00")
        npt.assert_allclose(result, 0.0, atol=1e-10)

    def test_invalid_string(self):
        assert _parse_sexagesimal_ra("invalid") is None


# ---------------------------------------------------------------------------
# _parse_sexagesimal_dec
# ---------------------------------------------------------------------------
class TestParseSexagesimalDec:
    def test_positive_dd_mm(self):
        """+41 16 -> 41 + 16/60 degrees."""
        result = _parse_sexagesimal_dec("+41 16")
        npt.assert_allclose(result, 41 + 16 / 60, atol=1e-6)

    def test_negative_dd_mm_ss(self):
        """-05 23 28 -> -(5 + 23/60 + 28/3600)."""
        result = _parse_sexagesimal_dec("-05 23 28")
        expected = -(5 + 23 / 60 + 28 / 3600)
        npt.assert_allclose(result, expected, atol=1e-6)

    def test_no_sign(self):
        """No sign should default to positive."""
        result = _parse_sexagesimal_dec("41 16")
        npt.assert_allclose(result, 41 + 16 / 60, atol=1e-6)

    def test_none_input(self):
        assert _parse_sexagesimal_dec(None) is None

    def test_single_value(self):
        """Single value should be returned as degrees."""
        result = _parse_sexagesimal_dec("+45")
        npt.assert_allclose(result, 45.0, atol=1e-6)

    def test_minus_double_zero_sign_kept(self):
        """-00 30 must be negative: -0.5 degrees, not +0.5."""
        result = _parse_sexagesimal_dec("-00 30")
        npt.assert_allclose(result, -0.5, atol=1e-9)

    def test_plus_dd_mm_ss(self):
        result = _parse_sexagesimal_dec("+41 16 30")
        npt.assert_allclose(result, 41 + 16 / 60 + 30 / 3600, atol=1e-9)

    def test_invalid_string(self):
        assert _parse_sexagesimal_dec("not a coord") is None

    def test_zero(self):
        result = _parse_sexagesimal_dec("+00 00 00")
        npt.assert_allclose(result, 0.0, atol=1e-10)


# ---------------------------------------------------------------------------
# _is_in_fov
# ---------------------------------------------------------------------------
class TestIsInFov:
    def test_center_is_in_fov(self):
        assert _is_in_fov(180.0, 45.0, 180.0, 45.0, 2.0, 1.5) is True

    def test_outside_fov(self):
        assert _is_in_fov(200.0, 45.0, 180.0, 45.0, 2.0, 1.5) is False

    def test_ra_wraparound_positive(self):
        """Object at RA=1, center at RA=359 should be close."""
        assert _is_in_fov(1.0, 0.0, 359.0, 0.0, 5.0, 5.0) is True

    def test_ra_wraparound_negative(self):
        """Object at RA=359, center at RA=1 should be close."""
        assert _is_in_fov(359.0, 0.0, 1.0, 0.0, 5.0, 5.0) is True

    def test_margin_included(self):
        """Objects slightly outside the nominal FOV should still be included (50% margin)."""
        # Width 2 deg -> half_width = 1 * 1.5 = 1.5 deg
        # At dec=0, cos(dec)=1 so RA offset = RA diff
        in_fov = _is_in_fov(181.4, 45.0, 180.0, 45.0, 2.0, 2.0)
        assert in_fov is True

    def test_far_outside_with_margin(self):
        """Objects far outside should not be included even with margin."""
        in_fov = _is_in_fov(190.0, 45.0, 180.0, 45.0, 2.0, 2.0)
        assert in_fov is False

    def test_dec_offset(self):
        """Check that dec offset is properly checked."""
        assert _is_in_fov(180.0, 50.0, 180.0, 45.0, 2.0, 2.0) is False

    def test_exactly_on_ra_edge_is_inside(self):
        """Half-width at dec 0 with 50% margin is 1.5 deg; the edge itself counts."""
        assert _is_in_fov(11.5, 0.0, 10.0, 0.0, 2.0, 2.0) is True

    def test_just_past_ra_edge_is_outside(self):
        assert _is_in_fov(11.6, 0.0, 10.0, 0.0, 2.0, 2.0) is False

    def test_exactly_on_dec_edge_is_inside(self):
        assert _is_in_fov(10.0, 1.5, 10.0, 0.0, 2.0, 2.0) is True

    def test_just_past_dec_edge_is_outside(self):
        assert _is_in_fov(10.0, 1.6, 10.0, 0.0, 2.0, 2.0) is False

    def test_far_outside_fails_both_bounds(self):
        assert _is_in_fov(30.0, 80.0, 10.0, 0.0, 2.0, 2.0) is False

    def test_ra_offset_scaled_by_cos_dec(self):
        """At dec 60 (cos=0.5) a 2.9 deg RA difference spans 1.45 sky degrees: inside."""
        assert _is_in_fov(12.9, 60.0, 10.0, 60.0, 2.0, 2.0) is True

    def test_ra_offset_beyond_scaled_half_width(self):
        """At dec 60 a 3.2 deg RA difference spans 1.6 sky degrees: outside."""
        assert _is_in_fov(13.2, 60.0, 10.0, 60.0, 2.0, 2.0) is False

    def test_field_near_pole_accepts_large_ra_difference(self):
        """Near the pole all RA values are close on the sky: 100 deg of RA at dec 89.9
        spans about 0.17 sky degrees."""
        assert _is_in_fov(100.0, 89.9, 10.0, 89.9, 2.0, 2.0) is True


class TestCatalogObjectDict:
    def test_to_dict_minimal_has_only_required_keys(self):
        obj = CatalogObject(name="M31", catalog="Messier", object_type="Galaxy", ra=10.5, dec=41.2)
        assert obj.to_dict() == {
            "name": "M31",
            "catalog": "Messier",
            "objectType": "Galaxy",
            "ra": 10.5,
            "dec": 41.2,
        }

    def test_to_dict_full_includes_optional_keys(self):
        obj = CatalogObject(
            name="M31",
            catalog="Messier",
            object_type="Galaxy",
            ra=10.5,
            dec=41.2,
            magnitude=3.4,
            size="3.0°",
            size_arcmin=180.0,
            common_name="Andromeda",
            pixel_x=12.5,
            pixel_y=30.0,
            radius_px=45.0,
        )
        assert obj.to_dict() == {
            "name": "M31",
            "catalog": "Messier",
            "objectType": "Galaxy",
            "ra": 10.5,
            "dec": 41.2,
            "magnitude": 3.4,
            "size": "3.0°",
            "sizeArcmin": 180.0,
            "commonName": "Andromeda",
            "pixelX": 12.5,
            "pixelY": 30.0,
            "radiusPx": 45.0,
        }


# ---------------------------------------------------------------------------
# _format_size
# ---------------------------------------------------------------------------
class TestFormatSize:
    def test_none(self):
        assert _format_size(None) is None

    def test_degrees(self):
        """>=60 arcmin should show in degrees."""
        assert _format_size(120.0) == "2.0\u00b0"

    def test_arcminutes(self):
        """1-60 arcmin should show in arcminutes."""
        assert _format_size(5.0) == "5.0'"

    def test_arcseconds(self):
        """<1 arcmin should show in arcseconds."""
        assert _format_size(0.5) == '30"'

    def test_boundary_60(self):
        result = _format_size(60.0)
        assert result == "1.0\u00b0"

    def test_boundary_1(self):
        result = _format_size(1.0)
        assert result == "1.0'"

    def test_small_value(self):
        result = _format_size(0.1)
        assert result == '6"'


# ---------------------------------------------------------------------------
# helpers for add_pixel_positions / query_objects_in_fov
# ---------------------------------------------------------------------------
QUERY_FUNCTION_NAMES = [
    "query_messier",
    "query_ngc_ic",
    "query_barnard",
    "query_ldn",
    "query_lbn",
    "query_sharpless",
    "query_abell",
    "query_pgc",
    "query_bright_stars",
]


def _write_tan_fits(path, naxis=100):
    """Write a FITS file with a TAN WCS centred at (10 deg, 0 deg), 36"/px.

    CRPIX = (50.5, 50.5) with CD = diag(-0.01, 0.01) deg/px, so the reference
    coordinate maps to zero-based pixel (49.5, 49.5) and a 0.01 deg offset
    moves exactly one pixel (RA to the left because CD[0,0] is negative).
    """
    from astropy.io import fits

    header = fits.Header()
    header["CTYPE1"] = "RA---TAN"
    header["CTYPE2"] = "DEC--TAN"
    header["CUNIT1"] = "deg"
    header["CUNIT2"] = "deg"
    header["CRPIX1"] = 50.5
    header["CRPIX2"] = 50.5
    header["CRVAL1"] = 10.0
    header["CRVAL2"] = 0.0
    header["CD1_1"] = -0.01
    header["CD1_2"] = 0.0
    header["CD2_1"] = 0.0
    header["CD2_2"] = 0.01
    header["RADESYS"] = "ICRS"
    hdu = fits.PrimaryHDU(data=np.zeros((naxis, naxis), dtype=np.float32), header=header)
    hdu.writeto(path, overwrite=True)


def _obj(name, catalog, ra, dec, magnitude=None, size_arcmin=None):
    return CatalogObject(
        name=name,
        catalog=catalog,
        object_type="Test",
        ra=ra,
        dec=dec,
        magnitude=magnitude,
        size=_format_size(size_arcmin),
        size_arcmin=size_arcmin,
    )


class TestAddPixelPositions:
    @pytest.fixture()
    def fits_path(self, tmp_path):
        path = tmp_path / "frame.fits"
        _write_tan_fits(path)
        return str(path)

    def test_object_at_reference_coordinate_is_at_reference_pixel(self, fits_path):
        objs = [{"name": "M31", "ra": 10.0, "dec": 0.0}]
        result = add_pixel_positions(objs, fits_path)
        assert result[0]["pixelX"] == pytest.approx(49.5, abs=1e-4)
        assert result[0]["pixelY"] == pytest.approx(49.5, abs=1e-4)

    def test_dec_offset_moves_y_by_one_pixel_per_pixel_scale(self, fits_path):
        objs = [{"name": "M31", "ra": 10.0, "dec": 0.01}]
        result = add_pixel_positions(objs, fits_path)
        assert result[0]["pixelY"] == pytest.approx(50.5, abs=1e-4)
        assert result[0]["pixelX"] == pytest.approx(49.5, abs=1e-4)

    def test_ra_offset_moves_x_left_by_one_pixel_per_pixel_scale(self, fits_path):
        objs = [{"name": "M31", "ra": 10.01, "dec": 0.0}]
        result = add_pixel_positions(objs, fits_path)
        assert result[0]["pixelX"] == pytest.approx(48.5, abs=1e-4)

    def test_pixel_coordinates_are_rounded_to_two_decimals(self, fits_path):
        objs = [
            {"name": "M31", "ra": 10.0, "dec": 0.00333},
            {"name": "M51", "ra": 10.00333, "dec": 0.0},
        ]
        result = add_pixel_positions(objs, fits_path)
        # 49.5 + 0.333 = 49.833 -> rounds to 49.83; x likewise 49.167 -> 49.17
        assert result[0]["pixelY"] == pytest.approx(49.83, abs=1e-6)
        assert result[1]["pixelX"] == pytest.approx(49.17, abs=1e-6)

    def test_object_beyond_image_edge_gets_no_pixel_position(self, fits_path):
        # ra 8.495 maps to x = 49.5 + 150.5 = 200, outside [−50, 150]
        objs = [{"name": "M31", "ra": 8.495, "dec": 0.0}]
        result = add_pixel_positions(objs, fits_path)
        assert "pixelX" not in result[0]
        assert "pixelY" not in result[0]

    def test_object_within_edge_margin_gets_pixel_position(self, fits_path):
        # ra 9.005 maps to x ~= 149.0, inside the +50 px margin below the 150 limit
        objs = [{"name": "M31", "ra": 9.005, "dec": 0.0}]
        result = add_pixel_positions(objs, fits_path)
        assert result[0]["pixelX"] == pytest.approx(149.0, abs=0.05)

    def test_object_below_bottom_edge_gets_no_pixel_position(self, fits_path):
        # dec -1.005 maps to y ~= -51.0, outside the -50 limit
        objs = [{"name": "M31", "ra": 10.0, "dec": -1.005}]
        result = add_pixel_positions(objs, fits_path)
        assert "pixelX" not in result[0]
        assert "pixelY" not in result[0]

    def test_object_just_outside_bottom_limit_gets_no_pixel_position(self, fits_path):
        """A y of about -50.5 is outside the real limit (-50) but would pass a
        limit loosened to -51: the margin must stay exactly 50 px."""
        objs = [{"name": "M31", "ra": 10.0, "dec": -1.0004}]
        result = add_pixel_positions(objs, fits_path)
        assert "pixelX" not in result[0]

    def test_object_just_outside_right_limit_gets_no_pixel_position(self, fits_path):
        """An x of about 150.5 is outside the real limit (naxis+50=150) but would
        pass a limit loosened to 151."""
        objs = [{"name": "M31", "ra": 8.99, "dec": 0.0}]
        result = add_pixel_positions(objs, fits_path)
        assert "pixelX" not in result[0]

    def test_object_above_top_edge_within_margin_gets_pixel_position(self, fits_path):
        # dec 0.985 maps to y ~= 148.0, inside the margin below 150
        objs = [{"name": "M31", "ra": 10.0, "dec": 0.985}]
        result = add_pixel_positions(objs, fits_path)
        assert result[0]["pixelY"] == pytest.approx(148.0, abs=0.05)

    def test_object_without_coordinates_is_skipped(self, fits_path):
        objs = [{"name": "no-coords"}, {"name": "M31", "ra": 10.0, "dec": 0.0}]
        result = add_pixel_positions(objs, fits_path)
        assert "pixelX" not in result[0]
        assert result[1]["pixelX"] == pytest.approx(49.5, abs=1e-4)

    def test_object_with_nan_ra_is_skipped_but_rest_processed(self, fits_path):
        objs = [
            {"name": "bad", "ra": float("nan"), "dec": 0.0},
            {"name": "M31", "ra": 10.0, "dec": 0.0},
        ]
        result = add_pixel_positions(objs, fits_path)
        assert "pixelX" not in result[0]
        assert result[1]["pixelX"] == pytest.approx(49.5, abs=1e-4)

    def test_missing_fits_file_returns_objects_unchanged(self, tmp_path):
        objs = [{"name": "M31", "ra": 10.0, "dec": 0.0}]
        result = add_pixel_positions(objs, str(tmp_path / "nope.fits"))
        assert result == [{"name": "M31", "ra": 10.0, "dec": 0.0}]
        assert "pixelX" not in result[0]

    def test_radius_px_from_size_and_pixel_scale(self, fits_path):
        # (30 arcmin / 60) / 0.01 deg/px / 2 = 25 px
        objs = [{"name": "M31", "ra": 10.0, "dec": 0.0, "sizeArcmin": 30.0}]
        result = add_pixel_positions(objs, fits_path)
        assert result[0]["radiusPx"] == pytest.approx(25.0, abs=1e-6)

    def test_radius_px_has_a_floor_of_ten_pixels(self, fits_path):
        # (2 / 60) / 0.01 / 2 = 1.67 px, clamped up to 10
        objs = [{"name": "M31", "ra": 10.0, "dec": 0.0, "sizeArcmin": 2.0}]
        result = add_pixel_positions(objs, fits_path)
        assert result[0]["radiusPx"] == 10.0

    def test_no_radius_px_without_size(self, fits_path):
        objs = [{"name": "M31", "ra": 10.0, "dec": 0.0}]
        result = add_pixel_positions(objs, fits_path)
        assert "radiusPx" not in result[0]
        assert result[0]["pixelX"] == pytest.approx(49.5, abs=1e-4)

    def test_pixel_scale_comes_from_full_cd_matrix(self, tmp_path):
        """With a skewed CD matrix the scale is sqrt(det(CD)) in deg/px, so a
        radius uses the geometric mean of the axes, not one axis alone."""
        from astropy.io import fits

        header = fits.Header()
        header["CTYPE1"] = "RA---TAN"
        header["CTYPE2"] = "DEC--TAN"
        header["CRPIX1"] = 50.5
        header["CRPIX2"] = 50.5
        header["CRVAL1"] = 10.0
        header["CRVAL2"] = 0.0
        header["CD1_1"] = -0.01
        header["CD1_2"] = 0.001
        header["CD2_1"] = 0.002
        header["CD2_2"] = 0.02
        path = tmp_path / "skew.fits"
        fits.PrimaryHDU(data=np.zeros((100, 100), dtype=np.float32), header=header).writeto(path)
        objs = [{"name": "M31", "ra": 10.0, "dec": 0.0, "sizeArcmin": 30.0}]
        result = add_pixel_positions(objs, str(path))
        # |det| = |-0.01*0.02 - 0.001*0.002| = 0.000202
        expected = (30.0 / 60.0) / math.sqrt(0.000202) / 2.0
        assert result[0]["radiusPx"] == pytest.approx(round(expected, 2), abs=1e-6)

    def test_solve_result_without_rotation_defaults_to_zero(self, fits_path):
        """A solve result without a rotation key must not rotate the field."""
        solve = {"centerRa": 10.0, "centerDec": 0.0, "pixelScale": 36.0}
        objs = [{"name": "M31", "ra": 10.0, "dec": 0.01}]
        result = add_pixel_positions(objs, fits_path, solve_result=solve)
        assert result[0]["pixelX"] == pytest.approx(49.0, abs=1e-4)
        assert result[0]["pixelY"] == pytest.approx(50.0, abs=1e-4)

    def test_fits_without_dimensions_uses_zero_size_image(self, tmp_path):
        """A header-only FITS has no NAXIS; the image is then treated as having
        no pixels at all, so nothing lands inside the bounds."""
        from astropy.io import fits

        header = fits.Header()
        header["CTYPE1"] = "RA---TAN"
        header["CTYPE2"] = "DEC--TAN"
        header["CRPIX1"] = 50.5
        header["CRPIX2"] = 50.5
        header["CRVAL1"] = 10.0
        header["CRVAL2"] = 0.0
        header["CD1_1"] = -0.01
        header["CD2_2"] = 0.01
        path = tmp_path / "nodata.fits"
        fits.PrimaryHDU(data=None, header=header).writeto(path)
        # Maps to pixel (50.5, 50.5): inside a mistaken one-pixel image, outside
        # the real zero-sized one.
        objs = [{"name": "M31", "ra": 9.99, "dec": 0.01}]
        result = add_pixel_positions(objs, str(path))
        assert "pixelX" not in result[0]

    def test_solve_result_center_and_scale_builds_wcs(self, fits_path):
        solve = {
            "centerRa": 10.0,
            "centerDec": 0.0,
            "pixelScale": 36.0,  # arcsec/px -> 0.01 deg/px
            "rotation": 0.0,
        }
        objs = [{"name": "M31", "ra": 10.0, "dec": 0.0}]
        result = add_pixel_positions(objs, fits_path, solve_result=solve)
        assert result[0]["pixelX"] == pytest.approx(49.0, abs=1e-4)
        assert result[0]["pixelY"] == pytest.approx(49.0, abs=1e-4)

    def test_solve_result_rotation_rotates_pixel_positions(self, fits_path):
        """With 90 deg rotation, an RA offset appears along +Y and dec along +X."""
        solve = {"centerRa": 10.0, "centerDec": 0.0, "pixelScale": 36.0, "rotation": 90.0}
        objs = [{"name": "M31", "ra": 10.01, "dec": 0.0}]
        result = add_pixel_positions(objs, fits_path, solve_result=solve)
        assert result[0]["pixelX"] == pytest.approx(49.0, abs=1e-3)
        assert result[0]["pixelY"] == pytest.approx(50.0, abs=1e-3)

    def test_solve_result_raw_wcs_params_take_precedence(self, fits_path):
        solve = {
            "wcs": {
                "crpix": [50.0, 50.0],
                "crval": [10.0, 0.0],
                "cd": [[-0.01, 0.0], [0.0, 0.01]],
            }
        }
        objs = [{"name": "M31", "ra": 10.0, "dec": 0.01}]
        result = add_pixel_positions(objs, fits_path, solve_result=solve)
        assert result[0]["pixelX"] == pytest.approx(49.0, abs=1e-4)
        assert result[0]["pixelY"] == pytest.approx(50.0, abs=1e-4)


class TestQueryObjectsInFov:
    @pytest.fixture()
    def calls(self, monkeypatch):
        """Patch every catalog query function on the module with a recorder."""
        recorded = {}

        def make_recorder(key):
            def fake(ra, dec, radius, *args, **kwargs):
                recorded.setdefault(key, []).append((ra, dec, radius, args, kwargs))
                return []

            return fake

        for name in QUERY_FUNCTION_NAMES:
            monkeypatch.setattr(catalog_query, name, make_recorder(name))
        return recorded

    def test_only_requested_catalogs_are_queried(self, calls):
        query_objects_in_fov(10.0, 0.0, 2.0, 2.0, catalogs=["messier", "pgc"])
        assert set(calls) == {"query_messier", "query_pgc"}

    def test_ngc_and_ic_share_one_catalog_query(self, calls):
        query_objects_in_fov(10.0, 0.0, 2.0, 2.0, catalogs=["ngc", "ic"])
        assert set(calls) == {"query_ngc_ic"}
        assert len(calls["query_ngc_ic"]) == 1

    def test_search_radius_is_half_diagonal_with_margin(self, calls):
        query_objects_in_fov(10.0, 0.0, 3.0, 4.0, catalogs=["ngc"])
        _, _, radius, _, _ = calls["query_ngc_ic"][0]
        assert radius == pytest.approx(math.sqrt(3.0**2 + 4.0**2) / 2 * 1.1)  # 2.75

    def test_default_catalog_list_queries_everything(self, calls):
        query_objects_in_fov(10.0, 0.0, 2.0, 2.0, catalogs=None)
        assert set(calls) == set(QUERY_FUNCTION_NAMES)

    def test_star_mag_limit_forwarded_with_default(self, calls):
        query_objects_in_fov(10.0, 0.0, 2.0, 2.0, catalogs=["stars"])
        _, _, _, args, kwargs = calls["query_bright_stars"][0]
        combined = list(args) + list(kwargs.values())
        assert combined[-1] == pytest.approx(5.0)

    def test_custom_star_mag_limit_forwarded(self, calls):
        query_objects_in_fov(10.0, 0.0, 2.0, 2.0, catalogs=["stars"], star_mag_limit=4.0)
        _, _, _, args, kwargs = calls["query_bright_stars"][0]
        combined = list(args) + list(kwargs.values())
        assert combined[-1] == pytest.approx(4.0)

    def test_results_are_returned_as_dicts(self, monkeypatch, calls):
        monkeypatch.setattr(
            catalog_query,
            "query_messier",
            lambda *a, **k: [_obj("M31", "Messier", 10.0, 0.0, magnitude=3.4)],
        )
        result = query_objects_in_fov(10.0, 0.0, 2.0, 2.0, catalogs=["messier"])
        assert result == [
            {
                "name": "M31",
                "catalog": "Messier",
                "objectType": "Test",
                "ra": 10.0,
                "dec": 0.0,
                "magnitude": 3.4,
            }
        ]

    def test_objects_outside_fov_are_removed(self, monkeypatch, calls):
        monkeypatch.setattr(
            catalog_query,
            "query_ngc_ic",
            lambda *a, **k: [_obj("NGC 1", "NGC", 10.0, 0.0), _obj("NGC 2", "NGC", 10.0, 5.0)],
        )
        result = query_objects_in_fov(10.0, 0.0, 2.0, 2.0, catalogs=["ngc"])
        assert [o["name"] for o in result] == ["NGC 1"]

    def test_duplicates_within_one_arcmin_merge_preferring_messier(self, monkeypatch, calls):
        def fake_messier(*a, **k):
            return [_obj("M1", "Messier", 10.0, 0.0)]

        def fake_ngc(*a, **k):
            return [
                _obj("NGC 1952", "NGC", 10.0, 0.0, magnitude=8.4, size_arcmin=5.0),
            ]

        monkeypatch.setattr(catalog_query, "query_messier", fake_messier)
        monkeypatch.setattr(catalog_query, "query_ngc_ic", fake_ngc)
        result = query_objects_in_fov(10.0, 0.0, 2.0, 2.0, catalogs=["messier", "ngc"])
        assert [o["name"] for o in result] == ["M1"]
        assert result[0]["magnitude"] == pytest.approx(8.4)
        assert result[0]["sizeArcmin"] == pytest.approx(5.0)
        assert result[0]["size"] == "5.0'"

    def test_lower_priority_duplicate_fills_missing_data(self, monkeypatch, calls):
        """NGC is kept over a duplicate Barnard entry, but takes Barnard's size."""

        def fake_ngc(*a, **k):
            return [_obj("NGC 7000", "NGC", 10.0, 0.0)]

        def fake_barnard(*a, **k):
            return [_obj("B 1", "Barnard", 10.0, 0.0, size_arcmin=4.0)]

        monkeypatch.setattr(catalog_query, "query_ngc_ic", fake_ngc)
        monkeypatch.setattr(catalog_query, "query_barnard", fake_barnard)
        result = query_objects_in_fov(10.0, 0.0, 2.0, 2.0, catalogs=["ngc", "barnard"])
        assert [o["name"] for o in result] == ["NGC 7000"]
        assert result[0]["sizeArcmin"] == pytest.approx(4.0)

    def test_separation_exactly_one_arcmin_is_not_a_duplicate(self, monkeypatch, calls):
        monkeypatch.setattr(
            catalog_query,
            "query_ngc_ic",
            lambda *a, **k: [
                _obj("NGC 1", "NGC", 10.0, -0.5 / 60),
                _obj("NGC 2", "NGC", 10.0, 0.5 / 60),
            ],
        )
        result = query_objects_in_fov(10.0, 0.0, 2.0, 2.0, catalogs=["ngc"])
        assert sorted(o["name"] for o in result) == ["NGC 1", "NGC 2"]

    def test_separation_below_one_arcmin_is_a_duplicate(self, monkeypatch, calls):
        monkeypatch.setattr(
            catalog_query,
            "query_ngc_ic",
            lambda *a, **k: [
                _obj("NGC 1", "NGC", 10.0, -0.25 / 60),
                _obj("NGC 2", "NGC", 10.0, 0.25 / 60),
            ],
        )
        result = query_objects_in_fov(10.0, 0.0, 2.0, 2.0, catalogs=["ngc"])
        assert len(result) == 1

    def test_sorted_by_catalog_priority_then_magnitude(self, monkeypatch, calls):
        monkeypatch.setattr(
            catalog_query,
            "query_messier",
            lambda *a, **k: [
                _obj("M-faint", "Messier", 10.1, 0.0, magnitude=9.0),
                _obj("M-bright", "Messier", 9.9, 0.0, magnitude=2.0),
            ],
        )
        monkeypatch.setattr(
            catalog_query,
            "query_pgc",
            lambda *a, **k: [_obj("PGC 1", "PGC", 10.2, 0.0, magnitude=1.0)],
        )
        result = query_objects_in_fov(10.0, 0.0, 2.0, 2.0, catalogs=["messier", "pgc"])
        assert [o["name"] for o in result] == ["M-bright", "M-faint", "PGC 1"]

    def test_missing_magnitude_sorts_as_magnitude_99(self, monkeypatch, calls):
        """A missing magnitude is treated as magnitude 99: dimmer than anything
        brighter than 99 but brighter than an object at 99.5."""
        monkeypatch.setattr(
            catalog_query,
            "query_messier",
            lambda *a, **k: [
                _obj("M-no-mag", "Messier", 10.1, 0.0, magnitude=None),
                _obj("M-dim", "Messier", 9.9, 0.0, magnitude=99.5),
            ],
        )
        result = query_objects_in_fov(10.0, 0.0, 2.0, 2.0, catalogs=["messier"])
        assert [o["name"] for o in result] == ["M-no-mag", "M-dim"]
