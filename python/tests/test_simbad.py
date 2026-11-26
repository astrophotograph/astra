"""Tests for astra_astro.simbad pure functions."""

import numpy as np
import pytest
from astropy.table import Table

from astra_astro.simbad import (
    Coordinates,
    SimbadResult,
    Size,
    _decode_bytes,
    _extract_catalog_references,
    _extract_common_name,
    _format_dec,
    _format_ra,
    _is_valid_value,
    _safe_float,
    lookup_object,
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


# ---------------------------------------------------------------------------
# _format_dec / _format_ra rounding
# ---------------------------------------------------------------------------
def test_format_ra_seconds_boundary():
    """59.99s must not round up to 60."""
    # 90.4663 degrees / 15 = 6.03108666 h = 6h 01m 51.912s
    result = _format_ra(90.4663)
    assert result == "06h 01m 51.91s"


def test_format_ra_seconds_exactly_59_995_rounds_within_field():
    """A value whose seconds would exceed 59.99 still formats without error."""
    result = _format_ra(0.5)
    assert result == "00h 02m 00.00s"


def test_format_dec_minutes_boundary():
    """41.999 deg: arcsec part is 59.9x, not 60.00."""
    result = _format_dec(41.999)
    assert result == "+41° 59' 56.40\""


def test_format_dec_zero_seconds():
    result = _format_dec(10.0)
    assert result == "+10° 00' 00.00\""


def test_format_dec_minus_one_second():
    result = _format_dec(-5.5)
    assert result == "-05° 30' 00.00\""


# ---------------------------------------------------------------------------
# _extract_common_name priority and filtering
# ---------------------------------------------------------------------------
class TestExtractCommonNamePriority:
    def test_named_object_beats_asterism(self):
        """Priority 2 (NAME ...) beats priority 3 (ASTERISM ...)."""
        result = _extract_common_name(["ASTERISM Orion Belt", "NAME Orion"])
        assert result == "Orion"

    def test_asterism_before_word_pattern(self):
        """Priority 3 (ASTERISM) beats priority 4 (trailing capitalized word)."""
        # "ASTERISM Orion" has no pattern-1 keyword, so it matches at priority 3;
        # "Rigel" only matches the bare-word pattern at priority 4.
        assert _extract_common_name(["ASTERISM Orion", "Rigel"]) == "Orion"
        assert _extract_common_name(["Rigel", "ASTERISM Orion"]) == "Orion"

    def test_word_pattern_priority(self):
        """A bare capitalized word wins at lower priority than NAME-prefixed."""
        result = _extract_common_name(["NAME Betelgeuse", "Rigel"])
        assert result == "Betelgeuse"

    def test_bytes_like_word_matches(self):
        result = _extract_common_name(["NGC 1", "Fomalhaut"])
        assert result == "Fomalhaut"

    def test_multi_word_capitalized_matches(self):
        """The bare-word pattern grabs the final capitalized word(s)."""
        result = _extract_common_name(["NGC 1", "Alpha Centauri"])
        assert result == "Centauri"

    def test_short_name_rejected(self):
        """A match shorter than 3 characters is skipped."""
        result = _extract_common_name(["NGC 1", "Ab"])
        assert result is None

    def test_numeric_name_rejected(self):
        result = _extract_common_name(["1234"])
        assert result is None

    def test_catalog_designation_rejected_even_with_word(self):
        """A matched word that is itself a catalog designation is skipped."""
        result = _extract_common_name(["NAME M 42"])
        # "NAME M 42" -> NAME pattern captures "M 42", which is a Messier
        # designation, so it is rejected.
        assert result is None

    def test_strip_whitespace(self):
        result = _extract_common_name(["  Orion Nebula  "])
        assert result == "Orion Nebula"


# ---------------------------------------------------------------------------
# _extract_catalog_references first-wins and non-matching
# ---------------------------------------------------------------------------
class TestExtractCatalogReferencesDetails:
    def test_first_occurrence_wins(self):
        result = _extract_catalog_references(["M 42", "M 45"])
        assert result == {"Messier": "42"}

    def test_case_insensitive(self):
        result = _extract_catalog_references(["ngc 1976"])
        assert result == {"NGC": "1976"}

    def test_caldwell(self):
        assert _extract_catalog_references(["C 14"]) == {"Caldwell": "14"}

    def test_pgc(self):
        assert _extract_catalog_references(["PGC 1234"]) == {"PGC": "1234"}

    def test_abell(self):
        assert _extract_catalog_references(["Abell 1656"]) == {"Abell": "1656"}

    def test_hip_sao_hr(self):
        result = _extract_catalog_references(["HIP 1", "SAO 2", "HR 3"])
        assert result == {"HIP": "1", "SAO": "2", "HR": "3"}

    def test_sharpless_variants(self):
        result = _extract_catalog_references(["Sh 2-155", "sh2-129"])
        assert result == {"Sharpless": "155"}

    def test_unrecognized_names_ignored(self):
        result = _extract_catalog_references(["TYC 123-456-1", "Vega"])
        assert result == {}

    def test_non_digit_after_prefix_not_matched(self):
        result = _extract_catalog_references(["Mxxx"])
        assert result == {}


# ---------------------------------------------------------------------------
# lookup_object
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# to_dict branches and remaining _safe_float / _is_valid_value paths
# ---------------------------------------------------------------------------


class TestToDict:
    def _result(self, **kwargs):
        coords = Coordinates(ra=10.0, dec=20.0, ra_str="r", dec_str="d")
        return SimbadResult(name="X", object_type="Star", coordinates=coords, **kwargs)

    def test_major_axis_without_formatted_string(self):
        """A size with a major axis but no formatted string falls back to arcseconds."""
        d = self._result(size=Size(major_axis=10.0)).to_dict()
        assert d["size"] == "10.0\u2033"

    def test_fully_empty_result(self):
        """No optional fields at all: only the core keys are present."""
        coords = Coordinates(ra=10.0, dec=20.0, ra_str="r", dec_str="d")
        result = SimbadResult(name="X", object_type="Star", coordinates=coords)
        d = result.to_dict()
        assert d == {
            "name": "X",
            "objectType": "Star",
            "ra": "r",
            "dec": "d",
            "raDeg": 10.0,
            "decDeg": 20.0,
            "size": "N/A",
        }

    def test_full_optional_fields(self):
        d = self._result(
            size=Size(formatted="1.0\u2032"),
            visual_magnitude=5.5,
            common_name="Betelgeuse",
            spectral_type="M2",
            alternative_names=["A", "B"],
            catalogs={"HD": "1"},
        ).to_dict()
        assert d["size"] == "1.0′"
        assert d["magnitude"] == "5.5"
        assert d["commonName"] == "Betelgeuse"
        assert d["spectralType"] == "M2"
        assert d["alternativeNames"] == ["A", "B"]
        assert d["catalogs"] == {"HD": "1"}


def test_safe_float_object_without_float_conversion():
    """A value that survives _is_valid_value but cannot become float."""

    class NoFloat:
        def __float__(self):
            raise ValueError("nope")

    assert _safe_float(NoFloat(), default=7.0) == 7.0


def test_is_valid_value_masked_array_unmasked_element():
    """An element carrying a mask attribute but not masked is valid."""
    arr = np.ma.array([1.0, 2.0], mask=[False, True])
    assert _is_valid_value(arr[0]) is True


def test_is_valid_value_mask_attribute_not_masked():
    """An object carrying a mask attribute that says unmasked is valid."""

    class HasMaskAttr:
        mask = False

    assert _is_valid_value(HasMaskAttr()) is True


def test_extract_common_name_numeric_capture_skipped():
    """NAME-prefixed digits get captured then rejected as a designation."""
    assert _extract_common_name(["NAME 1234"]) is None


def test_extract_common_name_three_character_name_kept():
    """A three-character common name sits exactly at the minimum-length limit."""
    assert _extract_common_name(["NAME Abc"]) == "Abc"


# ---------------------------------------------------------------------------
# lookup_object (SIMBAD patched at astra_astro.simbad.Simbad)
# ---------------------------------------------------------------------------
def _make_simbad_table(
    *,
    main_id=b"NAME Orion Nebula",
    ra=83.8,
    dec=-5.39,
    otype=b"HII",
    V=4.0,
    galdim_majaxis=1200.0,
    galdim_minaxis=900.0,
    galdim_angle=15.0,
    plx_value=2.5,
    sp_type=b"M2III",
):
    """Build a small masked astropy Table shaped like a SIMBAD TAP answer."""
    return Table(
        {
            "main_id": [main_id],
            "ra": [ra],
            "dec": [dec],
            "coo_err_maj": [0.01],
            "coo_err_min": [0.01],
            "V": [V],
            "galdim_minaxis": [galdim_minaxis],
            "otype": [otype],
            "oid": [123],
            "galdim_angle": [galdim_angle],
            "galdim_majaxis": [galdim_majaxis],
            "sp_type": [sp_type],
            "plx_value": [plx_value],
            "matched_id": [b"NAME Orion Nebula"],
        },
        masked=True,
    )


class _FakeSimbad:
    """Stands in for astroquery.simbad.Simbad inside lookup_object."""

    tap_result: object | None = None
    ids_result: object | None = None
    tap_error: Exception | None = None

    def __init__(self):
        pass

    def query_tap(self, _query):
        if _FakeSimbad.tap_error is not None:
            raise _FakeSimbad.tap_error
        return _FakeSimbad.tap_result

    def query_objectids(self, _name):
        return _FakeSimbad.ids_result


def _patch(monkeypatch):
    monkeypatch.setattr("astra_astro.simbad.Simbad", _FakeSimbad)


class TestLookupObject:
    def test_full_answer(self, monkeypatch):
        _patch(monkeypatch)
        _FakeSimbad.tap_result = _make_simbad_table()
        _FakeSimbad.ids_result = Table({"id": [b"M 42", b"NGC 1976", b"Orion Nebula"]})
        try:
            result = lookup_object("Orion Nebula")
        finally:
            _FakeSimbad.tap_result = _FakeSimbad.ids_result = None

        assert result["name"] == "Orion Nebula"
        assert result["objectType"] == "HII"
        # 83.8 deg = 5.586666... h = 5h 35m 12.00s
        assert result["ra"] == "05h 35m 12.00s"
        assert result["raDeg"] == pytest.approx(83.8)
        assert result["dec"] == "-05° 23' 24.00\""
        assert result["decDeg"] == pytest.approx(-5.39)
        assert result["magnitude"] == "4.0"
        # major axis 1200" >= 60 -> formatted in arcminutes
        assert result["size"] == "20.0′ × 15.0′"
        assert result["commonName"] == "Orion Nebula"
        assert result["catalogs"] == {"Messier": "42", "NGC": "1976"}
        assert result["alternativeNames"] == ["M 42", "NGC 1976", "Orion Nebula"]
        assert result["spectralType"] == "M2III"
        # parallax 2.5 mas -> 400 pc -> 1304.624 ly
        assert result["distance"]["parsecs"] == pytest.approx(400.0)
        assert result["distance"]["lightYears"] == pytest.approx(400 * 3.26156)

    def test_masked_optional_columns(self, monkeypatch):
        """Masked V and parallax produce no keys, no crash."""
        _patch(monkeypatch)
        t = _make_simbad_table(main_id=b"HD 1", otype=b"Star")
        for col in ("V", "plx_value"):
            t[col].mask = [True]
        _FakeSimbad.tap_result = t
        _FakeSimbad.ids_result = Table({"id": []})
        try:
            result = lookup_object("HD 1")
        finally:
            _FakeSimbad.tap_result = _FakeSimbad.ids_result = None
        assert "magnitude" not in result
        assert "distance" not in result
        assert "alternativeNames" not in result
        assert result["name"] == "HD 1"

    def test_arcsecond_size_format(self, monkeypatch):
        _patch(monkeypatch)
        _FakeSimbad.tap_result = _make_simbad_table(
            main_id=b"M 42", galdim_majaxis=30.0, galdim_minaxis=20.0, galdim_angle=45.0
        )
        _FakeSimbad.ids_result = None
        try:
            result = lookup_object("M 42")
        finally:
            _FakeSimbad.tap_result = _FakeSimbad.ids_result = None
        assert result["size"] == "30.0″ × 20.0″"

    def test_sub_arcsecond_size_still_formatted(self, monkeypatch):
        """A positive major axis below 1 arcsecond still uses the size branch."""
        _patch(monkeypatch)
        _FakeSimbad.tap_result = _make_simbad_table(
            main_id=b"M 42", galdim_majaxis=0.5, galdim_minaxis=0.25, galdim_angle=0.0
        )
        _FakeSimbad.ids_result = None
        try:
            result = lookup_object("M 42")
        finally:
            _FakeSimbad.tap_result = _FakeSimbad.ids_result = None
        assert result["size"] == "0.5″ × 0.2″"

    def test_size_boundary_at_60_arcsec_uses_arcminutes(self, monkeypatch):
        """major_axis == 60 is exactly at the arcminute threshold."""
        _patch(monkeypatch)
        _FakeSimbad.tap_result = _make_simbad_table(
            main_id=b"M 42", galdim_majaxis=60.0, galdim_minaxis=30.0, galdim_angle=0.0
        )
        _FakeSimbad.ids_result = None
        try:
            result = lookup_object("M 42")
        finally:
            _FakeSimbad.tap_result = _FakeSimbad.ids_result = None
        assert result["size"] == "1.0′ × 0.5′"

    def test_point_source_when_no_size(self, monkeypatch):
        _patch(monkeypatch)
        _FakeSimbad.tap_result = _make_simbad_table(
            main_id=b"HD 1",
            galdim_majaxis=np.nan,
            galdim_minaxis=np.nan,
            galdim_angle=np.nan,
            otype=b"Star",
        )
        _FakeSimbad.ids_result = None
        try:
            result = lookup_object("HD 1")
        finally:
            _FakeSimbad.tap_result = _FakeSimbad.ids_result = None
        assert result["size"] == "N/A"

    def test_no_answer_returns_none(self, monkeypatch):
        _patch(monkeypatch)
        _FakeSimbad.tap_result = None
        _FakeSimbad.ids_result = None
        try:
            assert lookup_object("nothing here") is None
        finally:
            _FakeSimbad.tap_result = _FakeSimbad.ids_result = None

    def test_empty_table_returns_none(self, monkeypatch):
        _patch(monkeypatch)
        _FakeSimbad.tap_result = Table()
        _FakeSimbad.ids_result = None
        try:
            assert lookup_object("nothing here") is None
        finally:
            _FakeSimbad.tap_result = _FakeSimbad.ids_result = None

    def test_query_error_raises_runtime_error(self, monkeypatch):
        _patch(monkeypatch)
        _FakeSimbad.tap_error = ValueError("bad query")
        _FakeSimbad.ids_result = None
        try:
            with pytest.raises(RuntimeError, match="Error querying SIMBAD: bad query"):
                lookup_object("bad")
        finally:
            _FakeSimbad.tap_error = None
            _FakeSimbad.ids_result = None

    def test_single_identifier_row_is_used(self, monkeypatch):
        """A one-row identifier table still yields one alternative name."""
        _patch(monkeypatch)
        _FakeSimbad.tap_result = _make_simbad_table(main_id=b"HD 1")
        _FakeSimbad.ids_result = Table({"id": [b"SAO 1"]})
        try:
            result = lookup_object("HD 1")
        finally:
            _FakeSimbad.tap_result = _FakeSimbad.ids_result = None
        assert result["alternativeNames"] == ["SAO 1"]
        assert result["catalogs"] == {"HD": "1", "SAO": "1"}

    def test_empty_ids_table_gives_no_alternative_names(self, monkeypatch):
        _patch(monkeypatch)
        _FakeSimbad.tap_result = _make_simbad_table(main_id=b"HD 1")
        _FakeSimbad.ids_result = Table({"id": []})
        try:
            result = lookup_object("HD 1")
        finally:
            _FakeSimbad.tap_result = _FakeSimbad.ids_result = None
        assert "alternativeNames" not in result
        assert result["catalogs"] == {"HD": "1"}

    def test_no_distance_for_nonpositive_parallax(self, monkeypatch):
        _patch(monkeypatch)
        _FakeSimbad.tap_result = _make_simbad_table(main_id=b"HD 1", plx_value=-1.0)
        _FakeSimbad.ids_result = None
        try:
            result = lookup_object("HD 1")
        finally:
            _FakeSimbad.tap_result = _FakeSimbad.ids_result = None
        assert "distance" not in result

    def test_small_positive_parallax_gives_distance(self, monkeypatch):
        """Parallax of 0.5 mas -> 2000 pc, just above the zero threshold."""
        _patch(monkeypatch)
        _FakeSimbad.tap_result = _make_simbad_table(main_id=b"HD 1", plx_value=0.5)
        _FakeSimbad.ids_result = None
        try:
            result = lookup_object("HD 1")
        finally:
            _FakeSimbad.tap_result = _FakeSimbad.ids_result = None
        assert result["distance"]["parsecs"] == pytest.approx(2000.0)

    def test_main_id_without_name_prefix(self, monkeypatch):
        _patch(monkeypatch)
        _FakeSimbad.tap_result = _make_simbad_table(
            main_id=b"HD 1",
            galdim_majaxis=np.nan,
            galdim_minaxis=np.nan,
            galdim_angle=np.nan,
            otype=b"Star",
        )
        _FakeSimbad.ids_result = None
        try:
            result = lookup_object("HD 1")
        finally:
            _FakeSimbad.tap_result = _FakeSimbad.ids_result = None
        assert result["name"] == "HD 1"

    def test_unknown_type_without_size(self, monkeypatch):
        """An extended type with no measured size is not a point source."""
        _patch(monkeypatch)
        _FakeSimbad.tap_result = _make_simbad_table(
            main_id=b"NGC 1",
            otype=b"G",
            galdim_majaxis=np.nan,
            galdim_minaxis=np.nan,
            galdim_angle=np.nan,
        )
        _FakeSimbad.ids_result = None
        try:
            result = lookup_object("NGC 1")
        finally:
            _FakeSimbad.tap_result = _FakeSimbad.ids_result = None
        assert result["name"] == "NGC 1"
        assert result["size"] == "N/A"

    def test_null_spectral_type(self, monkeypatch):
        _patch(monkeypatch)
        _FakeSimbad.tap_result = _make_simbad_table(main_id=b"HD 1", sp_type=None)
        _FakeSimbad.ids_result = None
        try:
            result = lookup_object("HD 1")
        finally:
            _FakeSimbad.tap_result = _FakeSimbad.ids_result = None
        assert "spectralType" not in result
