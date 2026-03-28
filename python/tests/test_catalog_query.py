"""Tests for astra_astro.catalog_query pure functions."""

import math

import numpy as np
import numpy.testing as npt
import pytest

from astra_astro.catalog_query import (
    _format_size,
    _is_in_fov,
    _parse_sexagesimal_dec,
    _parse_sexagesimal_ra,
    _safe_float,
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
