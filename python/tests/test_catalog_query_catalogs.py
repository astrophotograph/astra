"""Tests for the per-catalog query functions in astra_astro.catalog_query."""

from types import SimpleNamespace

import numpy as np
import numpy.testing as npt
import pytest
from astropy.table import Table

import astra_astro.catalog_query as cq
from astra_astro.catalog_query import (
    CatalogObject,
    query_abell,
    query_barnard,
    query_bright_stars,
    query_lbn,
    query_ldn,
    query_messier,
    query_ngc_ic,
    query_pgc,
    query_sharpless,
)

CENTER_RA = 150.0
CENTER_DEC = 20.0
RADIUS = 1.0


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------
@pytest.fixture
def vizier(monkeypatch):
    """Replace Vizier with a stub whose behaviour the test configures.

    holder.tables: the list of Tables query_region returns.
    holder.error: if set, query_region raises it.
    holder.v: the single Vizier instance the function created (or None).
    """
    holder = SimpleNamespace(tables=None, error=None, instances=[])
    state = SimpleNamespace(tables=None, error=None)

    class _FakeVizier:
        ROW_LIMIT = -1

        def __init__(self, columns=None):
            self.columns = columns
            self.ROW_LIMIT = -1
            holder.instances.append(self)

        def query_region(self, coord, radius=None, catalog=None, column_filters=None):
            self.last_call = {
                "coord": coord,
                "radius": radius,
                "catalog": catalog,
                "column_filters": column_filters,
            }
            if state.error is not None:
                raise state.error
            return state.tables

    state.cls = _FakeVizier
    monkeypatch.setattr(cq, "Vizier", _FakeVizier)
    holder.v = None
    holder.query_calls = []

    def configure(tables=None, error=None):
        state.tables = tables
        state.error = error

    holder.configure = configure
    return holder


@pytest.fixture
def simbad(monkeypatch):
    """Replace Simbad with a stub whose query_tap behaviour the test configures."""
    holder = SimpleNamespace(query=None)
    state = SimpleNamespace(tables=None, error=None)

    class _FakeSimbad:
        def query_tap(self, query):
            holder.query = query
            if state.error is not None:
                raise state.error
            # Real query_tap returns a single Table (or None), not a list.
            if state.tables is None:
                return None
            return state.tables[0] if state.tables else None

    def configure(tables=None, error=None):
        state.tables = tables
        state.error = error

    monkeypatch.setattr(cq, "Simbad", _FakeSimbad)
    holder.configure = configure
    return holder


def table(**cols):
    return Table(cols)


def masked_table(cols, masks):
    """Build a Table with some entries masked.

    cols: dict of column name -> list of values
    masks: dict of column name -> list of bools (True = masked)
    """
    t = Table(cols, masked=True)
    for name, m in masks.items():
        t[name].mask = m
    return t


# ---------------------------------------------------------------------------
# query_ngc_ic
# ---------------------------------------------------------------------------
class TestQueryNgcIc:
    def test_ngc_ic_and_ngc_prefixed_names(self, vizier):
        """Names '123', 'I456' and 'IC789' become NGC/IC objects."""
        vizier.configure(
            tables=[
                table(
                    Name=["123", "I456", "IC789"],
                    Type=["G", "G", "G"],
                    RAJ2000=[150.1, 150.2, 150.3],
                    DEJ2000=[20.1, 20.2, 20.3],
                    Bmag=[9.5, 10.5, 11.5],
                    MajAx=[90.0, 5.5, 0.5],
                )
            ]
        )
        objs = query_ngc_ic(CENTER_RA, CENTER_DEC, RADIUS)

        assert [o.name for o in objs] == ["NGC 123", "IC 456", "IC789"]
        assert [o.catalog for o in objs] == ["NGC", "IC", "IC"]
        assert [o.object_type for o in objs] == ["G", "G", "G"]
        npt.assert_allclose([o.ra for o in objs], [150.1, 150.2, 150.3])
        npt.assert_allclose([o.dec for o in objs], [20.1, 20.2, 20.3])
        npt.assert_allclose([o.magnitude for o in objs], [9.5, 10.5, 11.5])
        # MajAx arcmin: 90 -> "1.5°", 5.5 -> "5.5'", 0.5 -> 30"
        assert [o.size for o in objs] == ["1.5°", "5.5'", '30"']
        npt.assert_allclose([o.size_arcmin for o in objs], [90.0, 5.5, 0.5])

    def test_name_already_ngc_prefixed_kept(self, vizier):
        vizier.configure(tables=[table(Name=["NGC 42"], RAJ2000=[150.0], DEJ2000=[20.0])])
        (obj,) = query_ngc_ic(CENTER_RA, CENTER_DEC, RADIUS)
        assert obj.name == "NGC 42"
        assert obj.catalog == "NGC"

    def test_sexagesimal_coordinates_used_when_decimal_missing(self, vizier):
        """No RAJ2000/DEJ2000 columns: RAB2000/DEB2000 parsed as sexagesimal."""
        vizier.configure(
            tables=[
                table(
                    Name=["100"],
                    RAB2000=["10 00 00"],
                    DEB2000=["+30 15 00"],
                )
            ]
        )
        (obj,) = query_ngc_ic(CENTER_RA, CENTER_DEC, RADIUS)
        npt.assert_allclose(obj.ra, 10 * 15.0, atol=1e-6)
        npt.assert_allclose(obj.dec, 30.25, atol=1e-6)

    def test_rows_with_unusable_coordinates_skipped(self, vizier):
        vizier.configure(
            tables=[
                table(
                    Name=["1", "2"],
                    RAJ2000=[150.1, np.ma.masked],
                    DEJ2000=[20.1, 20.2],
                )
            ]
        )
        objs = query_ngc_ic(CENTER_RA, CENTER_DEC, RADIUS)
        assert [o.name for o in objs] == ["NGC 1"]
        npt.assert_allclose(objs[0].ra, 150.1)

    def test_table_without_any_name_column_gives_no_objects(self, vizier):
        vizier.configure(tables=[table(Type=["G"], RAJ2000=[150.1], DEJ2000=[20.1])])
        assert query_ngc_ic(CENTER_RA, CENTER_DEC, RADIUS) == []

    def test_no_type_column_gives_unknown(self, vizier):
        vizier.configure(tables=[table(Name=["5"], RAJ2000=[150.0], DEJ2000=[20.0])])
        (obj,) = query_ngc_ic(CENTER_RA, CENTER_DEC, RADIUS)
        assert obj.object_type == "Unknown"
        assert obj.magnitude is None
        assert obj.size is None
        assert obj.size_arcmin is None

    def test_none_and_empty_results(self, vizier):
        vizier.configure(tables=None)
        assert query_ngc_ic(CENTER_RA, CENTER_DEC, RADIUS) == []
        vizier.configure(tables=[])
        assert query_ngc_ic(CENTER_RA, CENTER_DEC, RADIUS) == []

    def test_empty_table_returns_empty_list(self, vizier):
        vizier.configure(tables=[table(Name=[], RAJ2000=[], DEJ2000=[])])
        assert query_ngc_ic(CENTER_RA, CENTER_DEC, RADIUS) == []

    def test_query_exception_returns_empty_list(self, vizier):
        vizier.configure(error=RuntimeError("vizier down"))
        assert query_ngc_ic(CENTER_RA, CENTER_DEC, RADIUS) == []

    def test_query_region_called_with_expected_catalog_and_radius(self, vizier):
        vizier.configure(tables=[])
        query_ngc_ic(CENTER_RA, CENTER_DEC, 2.0)
        vizier.v = vizier.instances[0]
        call = vizier.v.last_call
        assert call["catalog"] == "VII/118/ngc2000"
        npt.assert_allclose(call["radius"].to_value("deg"), 2.0)
        assert vizier.v.ROW_LIMIT == 500

    def test_masked_decimal_ra_falls_back_to_next_column(self, vizier):
        """A masked RAJ2000 makes the code try _RAJ2000 instead."""
        vizier.configure(
            tables=[
                masked_table(
                    {
                        "Name": ["9"],
                        "RAJ2000": [None],
                        "_RAJ2000": [150.7],
                        "DEJ2000": [20.0],
                    },
                    {"RAJ2000": [True]},
                )
            ]
        )
        (obj,) = query_ngc_ic(CENTER_RA, CENTER_DEC, RADIUS)
        npt.assert_allclose(obj.ra, 150.7)


# ---------------------------------------------------------------------------
# query_messier
# ---------------------------------------------------------------------------
class TestQueryMessier:
    def make_table(self):
        return table(
            main_id=["M 31", "M 13", "NGC 224"],
            ra=[10.1, 250.4, 10.7],
            dec=[41.2, 36.5, 41.3],
            otype=["G", "GlC", "G"],
            galdim_majaxis=[180.0, 20.0, 190.0],
        )

    def test_rows_become_messier_objects_with_known_magnitudes(self, simbad):
        simbad.configure(tables=[self.make_table()])
        objs = query_messier(CENTER_RA, CENTER_DEC, RADIUS)

        # The 'NGC 224' row carries no M identifier and must be dropped.
        assert [o.name for o in objs] == ["M31", "M13"]
        assert all(o.catalog == "Messier" for o in objs)
        assert [o.object_type for o in objs] == ["G", "GlC"]
        assert objs[0].magnitude == 3.4  # M31 from the known-magnitude table
        assert objs[1].magnitude == 5.8  # M13
        npt.assert_allclose([o.ra for o in objs], [10.1, 250.4])
        npt.assert_allclose([o.dec for o in objs], [41.2, 36.5])
        npt.assert_allclose([o.size_arcmin for o in objs], [180.0, 20.0])
        assert objs[0].size == "3.0°"
        assert objs[1].size == "20.0'"

    def test_unknown_messier_number_has_no_magnitude(self, simbad):
        simbad.configure(
            tables=[
                table(
                    main_id=["M 9999"],
                    ra=[10.0],
                    dec=[41.0],
                    otype=["G"],
                    galdim_majaxis=[np.ma.masked],
                )
            ]
        )
        (obj,) = query_messier(CENTER_RA, CENTER_DEC, RADIUS)
        assert obj.name == "M9999"
        assert obj.magnitude is None
        assert obj.size is None
        assert obj.size_arcmin is None

    def test_query_sent_to_simbad_contains_coordinates(self, simbad):
        simbad.configure(tables=[])
        query_messier(101.5, -2.25, 3.0)
        assert "CIRCLE('ICRS', 101.5, -2.25, 3.0)" in simbad.query
        assert "FROM basic" in simbad.query

    def test_bad_coordinates_row_skipped(self, simbad):
        simbad.configure(
            tables=[
                table(
                    main_id=["M 1", "M 2"],
                    ra=[10.0, np.ma.masked],
                    dec=[41.0, 41.0],
                    otype=["", "G"],
                    galdim_majaxis=[5.0, 5.0],
                )
            ]
        )
        objs = query_messier(CENTER_RA, CENTER_DEC, RADIUS)
        assert [o.name for o in objs] == ["M1"]
        assert objs[0].object_type == "Unknown"

    def test_none_and_empty_results(self, simbad):
        simbad.configure(tables=None)
        assert query_messier(CENTER_RA, CENTER_DEC, RADIUS) == []
        simbad.configure(tables=[table(main_id=[], ra=[], dec=[], otype=[])])
        assert query_messier(CENTER_RA, CENTER_DEC, RADIUS) == []

    def test_query_exception_returns_empty_list(self, simbad):
        simbad.configure(error=RuntimeError("tap down"))
        assert query_messier(CENTER_RA, CENTER_DEC, RADIUS) == []


# ---------------------------------------------------------------------------
# Shared shape: number-based Vizier catalogs
# ---------------------------------------------------------------------------
SIMPLE_CATALOGS = [
    (query_barnard, "VII/220A", "Barn", "B ", "Barnard", "Dark Nebula", "_RAJ2000", "_DEJ2000"),
    (query_ldn, "VII/7A", "LDN", "LDN ", "LDN", "Dark Nebula", "_RAJ2000", "_DEJ2000"),
    (query_sharpless, "VII/20", "Sh2", "Sh2-", "Sharpless", "HII Region", "_RAJ2000", "_DEJ2000"),
    (query_abell, "VII/110A", "ACO", "Abell ", "Abell", "Galaxy Cluster", "_RAJ2000", "_DEJ2000"),
]


class TestSimpleNumberCatalogs:
    @pytest.mark.parametrize(
        "func,catalog_code,num_col,prefix,expected_catalog,expected_type,ra_col,dec_col",
        SIMPLE_CATALOGS,
        ids=["barnard", "ldn", "sharpless", "abell"],
    )
    def test_rows_become_objects(
        self,
        vizier,
        func,
        catalog_code,
        num_col,
        prefix,
        expected_catalog,
        expected_type,
        ra_col,
        dec_col,
    ):
        vizier.configure(
            tables=[
                table(
                    **{
                        num_col: ["42", "77"],
                        ra_col: [150.1, 150.2],
                        dec_col: [20.1, 20.2],
                    }
                )
            ]
        )
        objs = func(CENTER_RA, CENTER_DEC, RADIUS)
        assert [o.name for o in objs] == [f"{prefix}42", f"{prefix}77"]
        assert [o.catalog for o in objs] == [expected_catalog, expected_catalog]
        assert [o.object_type for o in objs] == [expected_type, expected_type]
        npt.assert_allclose([o.ra for o in objs], [150.1, 150.2])
        npt.assert_allclose([o.dec for o in objs], [20.1, 20.2])
        assert objs[0].magnitude is None
        assert objs[0].size is None

    @pytest.mark.parametrize(
        "func,catalog_code,num_col,prefix,expected_catalog,expected_type,ra_col,dec_col",
        SIMPLE_CATALOGS,
        ids=["barnard", "ldn", "sharpless", "abell"],
    )
    def test_queries_the_right_vizier_catalog(
        self,
        vizier,
        func,
        catalog_code,
        num_col,
        prefix,
        expected_catalog,
        expected_type,
        ra_col,
        dec_col,
    ):
        vizier.configure(tables=[])
        func(CENTER_RA, CENTER_DEC, RADIUS)
        v = vizier.instances[0]
        assert v.last_call["catalog"] == catalog_code
        npt.assert_allclose(v.last_call["radius"].to_value("deg"), RADIUS)

    @pytest.mark.parametrize(
        "func,catalog_code,num_col,prefix,expected_catalog,expected_type,ra_col,dec_col",
        SIMPLE_CATALOGS,
        ids=["barnard", "ldn", "sharpless", "abell"],
    )
    def test_rows_with_unusable_coordinates_skipped(
        self,
        vizier,
        func,
        catalog_code,
        num_col,
        prefix,
        expected_catalog,
        expected_type,
        ra_col,
        dec_col,
    ):
        vizier.configure(
            tables=[
                table(
                    **{
                        num_col: ["1", "2"],
                        ra_col: [150.1, np.ma.masked],
                        dec_col: [20.1, 20.2],
                    }
                )
            ]
        )
        objs = func(CENTER_RA, CENTER_DEC, RADIUS)
        assert [o.name for o in objs] == [f"{prefix}1"]

    @pytest.mark.parametrize(
        "func,catalog_code,num_col,prefix,expected_catalog,expected_type,ra_col,dec_col",
        SIMPLE_CATALOGS,
        ids=["barnard", "ldn", "sharpless", "abell"],
    )
    def test_table_without_number_column_gives_no_objects(
        self,
        vizier,
        func,
        catalog_code,
        num_col,
        prefix,
        expected_catalog,
        expected_type,
        ra_col,
        dec_col,
    ):
        vizier.configure(tables=[table(**{ra_col: [150.1], dec_col: [20.1]})])
        assert func(CENTER_RA, CENTER_DEC, RADIUS) == []

    @pytest.mark.parametrize(
        "func,catalog_code,num_col,prefix,expected_catalog,expected_type,ra_col,dec_col",
        SIMPLE_CATALOGS,
        ids=["barnard", "ldn", "sharpless", "abell"],
    )
    def test_none_empty_and_error_results(
        self,
        vizier,
        func,
        catalog_code,
        num_col,
        prefix,
        expected_catalog,
        expected_type,
        ra_col,
        dec_col,
    ):
        vizier.configure(tables=None)
        assert func(CENTER_RA, CENTER_DEC, RADIUS) == []
        vizier.configure(tables=[table(**{num_col: [], ra_col: [], dec_col: []})])
        assert func(CENTER_RA, CENTER_DEC, RADIUS) == []
        vizier.configure(error=RuntimeError("down"))
        assert func(CENTER_RA, CENTER_DEC, RADIUS) == []


class TestSizeColumns:
    """Barnard/Sharpless/Abell pick a size or magnitude column when present."""

    def test_barnard_diam_column_formatted(self, vizier):
        vizier.configure(
            tables=[
                masked_table(
                    {
                        "Barn": ["1", "2", "3"],
                        "_RAJ2000": [150.0] * 3,
                        "_DEJ2000": [20.0] * 3,
                        "Diam": [72.0, 4.0, None],
                    },
                    {"Diam": [False, False, True]},
                )
            ]
        )
        objs = query_barnard(CENTER_RA, CENTER_DEC, RADIUS)
        assert [o.size for o in objs] == ["1.2°", "4.0'", None]
        assert [o.size_arcmin for o in objs[:2]] == [72.0, 4.0]
        assert objs[2].size_arcmin is None

    def test_barnard_masked_first_columns_fall_back_to_alternatives(self, vizier):
        """Masked _RAJ2000/_DEJ2000/Diam each fall back to the next candidate."""
        vizier.configure(
            tables=[
                masked_table(
                    {
                        "Barn": ["7"],
                        "_RAJ2000": [None],
                        "RAJ2000": [150.5],
                        "_DEJ2000": [None],
                        "DEJ2000": [20.5],
                        "Diam": [None],
                        "Size": [4.0],
                    },
                    {"_RAJ2000": [True], "_DEJ2000": [True], "Diam": [True]},
                )
            ]
        )
        (obj,) = query_barnard(CENTER_RA, CENTER_DEC, RADIUS)
        npt.assert_allclose(obj.ra, 150.5)
        npt.assert_allclose(obj.dec, 20.5)
        assert obj.size == "4.0'"
        npt.assert_allclose(obj.size_arcmin, 4.0)

    def test_sharpless_masked_diam_falls_back_to_majax(self, vizier):
        """A masked Diam makes the code use MajAx for the size."""
        vizier.configure(
            tables=[
                masked_table(
                    {
                        "Sh2": ["5"],
                        "_RAJ2000": [150.0],
                        "_DEJ2000": [20.0],
                        "Diam": [None],
                        "MajAx": [2.5],
                    },
                    {"Diam": [True]},
                )
            ]
        )
        (obj,) = query_sharpless(CENTER_RA, CENTER_DEC, RADIUS)
        assert obj.size == "2.5'"
        npt.assert_allclose(obj.size_arcmin, 2.5)

    def test_abell_m10_magnitude(self, vizier):
        vizier.configure(
            tables=[table(ACO=["1656"], _RAJ2000=[150.0], _DEJ2000=[20.0], m10=[13.2])]
        )
        (obj,) = query_abell(CENTER_RA, CENTER_DEC, RADIUS)
        assert obj.name == "Abell 1656"
        npt.assert_allclose(obj.magnitude, 13.2)

    def test_abell_masked_dec_falls_back_to_next_column(self, vizier):
        vizier.configure(
            tables=[
                masked_table(
                    {
                        "ACO": ["4"],
                        "_RAJ2000": [150.0],
                        "_DEJ2000": [None],
                        "DEJ2000": [21.5],
                    },
                    {"_DEJ2000": [True]},
                )
            ]
        )
        (obj,) = query_abell(CENTER_RA, CENTER_DEC, RADIUS)
        npt.assert_allclose(obj.dec, 21.5)


# ---------------------------------------------------------------------------
# query_ldn / query_lbn: area -> size and sexagesimal fallbacks
# ---------------------------------------------------------------------------
class TestLdnArea:
    def test_area_converted_to_diameter(self, vizier):
        """Area 4 sq deg -> diameter 2 deg -> 120 arcmin -> '2.0°'."""
        vizier.configure(tables=[table(LDN=["778"], _RAJ2000=[150.0], _DEJ2000=[20.0], Area=[4.0])])
        (obj,) = query_ldn(CENTER_RA, CENTER_DEC, RADIUS)
        npt.assert_allclose(obj.size_arcmin, 120.0)
        assert obj.size == "2.0°"

    def test_zero_area_gives_no_size(self, vizier):
        vizier.configure(tables=[table(LDN=["1"], _RAJ2000=[150.0], _DEJ2000=[20.0], Area=[0.0])])
        (obj,) = query_ldn(CENTER_RA, CENTER_DEC, RADIUS)
        assert obj.size is None
        assert obj.size_arcmin is None

    def test_sexagesimal_fallback_when_decimal_columns_missing(self, vizier):
        vizier.configure(
            tables=[
                table(
                    LDN=["10"],
                    **{"_RA.icrs": ["10 30 00"], "_DE.icrs": ["-05 30 00"]},
                    Area=[1.0],
                )
            ]
        )
        (obj,) = query_ldn(CENTER_RA, CENTER_DEC, RADIUS)
        npt.assert_allclose(obj.ra, 10 * 15 + 30 * 0.25, atol=1e-6)
        npt.assert_allclose(obj.dec, -(5.5), atol=1e-6)

    def test_unparseable_sexagesimal_falls_back_to_next_column(self, vizier):
        vizier.configure(
            tables=[
                table(
                    LDN=["11"],
                    **{"_RA.icrs": ["not a coordinate"], "RA1950": ["10 30 00"]},
                    _DEJ2000=[20.0],
                )
            ]
        )
        (obj,) = query_ldn(CENTER_RA, CENTER_DEC, RADIUS)
        npt.assert_allclose(obj.ra, 10 * 15 + 30 * 0.25, atol=1e-6)

    def test_masked_area_falls_back_to_size_column(self, vizier):
        vizier.configure(
            tables=[
                masked_table(
                    {
                        "LDN": ["12"],
                        "_RAJ2000": [150.0],
                        "_DEJ2000": [20.0],
                        "Area": [None],
                        "Size": [4.0],
                    },
                    {"Area": [True]},
                )
            ]
        )
        (obj,) = query_ldn(CENTER_RA, CENTER_DEC, RADIUS)
        npt.assert_allclose(obj.size_arcmin, 120.0)


class TestLbn:
    def test_lbn_number_used(self, vizier):
        vizier.configure(
            tables=[
                table(
                    LBN=["123"],
                    Seq=[456.0],
                    _RAJ2000=[150.0],
                    _DEJ2000=[20.0],
                    Area=[1.0],
                )
            ]
        )
        (obj,) = query_lbn(CENTER_RA, CENTER_DEC, RADIUS)
        assert obj.name == "LBN 123"
        assert obj.catalog == "LBN"
        assert obj.object_type == "Bright Nebula"

    def test_seq_used_when_lbn_value_empty(self, vizier):
        """An empty LBN string falls back to the Seq number for the name."""
        vizier.configure(tables=[table(LBN=[""], Seq=[789.0], _RAJ2000=[150.0], _DEJ2000=[20.0])])
        (obj,) = query_lbn(CENTER_RA, CENTER_DEC, RADIUS)
        assert obj.name == "LBN 789"

    def test_table_without_lbn_value_gives_no_names(self, vizier):
        """No LBN column at all: the row is skipped before Seq is used."""
        vizier.configure(tables=[table(_RAJ2000=[150.0], _DEJ2000=[20.0], Area=[1.0])])
        assert query_lbn(CENTER_RA, CENTER_DEC, RADIUS) == []

    def test_none_and_error_results(self, vizier):
        vizier.configure(tables=None)
        assert query_lbn(CENTER_RA, CENTER_DEC, RADIUS) == []
        vizier.configure(error=RuntimeError("down"))
        assert query_lbn(CENTER_RA, CENTER_DEC, RADIUS) == []

    def test_row_without_decimation_is_skipped(self, vizier):
        """A row with RA but no Dec column anywhere is dropped."""
        vizier.configure(tables=[table(LBN=["3"], _RAJ2000=[150.0], Area=[1.0])])
        assert query_lbn(CENTER_RA, CENTER_DEC, RADIUS) == []


# ---------------------------------------------------------------------------
class TestPgc:
    def base_table(self, **extra):
        cols = {"PGC": ["2557"], "_RAJ2000": [150.0], "_DEJ2000": [20.0]}
        cols.update(extra)
        return table(**cols)

    def test_full_row(self, vizier):
        vizier.configure(tables=[self.base_table(BT=[9.8], logD25=[1.0], MType=["SA(s)c"])])
        (obj,) = query_pgc(CENTER_RA, CENTER_DEC, RADIUS)
        assert obj.name == "PGC 2557"
        assert vizier.instances[0].ROW_LIMIT == 300
        assert obj.catalog == "PGC"
        assert obj.object_type == "SA(s)c"
        npt.assert_allclose(obj.magnitude, 9.8)
        # logD25=1.0 -> diameter 10 * 0.1 arcmin = 1.0
        npt.assert_allclose(obj.size_arcmin, 1.0)
        assert obj.size == "1.0'"

    def test_missing_optional_columns_default_to_galaxy(self, vizier):
        vizier.configure(tables=[self.base_table()])
        (obj,) = query_pgc(CENTER_RA, CENTER_DEC, RADIUS)
        assert obj.object_type == "Galaxy"
        assert obj.magnitude is None
        assert obj.size is None
        assert obj.size_arcmin is None

    def test_logd25_masked_gives_no_size(self, vizier):
        vizier.configure(
            tables=[
                masked_table(
                    {"PGC": ["1"], "_RAJ2000": [150.0], "_DEJ2000": [20.0], "logD25": [None]},
                    {"logD25": [True]},
                )
            ]
        )
        (obj,) = query_pgc(CENTER_RA, CENTER_DEC, RADIUS)
        assert obj.size is None
        assert obj.size_arcmin is None

    def test_rows_without_pgc_or_coordinates_skipped(self, vizier):
        vizier.configure(
            tables=[
                table(
                    PGC=["1", None],
                    _RAJ2000=[150.1, 150.2],
                    _DEJ2000=[20.1, np.ma.masked],
                )
            ]
        )
        objs = query_pgc(CENTER_RA, CENTER_DEC, RADIUS)
        assert [o.name for o in objs] == ["PGC 1"]

    def test_none_and_error_results(self, vizier):
        vizier.configure(tables=None)
        assert query_pgc(CENTER_RA, CENTER_DEC, RADIUS) == []
        vizier.configure(error=RuntimeError("down"))
        assert query_pgc(CENTER_RA, CENTER_DEC, RADIUS) == []


# ---------------------------------------------------------------------------
# query_bright_stars
# ---------------------------------------------------------------------------
class TestBrightStars:
    def test_named_star(self, vizier):
        vizier.configure(
            tables=[
                table(
                    HR=["264", "614"],
                    _RAJ2000=[88.8, 91.9],
                    _DEJ2000=[7.4, 14.6],
                    Vmag=[0.9, 2.2],
                    Name=["Aldebaran", ""],
                    SpType=["K5III", "A7IV"],
                )
            ]
        )
        objs = query_bright_stars(CENTER_RA, CENTER_DEC, RADIUS)
        assert [o.name for o in objs] == ["Aldebaran", "HR 614"]
        assert all(o.catalog == "Bright Stars" for o in objs)
        assert [o.object_type for o in objs] == ["Star (K5III)", "Star (A7IV)"]
        assert [o.common_name for o in objs] == ["Aldebaran", None]
        npt.assert_allclose([o.magnitude for o in objs], [0.9, 2.2])
        npt.assert_allclose([o.ra for o in objs], [88.8, 91.9])
        npt.assert_allclose([o.dec for o in objs], [7.4, 14.6])

    def test_masked_vmag_falls_back_to_bmag(self, vizier):
        vizier.configure(
            tables=[
                masked_table(
                    {
                        "HR": ["5"],
                        "_RAJ2000": [150.0],
                        "_DEJ2000": [20.0],
                        "Vmag": [None],
                        "Bmag": [3.3],
                    },
                    {"Vmag": [True]},
                )
            ]
        )
        (obj,) = query_bright_stars(CENTER_RA, CENTER_DEC, RADIUS)
        npt.assert_allclose(obj.magnitude, 3.3)

    def test_masked_ra_falls_back_to_next_column(self, vizier):
        vizier.configure(
            tables=[
                masked_table(
                    {
                        "HR": ["6"],
                        "_RAJ2000": [None],
                        "RAJ2000": [149.5],
                        "_DEJ2000": [20.0],
                    },
                    {"_RAJ2000": [True]},
                )
            ]
        )
        (obj,) = query_bright_stars(CENTER_RA, CENTER_DEC, RADIUS)
        npt.assert_allclose(obj.ra, 149.5)

    def test_no_spectral_or_name_columns(self, vizier):
        vizier.configure(
            tables=[table(HR=["2491"], _RAJ2000=[101.3], _DEJ2000=[-16.7], Vmag=[-1.5])]
        )
        (obj,) = query_bright_stars(CENTER_RA, CENTER_DEC, RADIUS)
        assert obj.name == "HR 2491"
        assert obj.object_type == "Star"
        assert obj.common_name is None
        npt.assert_allclose(obj.magnitude, -1.5)

    def test_mag_limit_passed_as_column_filter(self, vizier):
        vizier.configure(tables=[])
        query_bright_stars(CENTER_RA, CENTER_DEC, RADIUS, mag_limit=4.0)
        v = vizier.instances[0]
        assert v.last_call["catalog"] == "V/50"
        assert v.last_call["column_filters"] == {"Vmag": "<4.0"}

        query_bright_stars(CENTER_RA, CENTER_DEC, RADIUS)
        v2 = vizier.instances[1]
        assert v2.last_call["column_filters"] == {"Vmag": "<6.0"}
        assert v2.ROW_LIMIT == 500

    def test_rows_with_unusable_coordinates_skipped(self, vizier):
        vizier.configure(
            tables=[
                table(
                    HR=["264", "2"],
                    _RAJ2000=[88.8, np.ma.masked],
                    _DEJ2000=[7.4, 14.6],
                    Vmag=[0.9, 2.2],
                )
            ]
        )
        objs = query_bright_stars(CENTER_RA, CENTER_DEC, RADIUS)
        assert [o.name for o in objs] == ["HR 264"]

    def test_none_empty_and_error_results(self, vizier):
        vizier.configure(tables=None)
        assert query_bright_stars(CENTER_RA, CENTER_DEC, RADIUS) == []
        vizier.configure(tables=[table(HR=[], _RAJ2000=[], _DEJ2000=[])])
        assert query_bright_stars(CENTER_RA, CENTER_DEC, RADIUS) == []
        vizier.configure(error=RuntimeError("down"))
        assert query_bright_stars(CENTER_RA, CENTER_DEC, RADIUS) == []


# ---------------------------------------------------------------------------
# CatalogObject.to_dict round-trip through the query functions
# ---------------------------------------------------------------------------
class TestCatalogObjectDict:
    def test_to_dict_omits_unset_optional_fields(self):
        obj = CatalogObject(name="NGC 1", catalog="NGC", object_type="G", ra=150.0, dec=20.0)
        assert obj.to_dict() == {
            "name": "NGC 1",
            "catalog": "NGC",
            "objectType": "G",
            "ra": 150.0,
            "dec": 20.0,
        }

    def test_to_dict_includes_set_optional_fields(self):
        obj = CatalogObject(
            name="M31",
            catalog="Messier",
            object_type="G",
            ra=10.7,
            dec=41.3,
            magnitude=3.4,
            size="3.0°",
            size_arcmin=180.0,
            common_name="Andromeda",
            pixel_x=12.5,
            pixel_y=30.0,
            radius_px=15.0,
        )
        d = obj.to_dict()
        assert d["magnitude"] == 3.4
        assert d["size"] == "3.0°"
        assert d["sizeArcmin"] == 180.0
        assert d["commonName"] == "Andromeda"
        assert d["pixelX"] == 12.5
        assert d["pixelY"] == 30.0
        assert d["radiusPx"] == 15.0
