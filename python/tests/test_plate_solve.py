"""Tests for astra_astro.plate_solve: WCS extraction, hint parsing, solver detection."""

import math
import subprocess

import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS

from astra_astro.plate_solve import (
    PlateSolveResult,
    _extract_wcs_info,
    _parse_dec_string,
    _parse_ra_string,
    detect_solvers,
    extract_solve_hints,
    solve_image,
)

# ---------------------------------------------------------------------------
# _parse_ra_string
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("12 34 56.7", (12 + 34 / 60 + 56.7 / 3600) * 15.0),
        ("12:34:56.7", (12 + 34 / 60 + 56.7 / 3600) * 15.0),
        ("12h34m56.7s", (12 + 34 / 60 + 56.7 / 3600) * 15.0),
        ("00 00 00", 0.0),
        ("188.765", 188.765),  # plain decimal degrees passes through
    ],
)
def test_parse_ra_string_accepts_known_formats(text, expected):
    assert _parse_ra_string(text) == pytest.approx(expected)


@pytest.mark.parametrize(
    "text",
    ["not a number", "12 34", "12:34", "", "12 34 xx", "abc"],
)
def test_parse_ra_string_rejects_bad_input(text):
    assert _parse_ra_string(text) is None


# ---------------------------------------------------------------------------
# _parse_dec_string
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("+41 16 09", 41 + 16 / 60 + 9 / 3600),
        ("41:16:09", 41 + 16 / 60 + 9 / 3600),
        ("-33 30 00", -(33 + 30 / 60)),
        ("-00 30 00", -(0 + 30 / 60)),  # sign survives "-00" degrees
        ("-41.5", -41.5),  # single-component with sign
        ("41.5", 41.5),
        ("- 0 0 0", 0.0),
    ],
)
def test_parse_dec_string_accepts_known_formats(text, expected):
    assert _parse_dec_string(text) == pytest.approx(expected)


@pytest.mark.parametrize(
    "text",
    ["junk", "41 16", "", "41 16 zz"],
)
def test_parse_dec_string_rejects_bad_input(text):
    assert _parse_dec_string(text) is None


# ---------------------------------------------------------------------------
# PlateSolveResult.to_dict
# ---------------------------------------------------------------------------


def test_to_dict_omits_unset_optional_fields():
    result = PlateSolveResult(
        success=False,
        center_ra=10.5,
        center_dec=-20.25,
        pixel_scale=1.5,
        rotation=90.0,
        width_deg=2.0,
        height_deg=1.5,
        image_width=4000,
        image_height=3000,
        solver="nova",
        solve_time=3.25,
    )
    d = result.to_dict()
    assert d == {
        "success": False,
        "centerRa": 10.5,
        "centerDec": -20.25,
        "pixelScale": 1.5,
        "rotation": 90.0,
        "widthDeg": 2.0,
        "heightDeg": 1.5,
        "imageWidth": 4000,
        "imageHeight": 3000,
        "solver": "nova",
        "solveTime": 3.25,
    }


def test_to_dict_includes_error_message_and_wcs_when_set():
    result = PlateSolveResult(
        success=True,
        error_message="boom",
        wcs={"crpix": [1.0, 2.0], "crval": [3.0, 4.0], "cd": [[1e-4, 0.0], [0.0, 1e-4]]},
    )
    d = result.to_dict()
    assert d["success"] is True
    assert d["errorMessage"] == "boom"
    assert d["wcs"] == {
        "crpix": [1.0, 2.0],
        "crval": [3.0, 4.0],
        "cd": [[1e-4, 0.0], [0.0, 1e-4]],
    }


def test_to_dict_omits_empty_error_message_and_wcs():
    d = PlateSolveResult(success=True, error_message="", wcs=None).to_dict()
    assert "errorMessage" not in d
    assert "wcs" not in d


# ---------------------------------------------------------------------------
# _extract_wcs_info
# ---------------------------------------------------------------------------


def _make_wcs(
    crval=(150.0, 20.0),
    crpix=(1001.0, 501.0),
    cd=((5e-5, 0.0), (0.0, 5e-5)),
):
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crpix = list(crpix)
    w.wcs.crval = list(crval)
    w.wcs.cd = [[float(v) for v in row] for row in cd]
    return w


def test_extract_wcs_info_cd_matrix_center_scale_rotation():
    # 5e-5 deg/pix = 0.18 arcsec/pix; unrotated (rotation itself is checked below)
    cd_scale = 5e-5
    rot_rad = 0.0
    cd = (
        (cd_scale * math.cos(rot_rad), -cd_scale * math.sin(rot_rad)),
        (cd_scale * math.sin(rot_rad), cd_scale * math.cos(rot_rad)),
    )
    w = _make_wcs(cd=cd, crval=(150.0, 20.0), crpix=(1001.0, 501.0))
    info = _extract_wcs_info(w, 2000, 1000)

    # Centre pixel (image/2, 0-based) is CRPIX-1 -> centre world coords are CRVAL
    assert info["center_ra"] == pytest.approx(150.0, abs=1e-6)
    assert info["center_dec"] == pytest.approx(20.0, abs=1e-6)
    assert info["pixel_scale"] == pytest.approx(cd_scale * 3600, rel=1e-6)  # 0.18 arcsec/pix
    assert info["rotation"] == pytest.approx(0.0, abs=1e-9)
    # Field: 2000 pix * 0.18 arcsec/pix = 0.1 deg; RA span stretches by 1/cos(dec)
    assert info["width_deg"] == pytest.approx(
        2000 * cd_scale / math.cos(math.radians(20.0)), rel=1e-3
    )
    assert info["height_deg"] == pytest.approx(1000 * cd_scale, rel=1e-3)
    assert info["wcs"]["crpix"] == [1001.0, 501.0]
    assert info["wcs"]["crval"] == [150.0, 20.0]
    np.testing.assert_allclose(info["wcs"]["cd"], np.array(cd), atol=1e-12)


def test_extract_wcs_info_negative_rotation_stays_positive():
    cd_scale = 5e-5
    rot_rad = math.radians(-10.0)
    cd = (
        (cd_scale * math.cos(rot_rad), -cd_scale * math.sin(rot_rad)),
        (cd_scale * math.sin(rot_rad), cd_scale * math.cos(rot_rad)),
    )
    w = _make_wcs(cd=cd, crval=(150.0, 20.0), crpix=(1001.0, 501.0))
    info = _extract_wcs_info(w, 2000, 1000)
    # atan2(cd01, cd00) = +10 deg here, already within 0-360
    assert info["rotation"] == pytest.approx(10.0, rel=1e-3)
    assert info["center_ra"] == pytest.approx(150.0, abs=1e-6)


def test_extract_wcs_info_cdelt_crota_path():
    w = WCS(naxis=2)
    w.wcs.crpix = [501.0, 501.0]
    w.wcs.crval = [90.0, 0.0]
    w.wcs.cdelt = [-1e-4, 2e-4]  # deg/pix
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    info = _extract_wcs_info(w, 1000, 1000)

    assert info["center_ra"] == pytest.approx(90.0, abs=1e-6)
    assert info["center_dec"] == pytest.approx(0.0, abs=1e-6)
    assert info["pixel_scale"] == pytest.approx(1e-4 * 3600, rel=1e-9)  # 0.36 arcsec/pix
    assert info["rotation"] == 0.0
    assert "cd" not in info["wcs"]  # no CD matrix -> only crpix/crval recorded
    assert info["width_deg"] == pytest.approx(1000 * 1e-4, rel=1e-3)
    assert info["height_deg"] == pytest.approx(1000 * 2e-4, rel=1e-3)


def test_extract_wcs_info_pixel_scale_uses_full_determinant():
    # Non-symmetric CD: the scale comes from the determinant, not any single entry
    w = _make_wcs(cd=((2e-5, 1e-5), (3e-5, 4e-5)), crpix=(501.0, 501.0))
    info = _extract_wcs_info(w, 1000, 1000)
    det = 2e-5 * 4e-5 - 1e-5 * 3e-5
    assert info["pixel_scale"] == pytest.approx(det**0.5 * 3600, rel=1e-6)


def test_extract_wcs_info_negative_rotation_wraps_into_0_360():
    # cd01 < 0 gives a negative atan2, which must come back inside 0-360
    cd_scale = 5e-5
    w = _make_wcs(
        cd=(
            (cd_scale, -0.1 * cd_scale),
            (0.1 * cd_scale, cd_scale),
        ),
        crval=(150.0, 20.0),
        crpix=(501.0, 501.0),
    )
    info = _extract_wcs_info(w, 1000, 1000)
    expected = math.degrees(math.atan2(-0.1 * cd_scale, cd_scale)) % 360
    assert info["rotation"] == pytest.approx(expected, abs=1e-9)
    assert info["rotation"] > 180  # the negative angle was wrapped, not kept


def test_extract_wcs_info_crota_used_when_cd_absent():
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crpix = [501.0, 501.0]
    w.wcs.crval = [90.0, 0.0]
    w.wcs.cdelt = [-1e-4, 2e-4]
    w.wcs.crota = [10.0, 20.0]
    info = _extract_wcs_info(w, 1000, 1000)
    assert info["rotation"] == pytest.approx(20.0, abs=1e-9)


def test_extract_wcs_info_ra_span_just_over_180_is_wrapped():
    # Plate carree projection keeps RA linear: a field whose corner RA values
    # (10.0 and 190.5) span just over 180 deg is reduced to 179.5 deg
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---CAR", "DEC--CAR"]
    w.wcs.crpix = [903.5, 2.0]
    w.wcs.crval = [100.25, 0.0]
    w.wcs.cd = [[0.1, 0.0], [0.0, 0.1]]
    info = _extract_wcs_info(w, 1805, 4)
    assert info["width_deg"] == pytest.approx(179.5, abs=1e-6)


def test_extract_wcs_info_ra_wraparound_field_spans_zero():
    # Centre near RA=0 so the corners straddle 0/360: CRVAL RA = 0.0001 deg,
    # 1000 pix at 1e-5 deg/pix spans about 0.01 deg around it.
    w = _make_wcs(crval=(0.0, 0.0), crpix=(501.0, 501.0), cd=((1e-5, 0.0), (0.0, 1e-5)))
    info = _extract_wcs_info(w, 1000, 1000)
    assert info["center_ra"] == pytest.approx(0.0, abs=1e-6)
    assert info["center_dec"] == pytest.approx(0.0, abs=1e-6)
    # Without wrap handling the raw RA span would be ~359.99; with it ~0.01
    assert info["width_deg"] == pytest.approx(1000 * 1e-5, rel=1e-2)


# ---------------------------------------------------------------------------
# extract_solve_hints
# ---------------------------------------------------------------------------


def _write_fits(path, header_updates, data_shape=(100, 200)):
    header = fits.Header()
    header["SIMPLE"] = True
    header["BITPIX"] = 16
    header["NAXIS"] = 2
    header["NAXIS1"] = data_shape[1]
    header["NAXIS2"] = data_shape[0]
    for key, value in header_updates.items():
        header[key] = value
        if value is None:
            del header[key]
    fits.PrimaryHDU(data=np.zeros(data_shape, dtype=np.int16), header=header).writeto(
        path, overwrite=True
    )


def test_extract_solve_hints_missing_file_returns_empty(tmp_path):
    assert extract_solve_hints(str(tmp_path / "absent.fits")) == {}


def test_extract_solve_hints_full_header(tmp_path):
    path = tmp_path / "full.fits"
    _write_fits(
        path,
        {
            "FOCALLEN": 800.0,
            "XPIXSZ": 3.75,
            "RA": "12 34 56",
            "DEC": "+41 16 09",
        },
        data_shape=(100, 200),
    )
    hints = extract_solve_hints(str(path))

    scale = 206.265 * 3.75 / 800.0  # arcsec/pix
    assert hints["focal_length_mm"] == pytest.approx(800.0)
    assert hints["pixel_size_um"] == pytest.approx(3.75)
    assert hints["scale_arcsec"] == pytest.approx(scale)
    assert hints["scale_lower"] == pytest.approx(scale * 0.8)
    assert hints["scale_upper"] == pytest.approx(scale * 1.2)
    diag = math.hypot(200, 100)
    assert hints["fov_deg"] == pytest.approx(scale * diag / 3600.0)
    assert hints["ra_hint"] == pytest.approx((12 + 34 / 60 + 56 / 3600) * 15.0)
    assert hints["dec_hint"] == pytest.approx(41 + 16 / 60 + 9 / 3600)
    assert hints["image_width"] == 200
    assert hints["image_height"] == 100


def test_extract_solve_hints_alternate_header_spellings(tmp_path):
    path = tmp_path / "alt.fits"
    _write_fits(
        path,
        {
            "FOCALLNG": 400.0,  # alternate focal length key
            "PIXSIZE": 5.0,  # alternate pixel size key
            "OBJCTRA": "06:00:00",
            "OBJCTDEC": "-30:00:00",
        },
    )
    hints = extract_solve_hints(str(path))
    assert hints["focal_length_mm"] == pytest.approx(400.0)
    assert hints["pixel_size_um"] == pytest.approx(5.0)
    assert hints["scale_arcsec"] == pytest.approx(206.265 * 5.0 / 400.0)
    assert hints["ra_hint"] == pytest.approx(6.0 * 15.0)
    assert hints["dec_hint"] == pytest.approx(-30.0)


def test_extract_solve_hints_numeric_coordinates_and_first_key_wins(tmp_path):
    path = tmp_path / "num.fits"
    _write_fits(
        path,
        {
            "FOCALLEN": "not-a-number",  # unparseable -> falls through to FOCAL
            "FOCAL": 600.0,
            "XPIXSZ": "bad",  # unparseable -> no other pixel key, so no scale
            "CRVAL1": 90.0,
            "CRVAL2": -5.0,
        },
    )
    hints = extract_solve_hints(str(path))
    assert hints["focal_length_mm"] == pytest.approx(600.0)
    assert "pixel_size_um" not in hints
    assert "scale_arcsec" not in hints
    assert hints["ra_hint"] == pytest.approx(90.0)
    assert hints["dec_hint"] == pytest.approx(-5.0)


def test_extract_solve_hints_no_header_keywords_gives_only_dimensions(tmp_path):
    path = tmp_path / "bare.fits"
    _write_fits(path, {}, data_shape=(64, 128))
    hints = extract_solve_hints(str(path))
    assert hints == {"image_width": 128, "image_height": 64}


def test_extract_solve_hints_cube_data_uses_last_two_axes(tmp_path):
    # Colour cube (3, H, W): width/height come from shape[1] and shape[2]
    path = tmp_path / "cube.fits"
    data = np.zeros((3, 80, 160), dtype=np.int16)
    header = fits.Header({"SIMPLE": True, "BITPIX": 16, "NAXIS": 3})
    fits.PrimaryHDU(data=data, header=header).writeto(path, overwrite=True)
    hints = extract_solve_hints(str(path))
    assert hints["image_width"] == 160
    assert hints["image_height"] == 80


def test_extract_solve_hints_channels_last_cube_uses_first_two_axes(tmp_path):
    # (H, W, 3) RGB-style array: first two axes are height and width
    path = tmp_path / "rgbfits.fits"
    data = np.zeros((40, 70, 3), dtype=np.int16)
    header = fits.Header({"SIMPLE": True, "BITPIX": 16, "NAXIS": 3})
    fits.PrimaryHDU(data=data, header=header).writeto(path, overwrite=True)
    hints = extract_solve_hints(str(path))
    assert hints["image_width"] == 70
    assert hints["image_height"] == 40


def test_extract_solve_hints_complex_coordinate_value_yields_no_hint(tmp_path):
    # A complex FITS value cannot be cast to float: the hint is skipped entirely
    path = tmp_path / "complex.fits"
    data = np.zeros((10, 20), dtype=np.int16)
    header = fits.Header(
        {
            "SIMPLE": True,
            "BITPIX": 16,
            "NAXIS": 2,
            "CRVAL1": complex(90.0, 1.0),
            "CRVAL2": complex(20.0, 1.0),
        }
    )
    fits.PrimaryHDU(data=data, header=header).writeto(path, overwrite=True)
    hints = extract_solve_hints(str(path))
    assert "ra_hint" not in hints
    assert "dec_hint" not in hints
    assert hints["image_width"] == 20
    assert hints["image_height"] == 10


def test_extract_solve_hints_image_without_data_array_returns_empty(tmp_path):
    path = tmp_path / "nodata.fits"
    fits.PrimaryHDU(header=fits.Header({"SIMPLE": True})).writeto(path, overwrite=True)
    assert extract_solve_hints(str(path)) == {}


def test_extract_solve_hints_corrupt_file_returns_empty(tmp_path):
    path = tmp_path / "corrupt.fits"
    path.write_bytes(b"this is not a fits file at all........" + b"x" * 100)
    assert extract_solve_hints(str(path)) == {}


# ---------------------------------------------------------------------------
# detect_solvers
# ---------------------------------------------------------------------------


def _run_ok(stdout=""):
    return subprocess.CompletedProcess(args=[], returncode=0, stdout=stdout, stderr="")


def test_detect_solvers_all_present(monkeypatch):
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        if cmd[0] == "solve-field":
            return _run_ok("solve-field 0.89\n")
        return _run_ok()

    monkeypatch.setattr(subprocess, "run", fake_run)
    solvers = detect_solvers()

    assert solvers["nova"]["available"] is True
    assert solvers["local"]["available"] is True
    assert solvers["local"]["version"] == "solve-field 0.89"
    assert solvers["astap"]["available"] is True
    # first astap candidate tried is astap_cli
    assert calls[-1][0] == "astap_cli"
    assert "astap_cli" in solvers["astap"]["details"]
    assert solvers["tetra3"]["available"] is True


def test_detect_solvers_all_absent(monkeypatch):
    def fake_run(cmd, **kwargs):
        raise FileNotFoundError(f"no {cmd[0]}")

    monkeypatch.setattr(subprocess, "run", fake_run)
    solvers = detect_solvers()

    assert solvers["local"]["available"] is False
    assert solvers["local"]["version"] is None
    assert solvers["astap"]["available"] is False
    assert solvers["astap"]["version"] is None
    assert solvers["nova"]["available"] is True  # remote service, no binary needed
    assert solvers["tetra3"]["available"] is True


def test_detect_solvers_solve_field_times_out(monkeypatch):
    def fake_run(cmd, **kwargs):
        if cmd[0] == "solve-field":
            raise subprocess.TimeoutExpired(cmd, 5)
        return _run_ok()

    monkeypatch.setattr(subprocess, "run", fake_run)
    solvers = detect_solvers()
    assert solvers["local"]["available"] is False
    assert solvers["astap"]["available"] is True


def test_detect_solvers_solve_field_errors_but_astap_falls_back(monkeypatch):
    tried = []

    def fake_run(cmd, **kwargs):
        tried.append(cmd[0])
        if cmd[0] == "solve-field":
            raise subprocess.CalledProcessError(1, cmd)
        if cmd[0] == "astap_cli":
            raise FileNotFoundError("no astap_cli")
        return _run_ok()  # "astap" (second candidate) works

    monkeypatch.setattr(subprocess, "run", fake_run)
    solvers = detect_solvers()
    assert solvers["local"]["available"] is False
    assert solvers["astap"]["available"] is True
    assert "astap_cli" in tried  # first candidate was tried and failed
    assert "astap" in solvers["astap"]["details"]  # second candidate won


def test_detect_solvers_solve_field_empty_output_gives_none_version(monkeypatch):
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda cmd, **kw: _run_ok(""),
    )
    solvers = detect_solvers()
    assert solvers["local"]["available"] is True
    assert solvers["local"]["version"] is None


# ---------------------------------------------------------------------------
# solve_image dispatch
# ---------------------------------------------------------------------------


def _ok_result(solver):
    return PlateSolveResult(
        success=True,
        center_ra=100.0,
        center_dec=20.0,
        solver=solver,
        solve_time=1.0,
    )


def test_solve_image_missing_file_short_circuits(tmp_path, monkeypatch):
    called = []
    monkeypatch.setattr("astra_astro.plate_solve.solve_with_nova", lambda *a, **k: called.append(a))
    d = solve_image(str(tmp_path / "nope.fits"), solver="nova", api_key="k")
    assert d["success"] is False
    assert d["errorMessage"] == f"Image file not found: {tmp_path / 'nope.fits'}"
    assert d["solver"] == ""  # no solver was chosen
    assert called == []


def test_solve_image_nova_requires_api_key(tmp_path, monkeypatch):
    (tmp_path / "img.fits").write_bytes(b"")
    monkeypatch.setattr(
        "astra_astro.plate_solve.solve_with_nova", lambda *a, **k: pytest.fail("should not run")
    )
    d = solve_image(str(tmp_path / "img.fits"), solver="nova", api_key=None)
    assert d["success"] is False
    assert d["solver"] == "nova"
    assert "API key" in d["errorMessage"]


def test_solve_image_nova_dispatch(tmp_path, monkeypatch):
    (tmp_path / "img.fits").write_bytes(b"")
    seen = {}

    def fake_nova(image_path, api_key, api_url, lower, upper, timeout):
        seen.update(
            image_path=image_path,
            api_key=api_key,
            api_url=api_url,
            lower=lower,
            upper=upper,
            timeout=timeout,
        )
        return _ok_result("nova")

    monkeypatch.setattr("astra_astro.plate_solve.solve_with_nova", fake_nova)
    d = solve_image(
        str(tmp_path / "img.fits"),
        solver="nova",
        api_key="KEY",
        api_url="http://local:8000",
        scale_lower=0.5,
        scale_upper=2.0,
        timeout=60,
    )
    assert seen == {
        "image_path": str(tmp_path / "img.fits"),
        "api_key": "KEY",
        "api_url": "http://local:8000",
        "lower": 0.5,
        "upper": 2.0,
        "timeout": 60,
    }
    assert d == {
        "success": True,
        "centerRa": 100.0,
        "centerDec": 20.0,
        "pixelScale": 0.0,
        "rotation": 0.0,
        "widthDeg": 0.0,
        "heightDeg": 0.0,
        "imageWidth": 0,
        "imageHeight": 0,
        "solver": "nova",
        "solveTime": 1.0,
    }


def test_solve_image_local_dispatch(tmp_path, monkeypatch):
    (tmp_path / "img.fits").write_bytes(b"")
    seen = {}

    def fake_local(image_path, lower, upper, timeout, binary_path):
        seen.update(
            image_path=image_path,
            lower=lower,
            upper=upper,
            timeout=timeout,
            binary_path=binary_path,
        )
        return _ok_result("local")

    monkeypatch.setattr("astra_astro.plate_solve.solve_with_local", fake_local)
    d = solve_image(
        str(tmp_path / "img.fits"),
        solver="LOCAL",  # case-insensitive
        scale_lower=1.0,
        scale_upper=4.0,
        timeout=30,
        binary_path="/opt/bin/solve-field",
    )
    assert seen == {
        "image_path": str(tmp_path / "img.fits"),
        "lower": 1.0,
        "upper": 4.0,
        "timeout": 30,
        "binary_path": "/opt/bin/solve-field",
    }
    assert d["solver"] == "local"
    assert d["success"] is True


def test_solve_image_astap_dispatch(tmp_path, monkeypatch):
    (tmp_path / "img.fits").write_bytes(b"")
    seen = {}

    def fake_astap(image_path, lower, upper, timeout, binary_path):
        seen.update(image_path=image_path, lower=lower, binary_path=binary_path)
        return _ok_result("astap")

    monkeypatch.setattr("astra_astro.plate_solve.solve_with_astap", fake_astap)
    d = solve_image(
        str(tmp_path / "img.fits"),
        solver="astap",
        scale_lower=2.0,
        binary_path="/opt/astap/astap_cli",
    )
    assert seen == {
        "image_path": str(tmp_path / "img.fits"),
        "lower": 2.0,
        "binary_path": "/opt/astap/astap_cli",
    }
    assert d["solver"] == "astap"
    assert d["success"] is True


def test_solve_image_unknown_solver(tmp_path, monkeypatch):
    (tmp_path / "img.fits").write_bytes(b"")
    monkeypatch.setattr(
        "astra_astro.plate_solve.solve_with_nova", lambda *a, **k: pytest.fail("should not run")
    )
    monkeypatch.setattr(
        "astra_astro.plate_solve.solve_with_local", lambda *a, **k: pytest.fail("should not run")
    )
    monkeypatch.setattr(
        "astra_astro.plate_solve.solve_with_astap", lambda *a, **k: pytest.fail("should not run")
    )
    d = solve_image(str(tmp_path / "img.fits"), solver="tetra3")
    assert d["success"] is False
    assert "Unknown solver: tetra3" in d["errorMessage"]


def test_solve_image_propagates_failure_result(tmp_path, monkeypatch):
    (tmp_path / "img.fits").write_bytes(b"")
    failed = PlateSolveResult(success=False, solver="local", error_message="No solution found")
    monkeypatch.setattr("astra_astro.plate_solve.solve_with_local", lambda *a, **k: failed)
    d = solve_image(str(tmp_path / "img.fits"), solver="local")
    assert d["success"] is False
    assert d["solver"] == "local"
    assert d["errorMessage"] == "No solution found"
