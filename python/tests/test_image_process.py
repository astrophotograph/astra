"""Tests for astra_astro.image_process pure functions."""

import numpy as np
import numpy.testing as npt
import pytest

from astra_astro.image_process import (
    _apply_contrast_curve,
    _apply_noise_reduction,
    _arcsinh_stretch,
    _calculate_mtf_balance,
    _color_calibrate,
    _log_stretch,
    _mtf,
    _reduce_stars,
    _remove_background,
    _statistical_stretch,
)


# ---------------------------------------------------------------------------
# _mtf
# ---------------------------------------------------------------------------
class TestMtf:
    def test_zero_input(self):
        """MTF of 0 should be 0."""
        result = _mtf(0.5, np.array([0.0]))
        npt.assert_allclose(result, [0.0], atol=1e-6)

    def test_one_input(self):
        """MTF of 1 should be 1."""
        result = _mtf(0.5, np.array([1.0]))
        npt.assert_allclose(result, [1.0], atol=1e-6)

    def test_midpoint_with_m_half(self):
        """MTF(0.5, 0.5) should equal 0.5."""
        result = _mtf(0.5, np.array([0.5]))
        npt.assert_allclose(result, [0.5], atol=1e-6)

    def test_monotonic(self):
        """MTF should be monotonically increasing for 0 < m < 1."""
        x = np.linspace(0, 1, 100)
        result = _mtf(0.3, x)
        diff = np.diff(result)
        assert np.all(diff >= -1e-10), "MTF should be monotonically increasing"

    def test_output_range(self):
        """MTF output should be clipped to [0, 1]."""
        x = np.linspace(0, 1, 50)
        for m in [0.1, 0.3, 0.5, 0.7, 0.9]:
            result = _mtf(m, x)
            assert np.all(result >= 0), f"MTF output < 0 for m={m}"
            assert np.all(result <= 1), f"MTF output > 1 for m={m}"

    def test_low_m_brightens(self):
        """Low m (< 0.5) should brighten midtones (output > input)."""
        x = np.array([0.25])
        result = _mtf(0.2, x)
        assert result[0] > x[0], "Low m should brighten midtones"

    def test_high_m_darkens(self):
        """High m (> 0.5) should darken midtones (output < input)."""
        x = np.array([0.75])
        result = _mtf(0.8, x)
        assert result[0] < x[0], "High m should darken midtones"

    def test_array_input(self):
        """MTF should work on arrays."""
        x = np.array([0.0, 0.25, 0.5, 0.75, 1.0])
        result = _mtf(0.5, x)
        assert result.shape == x.shape


# ---------------------------------------------------------------------------
# _calculate_mtf_balance
# ---------------------------------------------------------------------------
class TestCalculateMtfBalance:
    def test_returns_float(self):
        result = _calculate_mtf_balance(0.1, 0.25)
        assert isinstance(result, (float, np.floating))

    def test_extreme_median_zero(self):
        """Median <= 0 should return 0.5."""
        assert _calculate_mtf_balance(0.0, 0.25) == 0.5

    def test_extreme_median_one(self):
        """Median >= 1 should return 0.5."""
        assert _calculate_mtf_balance(1.0, 0.25) == 0.5

    def test_result_range(self):
        """Result should be in (0, 1)."""
        for median in [0.01, 0.1, 0.3, 0.5, 0.8, 0.99]:
            for target in [0.1, 0.2, 0.5]:
                m = _calculate_mtf_balance(median, target)
                assert 0 < m < 1, f"m={m} out of range for median={median}, target={target}"

    def test_roundtrip(self):
        """MTF(m, median) should approximately equal target."""
        median = 0.1
        target = 0.25
        m = _calculate_mtf_balance(median, target)
        result = _mtf(m, np.array([median]))
        npt.assert_allclose(result[0], target, atol=0.01)


# ---------------------------------------------------------------------------
# _statistical_stretch
# ---------------------------------------------------------------------------
class TestStatisticalStretch:
    def test_output_range(self):
        """Output should be in [0, 1]."""
        data = np.random.default_rng(42).uniform(0, 1, (100, 100))
        result = _statistical_stretch(data, 0.15)
        assert np.all(result >= 0)
        assert np.all(result <= 1)

    def test_flat_image(self):
        """Flat image should not crash."""
        data = np.full((50, 50), 0.5)
        result = _statistical_stretch(data, 0.15)
        assert result.shape == data.shape

    def test_all_zeros(self):
        """All zeros should not crash."""
        data = np.zeros((50, 50))
        result = _statistical_stretch(data, 0.15)
        assert result.shape == data.shape

    def test_preserves_shape(self):
        data = np.random.default_rng(42).uniform(0, 1, (64, 64, 3))
        result = _statistical_stretch(data, 0.15)
        assert result.shape == data.shape


# ---------------------------------------------------------------------------
# _arcsinh_stretch
# ---------------------------------------------------------------------------
class TestArcsinhStretch:
    def test_output_range(self):
        x = np.linspace(0, 1, 100)
        result = _arcsinh_stretch(x, 0.15)
        assert np.all(result >= 0)
        assert np.all(result <= 1)

    def test_zero_stays_zero(self):
        result = _arcsinh_stretch(np.array([0.0]), 0.15)
        npt.assert_allclose(result, [0.0], atol=1e-8)

    def test_one_stays_one(self):
        result = _arcsinh_stretch(np.array([1.0]), 0.15)
        npt.assert_allclose(result, [1.0], atol=1e-6)

    def test_negative_factor_defaults(self):
        """Factor <= 0 should default to 0.15."""
        x = np.array([0.5])
        r1 = _arcsinh_stretch(x, -1.0)
        r2 = _arcsinh_stretch(x, 0.15)
        npt.assert_allclose(r1, r2)

    def test_monotonic(self):
        x = np.linspace(0, 1, 100)
        result = _arcsinh_stretch(x, 0.15)
        assert np.all(np.diff(result) >= -1e-10)


# ---------------------------------------------------------------------------
# _log_stretch
# ---------------------------------------------------------------------------
class TestLogStretch:
    def test_output_range(self):
        x = np.linspace(0, 1, 100)
        result = _log_stretch(x, 0.15)
        assert np.all(result >= 0)
        assert np.all(result <= 1)

    def test_one_maps_to_one(self):
        result = _log_stretch(np.array([1.0]), 0.15)
        npt.assert_allclose(result, [1.0], atol=1e-6)

    def test_monotonic(self):
        x = np.linspace(0, 1, 100)
        result = _log_stretch(x, 0.15)
        assert np.all(np.diff(result) >= -1e-10)


# ---------------------------------------------------------------------------
# _remove_background
# ---------------------------------------------------------------------------
class TestRemoveBackground:
    def test_output_normalized(self):
        """Output should have max ~1 (normalized)."""
        rng = np.random.default_rng(42)
        data = rng.uniform(0, 1, (50, 50))
        result = _remove_background(data, sigma=5.0)
        npt.assert_allclose(np.max(result), 1.0, atol=1e-6)

    def test_multichannel(self):
        """Should handle 3-channel images."""
        data = np.random.default_rng(42).uniform(0, 1, (50, 50, 3))
        result = _remove_background(data, sigma=5.0)
        assert result.shape == data.shape

    def test_2d(self):
        data = np.random.default_rng(42).uniform(0, 1, (50, 50))
        result = _remove_background(data, sigma=5.0)
        assert result.shape == data.shape

    def test_all_zeros(self):
        """All zeros should return all zeros (no division by zero)."""
        data = np.zeros((30, 30))
        result = _remove_background(data, sigma=5.0)
        npt.assert_allclose(result, 0.0)


# ---------------------------------------------------------------------------
# _color_calibrate
# ---------------------------------------------------------------------------
class TestColorCalibrate:
    def test_non_rgb_passthrough(self):
        """Non-RGB input should be returned unchanged."""
        data = np.ones((50, 50))
        result = _color_calibrate(data)
        npt.assert_array_equal(result, data)

    def test_rgb_shape_preserved(self):
        data = np.random.default_rng(42).uniform(0.1, 0.9, (50, 50, 3))
        result = _color_calibrate(data)
        assert result.shape == data.shape

    def test_uniform_image_unchanged(self):
        """Uniform RGB image should remain mostly unchanged."""
        data = np.full((50, 50, 3), 0.5)
        result = _color_calibrate(data)
        npt.assert_allclose(result, data, atol=1e-6)

    def test_output_clipped(self):
        """Output should be clipped to [0, 1]."""
        data = np.random.default_rng(42).uniform(0.1, 0.9, (50, 50, 3))
        result = _color_calibrate(data)
        assert np.all(result >= 0)
        assert np.all(result <= 1)

    def test_all_zeros_passthrough(self):
        """All zeros (target_bg == 0) should return original data."""
        data = np.zeros((50, 50, 3))
        result = _color_calibrate(data)
        npt.assert_array_equal(result, data)


# ---------------------------------------------------------------------------
# _apply_noise_reduction
# ---------------------------------------------------------------------------
class TestApplyNoiseReduction:
    def test_zero_strength_passthrough(self):
        data = np.random.default_rng(42).uniform(0, 1, (50, 50))
        result = _apply_noise_reduction(data, strength=0.0)
        npt.assert_array_equal(result, data)

    def test_reduces_noise(self):
        """Noise reduction should decrease standard deviation."""
        rng = np.random.default_rng(42)
        data = rng.uniform(0, 1, (100, 100))
        result = _apply_noise_reduction(data, strength=0.5)
        assert np.std(result) < np.std(data)

    def test_multichannel(self):
        data = np.random.default_rng(42).uniform(0, 1, (50, 50, 3))
        result = _apply_noise_reduction(data, strength=0.5)
        assert result.shape == data.shape

    def test_negative_strength_passthrough(self):
        data = np.random.default_rng(42).uniform(0, 1, (50, 50))
        result = _apply_noise_reduction(data, strength=-0.5)
        npt.assert_array_equal(result, data)


# ---------------------------------------------------------------------------
# _apply_contrast_curve
# ---------------------------------------------------------------------------
class TestApplyContrastCurve:
    def test_no_change_at_1(self):
        """Strength 1.0 should return data unchanged."""
        data = np.array([0.2, 0.5, 0.8])
        result = _apply_contrast_curve(data, strength=1.0)
        npt.assert_array_equal(result, data)

    def test_below_1_returns_unchanged(self):
        """Strength < 1.0 should return data unchanged."""
        data = np.array([0.2, 0.5, 0.8])
        result = _apply_contrast_curve(data, strength=0.5)
        npt.assert_array_equal(result, data)

    def test_increases_spread(self):
        """Strength > 1 should increase standard deviation (before clipping)."""
        data = np.array([0.3, 0.4, 0.5, 0.6, 0.7])
        result = _apply_contrast_curve(data, strength=1.5)
        assert np.std(result) > np.std(data)

    def test_mean_preserved(self):
        """Mean should be preserved (before clipping effects)."""
        data = np.array([0.3, 0.4, 0.5, 0.6, 0.7])
        result = _apply_contrast_curve(data, strength=1.3)
        npt.assert_allclose(np.mean(result), np.mean(data), atol=1e-6)

    def test_output_clipped(self):
        data = np.array([0.0, 0.5, 1.0])
        result = _apply_contrast_curve(data, strength=2.0)
        assert np.all(result >= 0)
        assert np.all(result <= 1)


# ---------------------------------------------------------------------------
# _reduce_stars
# ---------------------------------------------------------------------------
class TestReduceStars:
    def test_output_range(self):
        data = np.random.default_rng(42).uniform(0, 1, (50, 50))
        result = _reduce_stars(data, threshold=0.8)
        assert np.all(result >= 0)
        assert np.all(result <= 1)

    def test_bright_peaks_reduced(self):
        """Bright isolated peaks should have lower values after reduction."""
        data = np.zeros((50, 50))
        data[25, 25] = 1.0  # single bright star
        result = _reduce_stars(data, threshold=0.5)
        assert result[25, 25] < 1.0

    def test_multichannel(self):
        data = np.random.default_rng(42).uniform(0, 1, (50, 50, 3))
        result = _reduce_stars(data, threshold=0.8)
        assert result.shape == data.shape

    def test_all_below_threshold_unchanged(self):
        """Data all below threshold should be mostly unchanged."""
        data = np.full((50, 50), 0.3)
        result = _reduce_stars(data, threshold=0.8)
        # All values identical means no peaks detected, reduction map is all 1s
        npt.assert_allclose(result, data, atol=0.05)
