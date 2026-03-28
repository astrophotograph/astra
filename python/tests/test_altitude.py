"""Tests for astra_astro.altitude pure functions."""

import pytest

from astra_astro.altitude import _azimuth_to_compass


class TestAzimuthToCompass:
    def test_north(self):
        assert _azimuth_to_compass(0.0) == "N"

    def test_north_360(self):
        assert _azimuth_to_compass(360.0) == "N"

    def test_east(self):
        assert _azimuth_to_compass(90.0) == "E"

    def test_south(self):
        assert _azimuth_to_compass(180.0) == "S"

    def test_west(self):
        assert _azimuth_to_compass(270.0) == "W"

    def test_northeast(self):
        assert _azimuth_to_compass(45.0) == "NE"

    def test_southeast(self):
        assert _azimuth_to_compass(135.0) == "SE"

    def test_southwest(self):
        assert _azimuth_to_compass(225.0) == "SW"

    def test_northwest(self):
        assert _azimuth_to_compass(315.0) == "NW"

    def test_nne(self):
        assert _azimuth_to_compass(22.5) == "NNE"

    def test_sse(self):
        assert _azimuth_to_compass(157.5) == "SSE"

    def test_near_boundary(self):
        """Values near a boundary should round to the nearest direction."""
        # 11 degrees is closer to N (0) than NNE (22.5)
        assert _azimuth_to_compass(11.0) == "N"
        # 12 is right on the rounding boundary: 12/22.5 = 0.533 -> rounds to 1 = NNE
        assert _azimuth_to_compass(12.0) == "NNE"

    def test_all_16_directions(self):
        """Each 22.5-degree increment should yield the correct direction."""
        expected = [
            "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
            "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
        ]
        for i, direction in enumerate(expected):
            azimuth = i * 22.5
            assert _azimuth_to_compass(azimuth) == direction, (
                f"Expected {direction} at {azimuth} degrees"
            )
