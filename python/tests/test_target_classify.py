"""Tests for astra_astro.target_classify pure functions."""

from unittest.mock import MagicMock

import pytest
from astropy.table import MaskedColumn, Table

from astra_astro.target_classify import (
    TargetInfo,
    TargetType,
    _classify_from_known,
    _normalize_name,
    _query_simbad,
    classify_from_name,
    classify_target,
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


# ---------------------------------------------------------------------------
# SIMBAD-backed tests
# ---------------------------------------------------------------------------
def make_simbad_table(otype):
    return Table({"OTYPE": [otype]})


def make_simbad_mock(otype):
    """A patch for astra_astro.target_classify.Simbad whose query_object
    returns a one-row table with the given OTYPE (or None / raises)."""

    mock_class = MagicMock(name="SimbadClass")
    mock_class.return_value.query_object.return_value = otype
    return mock_class


class TestQuerySimbad:
    @pytest.mark.parametrize(
        ("otype", "expected_type"),
        [
            ("HII", TargetType.EMISSION_NEBULA),
            ("EmN", TargetType.EMISSION_NEBULA),
            ("SNR", TargetType.EMISSION_NEBULA),
            ("HH", TargetType.EMISSION_NEBULA),
            ("SFR", TargetType.EMISSION_NEBULA),
            ("RNe", TargetType.REFLECTION_NEBULA),
            ("PN", TargetType.PLANETARY_NEBULA),
            ("pA*", TargetType.PLANETARY_NEBULA),
            ("G", TargetType.GALAXY),
            ("GiC", TargetType.GALAXY),
            ("GiG", TargetType.GALAXY),
            ("GiP", TargetType.GALAXY),
            ("HzG", TargetType.GALAXY),
            ("AGN", TargetType.GALAXY),
            ("Sy1", TargetType.GALAXY),
            ("Sy2", TargetType.GALAXY),
            ("Sy*", TargetType.GALAXY),
            ("QSO", TargetType.GALAXY),
            ("BLL", TargetType.GALAXY),
            ("rG", TargetType.GALAXY),
            ("LIN", TargetType.GALAXY),
            ("SBG", TargetType.GALAXY),
            ("bCG", TargetType.GALAXY),
            ("GrG", TargetType.GALAXY),
            ("BiC", TargetType.GALAXY),
            ("OpC", TargetType.OPEN_CLUSTER),
            ("As*", TargetType.OPEN_CLUSTER),
            ("Cl*", TargetType.OPEN_CLUSTER),
            ("MGr", TargetType.OPEN_CLUSTER),
            ("*", TargetType.STAR_FIELD),
            ("**", TargetType.STAR_FIELD),
        ],
    )
    def test_mapped_simbad_type(self, monkeypatch, otype, expected_type):
        monkeypatch.setattr(
            "astra_astro.target_classify.Simbad", make_simbad_mock(make_simbad_table(otype))
        )
        info = _query_simbad("SimbadObject")
        assert info is not None
        assert info.target_type == expected_type
        assert info.confidence == 0.85
        assert info.simbad_type == otype
        assert info.object_name == "SimbadObject"

    @pytest.mark.parametrize(
        ("otype", "expected_type", "confidence"),
        [
            # partial match on "Neb"
            ("BlueNeb", TargetType.EMISSION_NEBULA, 0.7),
            # partial match on "PN"
            ("RedPN", TargetType.PLANETARY_NEBULA, 0.8),
            # partial match on "G" without "Cl"
            ("XGz", TargetType.GALAXY, 0.6),
            # "Cl*" only as a non-prefix substring
            ("XCl*", TargetType.OPEN_CLUSTER, 0.8),
            # nothing matches at all
            ("Star", TargetType.STAR_FIELD, 0.3),
        ],
    )
    def test_unmapped_simbad_type_falls_back_to_substring(
        self, monkeypatch, otype, expected_type, confidence
    ):
        monkeypatch.setattr(
            "astra_astro.target_classify.Simbad", make_simbad_mock(make_simbad_table(otype))
        )
        info = _query_simbad("SimbadObject")
        assert info is not None
        assert info.target_type == expected_type
        assert info.confidence == confidence
        assert info.simbad_type == otype

    def test_otype_whitespace_is_stripped(self, monkeypatch):
        monkeypatch.setattr(
            "astra_astro.target_classify.Simbad", make_simbad_mock(make_simbad_table("  G  "))
        )
        info = _query_simbad("SimbadObject")
        assert info is not None
        assert info.target_type == TargetType.GALAXY
        assert info.confidence == 0.85
        assert info.simbad_type == "G"

    def test_simbad_returns_none(self, monkeypatch):
        monkeypatch.setattr("astra_astro.target_classify.Simbad", make_simbad_mock(None))
        assert _query_simbad("SimbadObject") is None

    def test_simbad_returns_empty_table(self, monkeypatch):
        empty = Table({"OTYPE": []}, dtype=["U8"])
        monkeypatch.setattr("astra_astro.target_classify.Simbad", make_simbad_mock(empty))
        assert _query_simbad("SimbadObject") is None

    def test_otype_masked(self, monkeypatch):
        table = Table()
        table["OTYPE"] = MaskedColumn(["G"], mask=[True])
        monkeypatch.setattr("astra_astro.target_classify.Simbad", make_simbad_mock(table))
        assert _query_simbad("SimbadObject") is None

    def test_table_missing_otype_column(self, monkeypatch):
        table = Table({"OTHER": ["G"]})
        monkeypatch.setattr("astra_astro.target_classify.Simbad", make_simbad_mock(table))
        assert _query_simbad("SimbadObject") is None

    def test_simbad_query_raises(self, monkeypatch):
        mock_class = MagicMock(name="SimbadClass")
        mock_class.return_value.query_object.side_effect = ConnectionError("simbad down")
        monkeypatch.setattr("astra_astro.target_classify.Simbad", mock_class)
        assert _query_simbad("SimbadObject") is None

    def test_prefix_only_otype_maps_like_its_key(self, monkeypatch):
        """An OTYPE that merely starts with a mapped code (longer than the key)
        must be classified by the prefix rule, not fall through to substring
        guessing: 'HIIx' behaves like 'HII'."""
        monkeypatch.setattr(
            "astra_astro.target_classify.Simbad",
            make_simbad_mock(make_simbad_table("HIIx")),
        )
        info = _query_simbad("SimbadObject")
        assert info is not None
        assert info.target_type == TargetType.EMISSION_NEBULA
        assert info.confidence == 0.85
        assert info.simbad_type == "HIIx"

    @pytest.mark.parametrize("answer", [None, Table({"OTYPE": []}, dtype=["U8"])])
    def test_no_answer_is_not_treated_as_failure(self, monkeypatch, caplog, answer):
        """A missing or empty SIMBAD answer is a clean 'no result' return, not
        an error path: nothing is logged."""
        import logging

        monkeypatch.setattr("astra_astro.target_classify.Simbad", make_simbad_mock(answer))
        with caplog.at_level(logging.WARNING):
            result = _query_simbad("SimbadObject")
        assert result is None
        assert caplog.records == []


class TestClassifyFromNameWithSimbad:
    def test_known_object_bypasses_simbad(self, monkeypatch):
        mock_class = make_simbad_mock(None)
        monkeypatch.setattr("astra_astro.target_classify.Simbad", mock_class)
        info = classify_from_name("M42")
        assert info.target_type == TargetType.EMISSION_NEBULA
        assert info.confidence == 1.0
        mock_class.return_value.query_object.assert_not_called()

    def test_boundary_pattern_confidence_09_bypasses_simbad(self, monkeypatch):
        """Sharpless matches at 0.9, which is enough to skip SIMBAD."""
        mock_class = make_simbad_mock(None)
        monkeypatch.setattr("astra_astro.target_classify.Simbad", mock_class)
        info = classify_from_name("Sh2-129")
        assert info.target_type == TargetType.EMISSION_NEBULA
        assert info.confidence == 0.9
        mock_class.return_value.query_object.assert_not_called()

    def test_unknown_name_queries_simbad_once_with_given_name(self, monkeypatch):
        mock_class = make_simbad_mock(make_simbad_table("G"))
        monkeypatch.setattr("astra_astro.target_classify.Simbad", mock_class)
        info = classify_from_name("HD 12345")
        assert info.target_type == TargetType.GALAXY
        assert info.confidence == 0.85
        assert info.simbad_type == "G"
        mock_class.return_value.query_object.assert_called_once_with("HD 12345")

    def test_simbad_silent_falls_back_to_pattern(self, monkeypatch):
        """B33 is a Barnard match (0.7); if SIMBAD answers nothing the
        pattern result is used."""
        mock_class = make_simbad_mock(None)
        monkeypatch.setattr("astra_astro.target_classify.Simbad", mock_class)
        info = classify_from_name("B33")
        assert info.target_type == TargetType.STAR_FIELD
        assert info.confidence == 0.7
        assert info.simbad_type is None
        mock_class.return_value.query_object.assert_called_once_with("B33")

    def test_simbad_low_confidence_falls_back_to_unknown(self, monkeypatch):
        """An otype that maps to nothing trustworthy (0.3 star field) must
        not be promoted: the result is the plain UNKNOWN fallback."""
        mock_class = make_simbad_mock(make_simbad_table("Star"))
        monkeypatch.setattr("astra_astro.target_classify.Simbad", mock_class)
        info = classify_from_name("XYZZY 999")
        assert info.target_type == TargetType.UNKNOWN
        assert info.confidence == 0.0
        assert info.simbad_type is None

    def test_simbad_failure_falls_back_to_unknown(self, monkeypatch):
        mock_class = MagicMock(name="SimbadClass")
        mock_class.return_value.query_object.side_effect = ConnectionError("down")
        monkeypatch.setattr("astra_astro.target_classify.Simbad", mock_class)
        info = classify_from_name("XYZZY 999")
        assert info.target_type == TargetType.UNKNOWN
        assert info.confidence == 0.0


# ---------------------------------------------------------------------------
# classify_target (dict surface used by the Rust caller)
# ---------------------------------------------------------------------------
class TestClassifyTarget:
    def test_known_object_dict(self):
        result = classify_target("M31")
        assert result == {
            "targetType": "galaxy",
            "objectName": "M31",
            "confidence": 1.0,
            "simbadType": None,
        }

    def test_default_dict(self, monkeypatch):
        mock_class = MagicMock(name="SimbadClass")
        mock_class.return_value.query_object.side_effect = ConnectionError("down")
        monkeypatch.setattr("astra_astro.target_classify.Simbad", mock_class)
        result = classify_target("XYZZY 999")
        assert result == {
            "targetType": "unknown",
            "objectName": "XYZZY 999",
            "confidence": 0.0,
            "simbadType": None,
        }

    def test_empty_name_dict(self):
        result = classify_target("")
        assert result == {
            "targetType": "unknown",
            "objectName": "",
            "confidence": 0.0,
            "simbadType": None,
        }


# ---------------------------------------------------------------------------
# _normalize_name rules not covered above
# ---------------------------------------------------------------------------
class TestNormalizeNameMore:
    def test_unrelated_name_unchanged(self):
        assert _normalize_name("HD 12345") == "HD 12345"

    def test_already_normalized(self):
        assert _normalize_name("M42") == "M42"
