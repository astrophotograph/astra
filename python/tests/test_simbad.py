"""Tests for astra_astro.simbad pure functions."""

import math

import numpy as np
import numpy.testing as npt
import pytest

from astra_astro.simbad import (
    _decode_bytes,
    _extract_catalog_references,
    _extract_common_name,
    _format_dec,
    _format_ra,
    _is_valid_value,
    _safe_float,
)


# ---------------------------------------------------------------------------
# _is_valid_value
# ---------------------------------------------------------------------------
class TestIsValidValue:
    def test_none_is_invalid(self):
        assert _is_valid_value(None) is False

    def test_nan_is_invalid(self):
        assert _is_valid_value(float("nan")) is False

    def test_normal_float_is_valid(self):
        assert _is_valid_value(3.14) is True

    def test_zero_is_valid(self):
        assert _is_valid_value(0) is True

    def test_string_is_valid(self):
        assert _is_valid_value("hello") is True

    def test_empty_string_is_valid(self):
        assert _is_valid_value("") is True

    def test_masked_value_is_invalid(self):
        val = np.ma.masked
        assert _is_valid_value(val) is False

    def test_numpy_nan_is_invalid(self):
        assert _is_valid_value(np.nan) is False

    def test_int_is_valid(self):
        assert _is_valid_value(42) is True


# ---------------------------------------------------------------------------
# _safe_float
# ---------------------------------------------------------------------------
class TestSafeFloat:
    def test_normal_float(self):
        assert _safe_float(3.14) == 3.14

    def test_none_returns_default(self):
        assert _safe_float(None) is None
        assert _safe_float(None, default=0.0) == 0.0

    def test_nan_returns_default(self):
        assert _safe_float(float("nan"), default=-1.0) == -1.0

    def test_string_number(self):
        assert _safe_float("2.5") == 2.5

    def test_invalid_string(self):
        assert _safe_float("abc") is None
        assert _safe_float("abc", default=0.0) == 0.0

    def test_masked_returns_default(self):
        assert _safe_float(np.ma.masked) is None


# ---------------------------------------------------------------------------
# _decode_bytes
# ---------------------------------------------------------------------------
class TestDecodeBytes:
    def test_bytes_decoded(self):
        assert _decode_bytes(b"hello") == "hello"

    def test_string_passthrough(self):
        assert _decode_bytes("world") == "world"

    def test_none_returns_empty(self):
        assert _decode_bytes(None) == ""

    def test_number_converted(self):
        assert _decode_bytes(42) == "42"

    def test_utf8_bytes(self):
        assert _decode_bytes("caf\u00e9".encode("utf-8")) == "caf\u00e9"


# ---------------------------------------------------------------------------
# _extract_common_name
# ---------------------------------------------------------------------------
class TestExtractCommonName:
    def test_nebula_name(self):
        result = _extract_common_name(["Orion Nebula", "M 42", "NGC 1976"])
        assert result == "Orion Nebula"

    def test_galaxy_name(self):
        result = _extract_common_name(["Andromeda Galaxy", "M 31", "NGC 224"])
        assert result == "Andromeda Galaxy"

    def test_name_prefix(self):
        result = _extract_common_name(["NAME Crab Nebula", "M 1"])
        # "NAME Crab Nebula" matches NAME pattern
        assert result is not None
        assert "Crab" in result

    def test_no_common_name(self):
        """Pure catalog designations should not produce a common name."""
        result = _extract_common_name(["NGC 1234", "IC 5678"])
        assert result is None

    def test_empty_list(self):
        assert _extract_common_name([]) is None

    def test_none_in_list(self):
        """None values in list should be skipped."""
        result = _extract_common_name([None, "Orion Nebula"])
        assert result == "Orion Nebula"

    def test_cluster_name(self):
        result = _extract_common_name(["Hercules Cluster", "M 13"])
        assert result == "Hercules Cluster"


# ---------------------------------------------------------------------------
# _extract_catalog_references
# ---------------------------------------------------------------------------
class TestExtractCatalogReferences:
    def test_messier(self):
        result = _extract_catalog_references(["M 42", "NGC 1976"])
        assert "Messier" in result
        assert result["Messier"] == "42"

    def test_ngc(self):
        result = _extract_catalog_references(["NGC 7000"])
        assert "NGC" in result
        assert result["NGC"] == "7000"

    def test_ic(self):
        result = _extract_catalog_references(["IC 1396"])
        assert "IC" in result
        assert result["IC"] == "1396"

    def test_multiple_catalogs(self):
        result = _extract_catalog_references(["M 31", "NGC 224", "UGC 454"])
        assert "Messier" in result
        assert "NGC" in result
        assert "UGC" in result

    def test_sharpless(self):
        result = _extract_catalog_references(["Sh2-129"])
        assert "Sharpless" in result
        assert result["Sharpless"] == "129"

    def test_empty_list(self):
        assert _extract_catalog_references([]) == {}

    def test_none_in_list(self):
        result = _extract_catalog_references([None, "M 42"])
        assert "Messier" in result

    def test_hd_catalog(self):
        result = _extract_catalog_references(["HD 12345"])
        assert "HD" in result
        assert result["HD"] == "12345"

    def test_barnard(self):
        result = _extract_catalog_references(["B 33"])
        assert "Barnard" in result
        assert result["Barnard"] == "33"


# ---------------------------------------------------------------------------
# _format_ra
# ---------------------------------------------------------------------------
class TestFormatRa:
    def test_zero(self):
        result = _format_ra(0.0)
        assert result == "00h 00m 00.00s"

    def test_90_degrees(self):
        """90 degrees = 6h 00m 00.00s."""
        result = _format_ra(90.0)
        assert result == "06h 00m 00.00s"

    def test_known_value(self):
        """180 degrees = 12h 00m 00.00s."""
        result = _format_ra(180.0)
        assert result == "12h 00m 00.00s"

    def test_fractional(self):
        """Check a fractional value."""
        # 83.633 degrees / 15 = 5.5755333... hours
        # 5h 34m 31.92s
        result = _format_ra(83.633)
        assert result.startswith("05h 34m")


# ---------------------------------------------------------------------------
# _format_dec
# ---------------------------------------------------------------------------
class TestFormatDec:
    def test_zero(self):
        result = _format_dec(0.0)
        assert result.startswith("+00")

    def test_positive(self):
        result = _format_dec(41.2694)
        assert result.startswith("+41")
        assert "16" in result  # 0.2694 * 60 ~ 16.16 arcmin

    def test_negative(self):
        result = _format_dec(-5.5)
        assert result.startswith("-05")

    def test_sign_negative(self):
        result = _format_dec(-0.1)
        assert result.startswith("-")

    def test_sign_positive(self):
        result = _format_dec(0.1)
        assert result.startswith("+")
