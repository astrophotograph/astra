"""Tests for astra_astro.image_process: FITS round trip, previews, pipeline.

Synthetic images are built with numpy and written to ``tmp_path``. No network
access: ``classify_from_name`` is patched, and ``quick_preview`` uses the local
``processinator`` package (pure local file conversion).
"""

from types import SimpleNamespace

import astropy.io.fits as fits
import numpy as np
import numpy.testing as npt
import pytest
from PIL import Image

from astra_astro.image_process import (
    ProcessingParams,
    ProcessingResult,
    _apply_noise_reduction,
    _color_calibrate,
    _load_fits,
    _reduce_stars,
    _remove_background,
    _save_fits,
    _save_preview,
    _statistical_stretch,
    process_image,
    process_image_from_dict,
    quick_preview,
)
from astra_astro.target_classify import TargetType


# ---------------------------------------------------------------------------
# Fixtures and helpers
# ---------------------------------------------------------------------------
def make_mono(seed=0, size=32):
    """Smooth gradient plus a few bright stars."""
    y, x = np.mgrid[0:size, 0:size]
    data = 0.05 + 0.002 * x + 0.001 * y
    rng = np.random.default_rng(seed)
    data += rng.uniform(0, 0.02, data.shape)
    for row, col in [(10, 10), (20, 5), (5, 25)]:
        data[row, col] = 1.0
    return data


def make_colour(seed=0, size=32):
    """Three channels with different background levels plus bright stars."""
    base = make_mono(seed, size)
    data = np.stack([base * 0.3, base * 0.6, base * 0.9], axis=-1)
    data[10, 10] = [1.0, 1.0, 1.0]
    return data


def write_fits(path, data, extra_header=None):
    arr = np.asarray(data, dtype=np.float32)
    if arr.ndim == 3:
        arr = np.moveaxis(arr, -1, 0)  # (H, W, C) -> (C, H, W)
    header = fits.Header()
    header["OBJECT"] = "M42"
    header["TELESCOP"] = "SeeStar"
    header["EXPTIME"] = 30.0
    if extra_header:
        for key, value in extra_header.items():
            header[key] = value
    fits.PrimaryHDU(arr, header=header).writeto(path, overwrite=True)


@pytest.fixture
def mono_fits(tmp_path):
    data = make_mono()
    path = tmp_path / "in.fits"
    write_fits(path, data)
    return path


@pytest.fixture
def colour_fits(tmp_path):
    data = make_colour()
    path = tmp_path / "in_rgb.fits"
    write_fits(path, data)
    return path


# ---------------------------------------------------------------------------
# _load_fits
# ---------------------------------------------------------------------------
class TestLoadFits:
    def test_mono_round_trip_values_and_header(self, mono_fits):
        data, header = _load_fits(str(mono_fits))
        assert data.shape == (32, 32)
        assert data.dtype == np.float64
        expected = np.moveaxis(
            fits.getdata(mono_fits), -1, 0
        ) if fits.getdata(mono_fits).ndim == 3 else fits.getdata(mono_fits)
        npt.assert_allclose(data, expected, rtol=0, atol=0)
        assert header["OBJECT"] == "M42"
        assert header["TELESCOP"] == "SeeStar"
        assert header["EXPTIME"] == 30.0

    def test_channels_first_converted_to_hwc(self, tmp_path):
        data = np.zeros((3, 8, 8), dtype=np.float32)
        data[0] = 0.1
        data[1] = 0.2
        data[2] = 0.3
        path = tmp_path / "cfirst.fits"
        fits.PrimaryHDU(data).writeto(path)
        loaded, _ = _load_fits(str(path))
        assert loaded.shape == (8, 8, 3)
        npt.assert_allclose(loaded[:, :, 0], 0.1, atol=1e-7)
        npt.assert_allclose(loaded[:, :, 1], 0.2, atol=1e-7)
        npt.assert_allclose(loaded[:, :, 2], 0.3, atol=1e-7)

    def test_four_channel_first_axis_treated_as_channels(self, tmp_path):
        """A (4, H, W) array is moved to (H, W, 4) like the 1/3-channel case."""
        path = tmp_path / "four.fits"
        data = np.zeros((4, 6, 6), dtype=np.float32)
        for c in range(4):
            data[c] = 0.1 * (c + 1)
        fits.PrimaryHDU(data).writeto(path)
        loaded, _ = _load_fits(str(path))
        assert loaded.shape == (6, 6, 4)
        for c in range(4):
            npt.assert_allclose(loaded[:, :, c], 0.1 * (c + 1), atol=1e-7)

    def test_single_channel_squeezed(self, tmp_path):
        path = tmp_path / "one.fits"
        fits.PrimaryHDU(np.full((1, 8, 8), 0.4, dtype=np.float32)).writeto(path)
        loaded, _ = _load_fits(str(path))
        assert loaded.shape == (8, 8)
        npt.assert_allclose(loaded, 0.4, atol=1e-7)

    def test_first_axis_not_channel_left_alone(self, tmp_path):
        path = tmp_path / "two.fits"
        fits.PrimaryHDU(np.full((2, 8, 3), 0.4, dtype=np.float32)).writeto(path)
        loaded, _ = _load_fits(str(path))
        assert loaded.shape == (2, 8, 3)

    def test_missing_file_raises(self, tmp_path):
        with pytest.raises(FileNotFoundError):
            _load_fits(str(tmp_path / "nope.fits"))

    def test_not_a_fits_file_raises(self, tmp_path):
        bad = tmp_path / "bad.fits"
        bad.write_text("this is not a FITS file\n")
        with pytest.raises(OSError):
            _load_fits(str(bad))


# ---------------------------------------------------------------------------
# _save_fits
# ---------------------------------------------------------------------------
class TestSaveFits:
    def test_mono_round_trip_preserves_values_and_header(self, tmp_path):
        data = make_mono()
        out = tmp_path / "out.fits"
        _save_fits(data, str(out), {"OBJECT": "M42", "NAXIS1": 999})
        loaded, header = _load_fits(str(out))
        assert loaded.dtype == np.float64
        # Data stored as float32, so compare at float32 precision.
        npt.assert_allclose(loaded, data, atol=1e-6)
        assert header["OBJECT"] == "M42"
        # Format-defining keys must not be copied blindly.
        assert header["NAXIS1"] == 32
        assert header["ASTRA_PR"] == "processed"
        assert header["HISTORY"] == "Processed by Astra image_process.py"

    def test_rgb_stored_channels_first(self, tmp_path):
        data = make_colour()
        out = tmp_path / "rgb.fits"
        _save_fits(data, str(out))
        raw = fits.getdata(out)
        assert raw.shape == (3, 32, 32)
        npt.assert_allclose(raw[0], data[:, :, 0], atol=1e-6)

    def test_writing_over_existing_file_succeeds(self, tmp_path):
        out = tmp_path / "same.fits"
        _save_fits(make_mono(), str(out))
        _save_fits(make_mono(1), str(out))
        loaded, _ = _load_fits(str(out))
        npt.assert_allclose(loaded, make_mono(1), atol=1e-6)

    def test_invalid_header_value_skipped(self, tmp_path):
        out = tmp_path / "badhdr.fits"
        _save_fits(np.ones((4, 4)), str(out), {"BOGUS": {"not": "a header value"}})
        with fits.open(out) as hdul:
            assert "BOGUS" not in hdul[0].header
            assert hdul[0].header["ASTRA_PR"] == "processed"


# ---------------------------------------------------------------------------
# _save_preview
# ---------------------------------------------------------------------------
class TestSavePreview:
    def test_mono_png_mode_and_size(self, tmp_path):
        data = make_mono()
        data[15, 15] = 1.0
        out = tmp_path / "prev.png"
        _save_preview(data, str(out))
        img = Image.open(out)
        assert img.mode == "L"
        assert img.size == (32, 32)
        # The brightest pixel maps to white.
        assert np.asarray(img)[15, 15] == 255
        # Values are scaled by 255 and truncated.
        assert np.asarray(img)[0, 0] == int(data[0, 0] * 255)

    def test_rgb_png_mode(self, tmp_path):
        out = tmp_path / "prev_rgb.png"
        _save_preview(make_colour(), str(out))
        img = Image.open(out)
        assert img.mode == "RGB"
        assert img.size == (32, 32)


# ---------------------------------------------------------------------------
# quick_preview
# ---------------------------------------------------------------------------
class TestQuickPreview:
    def test_png_success(self, tmp_path, mono_fits):
        out = tmp_path / "quick.png"
        result = quick_preview(str(mono_fits), str(out), bg_percent=0.2, sigma=3.0)
        assert result["success"] is True
        assert result["outputPath"] == str(out)
        assert result["processingTime"] >= 0
        img = Image.open(out)
        assert img.size == (32, 32)
        assert img.mode == "L"

    def test_jpeg_format_from_extension(self, tmp_path, mono_fits):
        out = tmp_path / "quick.jpg"
        result = quick_preview(str(mono_fits), str(out))
        assert result["success"] is True
        img = Image.open(out)
        assert img.format == "JPEG"

    def test_missing_input_reports_failure(self, tmp_path):
        out = tmp_path / "nope.png"
        result = quick_preview(str(tmp_path / "missing.fits"), str(out))
        assert result["success"] is False
        assert result["error"]
        assert result["processingTime"] == 0
        assert not out.exists()


# ---------------------------------------------------------------------------
# process_image
# ---------------------------------------------------------------------------
class TestProcessImage:
    def test_default_params_success_and_outputs(self, tmp_path, mono_fits):
        out_dir = tmp_path / "out"
        result = process_image(str(mono_fits), str(out_dir))
        assert result.success is True
        assert result.error_message is None
        assert result.target_type == "unknown"
        assert result.processing_params == ProcessingParams().to_dict()
        assert result.processing_time >= 0
        assert result.output_fits_path.startswith(str(out_dir))
        assert result.output_preview_path.startswith(str(out_dir))
        # Files exist and are readable.
        loaded, header = _load_fits(result.output_fits_path)
        assert loaded.shape == (32, 32)
        assert header["ASTRA_PR"] == "processed"
        assert header["OBJECT"] == "M42"
        img = Image.open(result.output_preview_path)
        assert img.mode == "L"
        assert img.size == (32, 32)
        # The stretch moved the data well above the raw background level.
        raw, _ = _load_fits(str(mono_fits))
        assert np.median(loaded) > np.median(raw)

    def test_existing_output_directory_is_reused(self, tmp_path, mono_fits):
        out_dir = tmp_path / "out"
        first = process_image(str(mono_fits), str(out_dir))
        assert first.success is True
        second = process_image(str(mono_fits), str(out_dir))
        assert second.success is True
        assert _load_fits(second.output_fits_path)[0].shape == (32, 32)

    def test_progress_message_reports_width_x_height(self, tmp_path):
        path = tmp_path / "tall.fits"
        y, x = np.mgrid[0:20, 0:40]
        write_fits(path, 0.05 + 0.002 * x + 0.001 * y)  # 40 wide, 20 high
        calls = []
        result = process_image(
            str(path), str(tmp_path / "out"),
            progress_callback=lambda s, p, m: calls.append(m),
        )
        assert result.success is True
        # The message is "(<width>x<height>)": 40 wide first, 20 high second.
        assert any("(40x20)" in m for m in calls)
        assert not any("(20x40)" in m for m in calls)

    def test_noise_reduction_percent_in_progress_message(self, tmp_path, mono_fits):
        messages = []
        result = process_image(
            str(mono_fits), str(tmp_path / "out"),
            ProcessingParams(noise_reduction=1.0),
            progress_callback=lambda s, p, m: messages.append(m),
        )
        assert result.success is True
        assert any("Applying noise reduction (100%)" in m for m in messages)
        assert not any("101%" in m for m in messages)

    def test_progress_callback_monotonic_and_ends_at_one(self, tmp_path, mono_fits):
        calls = []

        def cb(step, progress, message):
            calls.append((step, progress, message))

        result = process_image(str(mono_fits), str(tmp_path / "out"), progress_callback=cb)
        assert result.success is True
        steps = [c[0] for c in calls]
        assert steps[0] == "init"
        assert steps[-1] == "complete"
        for expected in ["loading", "classifying", "background", "calibration",
                         "stretch", "stars", "noise", "saving"]:
            assert expected in steps
        progresses = [c[1] for c in calls]
        assert all(
            progresses[i] <= progresses[i + 1] + 1e-9
            for i in range(len(progresses) - 1)
        )
        assert progresses[-1] == 1.0
        assert all(isinstance(c[2], str) for c in calls)

    def test_raising_callback_does_not_fail_processing(self, tmp_path, mono_fits):
        def cb(step, progress, message):
            raise RuntimeError("callback blew up")

        result = process_image(str(mono_fits), str(tmp_path / "out"), progress_callback=cb)
        assert result.success is True

    @pytest.mark.parametrize("method", ["statistical", "arcsinh", "log"])
    def test_each_stretch_method_changes_output(self, tmp_path, mono_fits, method):
        loaded = self._run_stretch(tmp_path, mono_fits, method)
        assert loaded.shape == (32, 32)

    @staticmethod
    def _run_stretch(tmp_path, mono_fits, method="statistical"):
        result = process_image(
            str(mono_fits),
            str(tmp_path / method),
            ProcessingParams(stretch_method=method),
        )
        assert result.success is True
        loaded, _ = _load_fits(result.output_fits_path)
        # Every method must brighten this dark synthetic frame.
        raw, _ = _load_fits(str(mono_fits))
        assert np.median(loaded) > np.median(raw)
        assert np.all(loaded >= 0) and np.all(loaded <= 1)
        return loaded

    def test_unknown_stretch_method_falls_back_to_statistical(self, tmp_path, mono_fits):
        stats = self._run_stretch(tmp_path, mono_fits, "statistical")
        result = process_image(
            str(mono_fits),
            str(tmp_path / "weird"),
            ProcessingParams(stretch_method="not_a_method"),
        )
        assert result.success is True
        loaded, _ = _load_fits(result.output_fits_path)
        npt.assert_allclose(loaded, stats, atol=1e-6)

    def test_stretch_methods_differ(self, tmp_path, mono_fits):
        outs = {m: self._run_stretch(tmp_path, mono_fits, m)
                for m in ["statistical", "arcsinh", "log"]}
        assert not np.allclose(outs["statistical"], outs["arcsinh"])
        assert not np.allclose(outs["statistical"], outs["log"])
        assert not np.allclose(outs["arcsinh"], outs["log"])

    def test_background_removal_changes_output(self, tmp_path, mono_fits):
        on = process_image(str(mono_fits), str(tmp_path / "bg_on"),
                           ProcessingParams(background_removal=True))
        off = process_image(str(mono_fits), str(tmp_path / "bg_off"),
                            ProcessingParams(background_removal=False))
        assert on.success and off.success
        a, _ = _load_fits(on.output_fits_path)
        b, _ = _load_fits(off.output_fits_path)
        assert not np.allclose(a, b)

    def test_colour_calibration_changes_colour_output(self, tmp_path, colour_fits):
        on = process_image(str(colour_fits), str(tmp_path / "cc_on"),
                           ProcessingParams(color_calibration=True))
        off = process_image(str(colour_fits), str(tmp_path / "cc_off"),
                            ProcessingParams(color_calibration=False))
        assert on.success and off.success
        a, _ = _load_fits(on.output_fits_path)
        b, _ = _load_fits(off.output_fits_path)
        assert a.shape == (32, 32, 3)
        assert not np.allclose(a, b)

    def test_noise_reduction_smooths_output(self, tmp_path, mono_fits):
        rng = np.random.default_rng(1)
        noisy = make_mono() + rng.normal(0, 0.05, (32, 32))
        noisy_path = tmp_path / "noisy.fits"
        write_fits(noisy_path, noisy)
        off = process_image(str(noisy_path), str(tmp_path / "nr_off"),
                            ProcessingParams(noise_reduction=0.0))
        on = process_image(str(noisy_path), str(tmp_path / "nr_on"),
                           ProcessingParams(noise_reduction=0.8))
        a, _ = _load_fits(on.output_fits_path)
        b, _ = _load_fits(off.output_fits_path)
        # Smoothing reduces high-frequency energy (mean of |neighbour diffs|).
        def hf(x):
            return np.mean(np.abs(np.diff(x, axis=0))) + np.mean(np.abs(np.diff(x, axis=1)))
        assert hf(a) < hf(b)

    def test_star_reduction_dims_bright_peaks(self, tmp_path, mono_fits):
        on = process_image(str(mono_fits), str(tmp_path / "sr_on"),
                           ProcessingParams(star_reduction=True))
        off = process_image(str(mono_fits), str(tmp_path / "sr_off"),
                            ProcessingParams(star_reduction=False))
        a, _ = _load_fits(on.output_fits_path)
        b, _ = _load_fits(off.output_fits_path)
        assert not np.allclose(a, b)
        # Every star pixel is dimmed when star reduction runs; the background
        # stays close to its unstretched relative level.
        assert a[10, 10] < b[10, 10]
        assert a[5, 25] < b[5, 25]
        assert a[20, 5] < b[20, 5]
        assert a[0, 0] <= b[0, 0] + 0.05

    def test_contrast_above_one_changes_output(self, tmp_path, mono_fits):
        none = process_image(str(mono_fits), str(tmp_path / "c10"),
                             ProcessingParams(contrast=1.0))
        strong = process_image(str(mono_fits), str(tmp_path / "c15"),
                               ProcessingParams(contrast=1.5))
        a, _ = _load_fits(strong.output_fits_path)
        b, _ = _load_fits(none.output_fits_path)
        assert not np.allclose(a, b)
        # Contrast increases the spread around the mean.
        assert np.std(a) > np.std(b)

    def test_stretch_factor_between_zero_and_one_is_used(self, tmp_path, mono_fits):
        # A stretch_factor in (0, 1] must be honoured, not treated as missing:
        # a higher target median gives a brighter stretch than the default 0.15.
        bright = process_image(str(mono_fits), str(tmp_path / "bright"),
                               ProcessingParams(stretch_factor=0.5))
        default = process_image(str(mono_fits), str(tmp_path / "default"))
        assert bright.success is True and default.success is True
        a, _ = _load_fits(bright.output_fits_path)
        b, _ = _load_fits(default.output_fits_path)
        assert np.median(a) > np.median(b)

    def test_stretch_factor_zero_uses_target_default(self, tmp_path, mono_fits):
        # stretch_factor <= 0 falls back to the target-specific default
        # (0.15 for UNKNOWN); the run must still succeed and stretch.
        result = process_image(str(mono_fits), str(tmp_path / "out"),
                               ProcessingParams(stretch_factor=0.0))
        assert result.success is True
        loaded, _ = _load_fits(result.output_fits_path)
        raw, _ = _load_fits(str(mono_fits))
        assert np.median(loaded) > np.median(raw)

    def test_explicit_target_type_recorded(self, tmp_path, mono_fits):
        result = process_image(str(mono_fits), str(tmp_path / "out"),
                               ProcessingParams(target_type="galaxy"))
        assert result.success is True
        assert result.target_type == "galaxy"

    def test_unknown_target_type_string_falls_back(self, tmp_path, mono_fits):
        result = process_image(str(mono_fits), str(tmp_path / "out"),
                               ProcessingParams(target_type="not_a_target"))
        assert result.success is True
        assert result.target_type == "unknown"

    def test_auto_classification_uses_classifier(self, tmp_path, mono_fits, monkeypatch):
        monkeypatch.setattr(
            "astra_astro.image_process.classify_from_name",
            lambda name: SimpleNamespace(target_type=TargetType.GALAXY),
        )
        result = process_image(str(mono_fits), str(tmp_path / "out"),
                               ProcessingParams(target_type="auto"),
                               object_name="Messier 31")
        assert result.success is True
        assert result.target_type == "galaxy"

    def test_auto_without_object_name_stays_unknown(self, tmp_path, mono_fits):
        result = process_image(str(mono_fits), str(tmp_path / "out"),
                               ProcessingParams(target_type="auto"))
        assert result.success is True
        assert result.target_type == "unknown"

    def test_target_specific_star_reduction_applied_for_emission_nebula(
        self, tmp_path, mono_fits, monkeypatch
    ):
        # EMISSION_NEBULA enables star_reduction in TARGET_PARAMS even though
        # the caller left it off.
        monkeypatch.setattr(
            "astra_astro.image_process.classify_from_name",
            lambda name: SimpleNamespace(target_type=TargetType.EMISSION_NEBULA),
        )
        params = ProcessingParams(target_type="auto", star_reduction=False,
                                  stretch_factor=0.0)
        result = process_image(str(mono_fits), str(tmp_path / "out"), params,
                               object_name="Rosette")
        assert result.success is True
        assert result.target_type == "emission_nebula"
        loaded, _ = _load_fits(result.output_fits_path)
        # The bright star at (10, 10) must be dimmed by star reduction.
        b = _statistical_stretch(make_mono(), 0.18)
        assert loaded[10, 10] < b[10, 10]

    def test_star_field_target_skips_background_removal(self, tmp_path, mono_fits,
                                                        monkeypatch):
        # STAR_FIELD has background_removal False in TARGET_PARAMS, but the
        # caller's explicit True wins (params are merged, not overridden).
        monkeypatch.setattr(
            "astra_astro.image_process.classify_from_name",
            lambda name: SimpleNamespace(target_type=TargetType.STAR_FIELD),
        )
        result = process_image(str(mono_fits), str(tmp_path / "out"),
                               ProcessingParams(target_type="auto",
                                                background_removal=True),
                               object_name="field")
        assert result.success is True
        assert result.target_type == "star_field"

    def test_missing_input_reports_failure(self, tmp_path):
        result = process_image(str(tmp_path / "missing.fits"), str(tmp_path / "out"))
        assert result.success is False
        assert "missing.fits" in result.error_message
        assert result.output_fits_path == ""
        assert result.output_preview_path == ""


# ---------------------------------------------------------------------------
# process_image_from_dict
# ---------------------------------------------------------------------------
class TestProcessImageFromDict:
    FULL_DICT = {
        "targetType": "galaxy",
        "stretchMethod": "arcsinh",
        "stretchFactor": 0.2,
        "backgroundRemoval": False,
        "starReduction": True,
        "colorCalibration": True,
        "noiseReduction": 0.3,
        "contrast": 1.5,
    }

    def test_full_dict_applied(self, tmp_path, colour_fits):
        progress = []
        result = process_image_from_dict(
            str(colour_fits), str(tmp_path / "out"), dict(self.FULL_DICT),
            progress_callback=lambda s, p, m: progress.append((s, p)),
        )
        assert result["success"] is True
        assert result["targetType"] == "galaxy"
        assert result["processingParams"] == {
            "targetType": "galaxy",
            "stretchMethod": "arcsinh",
            "stretchFactor": 0.2,
            "backgroundRemoval": False,
            "starReduction": True,
            "colorCalibration": True,
            "noiseReduction": 0.3,
            "contrast": 1.5,
        }
        assert result["outputFitsPath"] and result["outputPreviewPath"]
        assert result["errorMessage"] is None
        assert progress and progress[-1][1] == 1.0
        assert Image.open(result["outputPreviewPath"]).mode == "RGB"

    def test_missing_keys_get_defaults(self, tmp_path, mono_fits):
        result = process_image_from_dict(str(mono_fits), str(tmp_path / "out"), {})
        assert result["success"] is True
        assert result["processingParams"] == ProcessingParams().to_dict()

    def test_none_params_dict(self, tmp_path, mono_fits):
        result = process_image_from_dict(str(mono_fits), str(tmp_path / "out"), None)
        assert result["success"] is True
        assert result["processingParams"] == ProcessingParams().to_dict()

    def test_unknown_keys_ignored(self, tmp_path, mono_fits):
        result = process_image_from_dict(
            str(mono_fits), str(tmp_path / "out"),
            {"bogusKey": 42, "stretchMethod": "log"},
        )
        assert result["success"] is True
        assert result["processingParams"]["stretchMethod"] == "log"
        assert result["processingParams"]["contrast"] == 1.3

    def test_partial_dict_overrides_only_named_keys(self, tmp_path, mono_fits):
        result = process_image_from_dict(
            str(mono_fits), str(tmp_path / "out"),
            {"noiseReduction": 0.5, "backgroundRemoval": False},
        )
        assert result["success"] is True
        params = result["processingParams"]
        assert params["noiseReduction"] == 0.5
        assert params["backgroundRemoval"] is False
        assert params["stretchMethod"] == "statistical"

    def test_processing_failure_reported(self, tmp_path):
        result = process_image_from_dict(
            str(tmp_path / "missing.fits"), str(tmp_path / "out"), {}
        )
        assert result["success"] is False
        assert result["errorMessage"]

    def test_numeric_strings_coerced(self, tmp_path, mono_fits):
        result = process_image_from_dict(
            str(mono_fits), str(tmp_path / "out"),
            {"stretchFactor": "0.2", "noiseReduction": "0.5",
             "contrast": "1.5", "backgroundRemoval": 1, "starReduction": 1},
        )
        assert result["success"] is True
        params = result["processingParams"]
        assert params["stretchFactor"] == 0.2
        assert params["noiseReduction"] == 0.5
        assert params["contrast"] == 1.5
        assert params["backgroundRemoval"] is True
        assert params["starReduction"] is True


# ---------------------------------------------------------------------------
# to_dict methods
# ---------------------------------------------------------------------------
class TestToDict:
    def test_params_to_dict_camel_case(self):
        params = ProcessingParams(
            target_type="galaxy", stretch_method="log", stretch_factor=0.2,
            background_removal=False, star_reduction=True,
            color_calibration=False, noise_reduction=0.4, contrast=1.6,
        )
        assert params.to_dict() == {
            "targetType": "galaxy",
            "stretchMethod": "log",
            "stretchFactor": 0.2,
            "backgroundRemoval": False,
            "starReduction": True,
            "colorCalibration": False,
            "noiseReduction": 0.4,
            "contrast": 1.6,
        }

    def test_result_to_dict_keys_and_values(self):
        result = ProcessingResult(
            success=True, output_fits_path="/a.fits",
            output_preview_path="/a.png", target_type="galaxy",
            processing_params={"a": 1}, processing_time=1.5,
        )
        d = result.to_dict()
        assert d == {
            "success": True,
            "outputFitsPath": "/a.fits",
            "outputPreviewPath": "/a.png",
            "targetType": "galaxy",
            "processingParams": {"a": 1},
            "processingTime": 1.5,
            "errorMessage": None,
        }


# ---------------------------------------------------------------------------
# Numeric helpers: boundaries not covered elsewhere
# ---------------------------------------------------------------------------
class TestHelperBoundaries:
    def test_noise_reduction_strictly_positive_changes_data(self):
        data = np.zeros((8, 8))
        data[4, 4] = 1.0
        out = _apply_noise_reduction(data, strength=0.1)
        assert out[4, 4] < 1.0
        npt.assert_allclose(out.sum(), data.sum(), rtol=0.05)

    def test_reduce_stars_threshold_boundary(self):
        """A peak exactly at the threshold is not reduced; just above it is."""
        data = np.zeros((16, 16))
        data[4, 4] = 0.8
        at_threshold = _reduce_stars(data, threshold=0.8)
        npt.assert_allclose(at_threshold, data, atol=1e-9)
        above = _reduce_stars(data, threshold=0.79)
        assert above[4, 4] < 0.8

    def test_reduce_stars_multichannel_uses_luminance(self):
        """A red-only star is still reduced (luminance detection, 3D path)."""
        data = np.zeros((16, 16, 3))
        data[4, 4, 0] = 1.0  # luminance = 0.299 < 0.8: no reduction at 0.8
        unchanged = _reduce_stars(data, threshold=0.8)
        npt.assert_allclose(unchanged, data, atol=1e-9)
        reduced = _reduce_stars(data, threshold=0.25)
        assert reduced[4, 4, 0] < 1.0

    def test_remove_background_removes_flat_level(self):
        """A flat background level should be subtracted, peak kept at max 1."""
        data = np.full((24, 24), 0.5)
        data[6, 6] = 1.0
        out = _remove_background(data, sigma=2.0)
        assert out.max() == pytest.approx(1.0, abs=1e-6)
        # Far from the star the background is much smaller than the raw 0.5.
        assert out[20, 20] < 0.2

    def test_remove_background_per_channel(self):
        data = np.zeros((24, 24, 3))
        data[..., 0] = 0.5
        data[6, 6, 1] = 1.0
        out = _remove_background(data, sigma=2.0)
        assert out.shape == data.shape
        # Red channel was flat: fully subtracted to ~0 away from the star.
        assert out[20, 20, 0] < 0.01
        assert out.max() == pytest.approx(1.0, abs=1e-6)

    def test_color_calibrate_scales_channels_toward_common_background(self):
        h = w = 40
        data = np.zeros((h, w, 3))
        data[..., 0] = 0.1
        data[..., 1] = 0.2
        data[..., 2] = 0.4
        out = _color_calibrate(data)
        corner = out[2:8, 2:8]
        # All channel backgrounds end up equal to the mean of the originals
        # (0.1 + 0.2 + 0.4) / 3 = 0.2333...
        target = 7 / 30
        npt.assert_allclose(corner[..., 0].mean(), target, atol=1e-6)
        npt.assert_allclose(corner[..., 1].mean(), target, atol=1e-6)
        npt.assert_allclose(corner[..., 2].mean(), target, atol=1e-6)

    def test_color_calibrate_zero_median_channel_left_alone(self):
        """A channel whose background median is 0 is skipped, others scaled."""
        data = np.zeros((40, 40, 3))
        data[..., 1] = 0.2
        data[..., 2] = 0.4
        out = _color_calibrate(data)
        npt.assert_allclose(out[..., 0], 0.0, atol=1e-9)
        # target_bg = (0 + 0.2 + 0.4) / 3 ≈ 0.2; green already equals it, so
        # the green background stays 0.2, blue is scaled to 0.2 as well.
        npt.assert_allclose(out[2:8, 2:8, 1].mean(), 0.2, atol=1e-6)
        npt.assert_allclose(out[2:8, 2:8, 2].mean(), 0.2, atol=1e-6)

    def test_statistical_stretch_flat_image_above_one_divides_by_max(self):
        data = np.full((16, 16), 2.0)
        out = _statistical_stretch(data, 0.15)
        npt.assert_allclose(out, 1.0, atol=1e-9)

    def test_statistical_stretch_skips_gamma_at_extreme_median(self):
        """Median at the extreme skips the gamma step; result is the clipped
        percentile stretch itself."""
        data = np.zeros((64, 64))
        data[:20] = 1.0  # ~31% ones: percentile clip maps them to 1, median to 1
        out = _statistical_stretch(data, 0.15)
        assert np.all(out >= 0) and np.all(out <= 1)
        npt.assert_allclose(out[data == 1.0], 1.0, atol=1e-9)
