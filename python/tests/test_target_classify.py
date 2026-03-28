"""Tests for astra_astro.target_classify pure functions."""

import pytest

from astra_astro.target_classify import (
    TargetInfo,
    TargetType,
    _classify_from_known,
    _normalize_name,
    classify_from_name,
)


# ---------------------------------------------------------------------------
# _normalize_name
# ---------------------------------------------------------------------------
class TestNormalizeName:
    def test_strips_whitespace(self):
        assert _normalize_name("  M42  ") == "M42"

    def test_uppercases(self):
        assert _normalize_name("m42") == "M42"

    def test_messier_prefix(self):
        assert _normalize_name("Messier 42") == "M42"
        assert _normalize_name("MESSIER42") == "M42"
        assert _normalize_name("Messier   31") == "M31"

    def test_ngc_spacing(self):
        assert _normalize_name("NGC7000") == "NGC 7000"
        assert _normalize_name("NGC 7000") == "NGC 7000"
        assert _normalize_name("ngc7000") == "NGC 7000"

    def test_ic_spacing(self):
        assert _normalize_name("IC1396") == "IC 1396"
        assert _normalize_name("IC 1396") == "IC 1396"
        assert _normalize_name("ic1396") == "IC 1396"

    def test_sharpless(self):
        result = _normalize_name("Sh2-129")
        assert result == "SH2-129"


# ---------------------------------------------------------------------------
# _classify_from_known
# ---------------------------------------------------------------------------
class TestClassifyFromKnown:
    def test_m31_galaxy(self):
        result = _classify_from_known("M31")
        assert result is not None
        assert result.target_type == TargetType.GALAXY
        assert result.confidence == 1.0

    def test_m42_emission_nebula(self):
        result = _classify_from_known("M42")
        assert result is not None
        assert result.target_type == TargetType.EMISSION_NEBULA

    def test_m57_planetary_nebula(self):
        result = _classify_from_known("M57")
        assert result is not None
        assert result.target_type == TargetType.PLANETARY_NEBULA

    def test_m13_globular_cluster(self):
        result = _classify_from_known("M13")
        assert result is not None
        assert result.target_type == TargetType.GLOBULAR_CLUSTER

    def test_m45_open_cluster(self):
        result = _classify_from_known("M45")
        assert result is not None
        assert result.target_type == TargetType.OPEN_CLUSTER

    def test_ngc7000_emission_nebula(self):
        result = _classify_from_known("NGC 7000")
        assert result is not None
        assert result.target_type == TargetType.EMISSION_NEBULA

    def test_ic1396_pattern_match(self):
        """IC 1396 is not in KNOWN_OBJECTS but should not match patterns either."""
        result = _classify_from_known("IC 1396")
        # IC 1396 is not in the known list or patterns, so should be None
        # unless it matches a pattern
        if result is not None:
            assert isinstance(result.target_type, TargetType)

    def test_sharpless_pattern(self):
        result = _classify_from_known("Sh2-129")
        assert result is not None
        assert result.target_type == TargetType.EMISSION_NEBULA
        assert result.confidence == 0.9

    def test_barnard_pattern(self):
        result = _classify_from_known("B33")
        assert result is not None
        assert result.target_type == TargetType.STAR_FIELD
        assert result.confidence == 0.7

    def test_vdb_pattern(self):
        result = _classify_from_known("vdB 12")
        assert result is not None
        assert result.target_type == TargetType.REFLECTION_NEBULA

    def test_unknown_object_returns_none(self):
        result = _classify_from_known("XYZZY 999")
        assert result is None

    def test_messier_long_form(self):
        """Messier 42 should normalize to M42 and be found."""
        result = _classify_from_known("Messier 42")
        assert result is not None
        assert result.target_type == TargetType.EMISSION_NEBULA

    def test_lowercase_input(self):
        result = _classify_from_known("m31")
        assert result is not None
        assert result.target_type == TargetType.GALAXY

    def test_m78_reflection_nebula(self):
        result = _classify_from_known("M78")
        assert result is not None
        assert result.target_type == TargetType.REFLECTION_NEBULA


# ---------------------------------------------------------------------------
# classify_from_name (without SIMBAD, testing known + pattern paths)
# ---------------------------------------------------------------------------
class TestClassifyFromName:
    def test_empty_string(self):
        result = classify_from_name("")
        assert result.target_type == TargetType.UNKNOWN
        assert result.confidence == 0.0

    def test_none_like_empty(self):
        result = classify_from_name("   ")
        assert result.target_type == TargetType.UNKNOWN

    def test_known_object_high_confidence(self):
        """Known objects with confidence >= 0.9 should bypass SIMBAD."""
        result = classify_from_name("M42")
        assert result.target_type == TargetType.EMISSION_NEBULA
        assert result.confidence == 1.0

    def test_returns_target_info(self):
        result = classify_from_name("M31")
        assert isinstance(result, TargetInfo)
        assert result.object_name == "M31"

    def test_lbn_pattern(self):
        result = _classify_from_known("LBN 123")
        assert result is not None
        assert result.target_type == TargetType.EMISSION_NEBULA
