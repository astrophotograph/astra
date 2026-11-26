"""Tests for astra_astro.altitude.

The module calls ``load("de421.bsp")``, which downloads an ephemeris from the
network.  Tests patch ``astra_astro.altitude.load`` so that it returns one of
the small real JPL kernels that ship with skyfield's own test data
(``de430-2015-03-02.bsp``, covering 2015-02-19 .. 2015-03-07).  All fixed
dates below therefore sit in early March 2015.
"""

import math
import os
from datetime import datetime, timedelta, timezone

import pytest
import skyfield.api as skyfield_api
from skyfield.api import load_file

from astra_astro import altitude
from astra_astro.altitude import AltitudePoint, ObserverLocation, _azimuth_to_compass

KERNEL_PATH = os.path.join(
    os.path.dirname(skyfield_api.__file__), "tests", "data", "de430-2015-03-02.bsp"
)

# Boulder, Colorado
BOULDER = ObserverLocation(latitude=40.0, longitude=-105.26)
UTC = timezone.utc


@pytest.fixture(autouse=True)
def offline_ephemeris(monkeypatch):
    """Serve the bundled real kernel instead of downloading de421.bsp."""

    real_load = skyfield_api.load

    class _OfflineLoad:
        timescale = staticmethod(real_load.timescale)

        def __call__(self, filename):
            return load_file(KERNEL_PATH)

    monkeypatch.setattr(altitude, "load", _OfflineLoad())


@pytest.fixture
def freeze_now(monkeypatch):
    """Fix datetime.now() inside astra_astro.altitude to a chosen instant."""

    def freeze(dt):
        fixed = dt if dt.tzinfo else dt.replace(tzinfo=UTC)

        class _FixedDatetime(datetime):
            @classmethod
            def now(cls, tz=None):
                return fixed

        monkeypatch.setattr(altitude, "datetime", _FixedDatetime)

    return freeze


# ---------------------------------------------------------------------------
# Independent geometric reference: GMST from the Astronomical Almanac
# polynomial and the standard spherical-triangle transformation.  The module's
# result is "apparent" (includes refraction and aberration), so comparisons
# allow 0.5 degrees; refraction is at most ~0.3 degrees below 10 deg altitude.
# ---------------------------------------------------------------------------


def _julian_day(dt):
    year, month = dt.year, dt.month
    a = (14 - month) // 12
    yr = year + 4800 - a
    m = month + 12 * a - 3
    day_number = dt.day + (153 * m + 2) // 5 + 365 * yr + yr // 4 - yr // 100 + yr // 400 - 32045
    frac = (dt.hour - 12) / 24 + dt.minute / 1440 + dt.second / 86400
    return day_number + frac


def _expected_altaz(ra_deg, dec_deg, lat_deg, lon_deg, dt):
    """Geometric altitude and azimuth (degrees, azimuth from North) of a star."""
    gmst = (280.46061837 + 360.98564736629 * (_julian_day(dt) - 2451545.0)) % 360.0
    hour_angle = (gmst + lon_deg - ra_deg + 180.0) % 360.0 - 180.0
    lat = math.radians(lat_deg)
    dec = math.radians(dec_deg)
    ha = math.radians(hour_angle)
    sin_alt = math.sin(lat) * math.sin(dec) + math.cos(lat) * math.cos(dec) * math.cos(ha)
    alt = math.degrees(math.asin(max(-1.0, min(1.0, sin_alt))))
    az_from_south = math.degrees(
        math.atan2(math.sin(ha), math.cos(ha) * math.sin(lat) - math.tan(dec) * math.cos(lat))
    )
    return alt, (az_from_south + 180.0) % 360.0


def _assert_close_angles(actual, expected, tol=0.5):
    assert abs(((actual - expected + 180.0) % 360.0) - 180.0) < tol, (
        f"{actual} not within {tol} of {expected}"
    )


def _near(iso_string, expected_iso, seconds=120):
    """True when the ISO timestamp is within ``seconds`` of ``expected_iso``."""
    assert iso_string is not None
    actual = datetime.fromisoformat(iso_string)
    expected = datetime.fromisoformat(expected_iso)
    assert abs(actual - expected) < timedelta(seconds=seconds), (
        f"{iso_string} not within {seconds}s of {expected_iso}"
    )


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
        # fmt: off
        expected = [
            "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
            "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
        ]
        # fmt: on
        for i, direction in enumerate(expected):
            azimuth = i * 22.5
            assert _azimuth_to_compass(azimuth) == direction, (
                f"Expected {direction} at {azimuth} degrees"
            )


class TestDataclasses:
    def test_observer_location_to_dict_all_keys(self):
        loc = ObserverLocation(latitude=-33.9, longitude=151.2, elevation=580.0, name="Sydney")
        assert loc.to_dict() == {
            "latitude": -33.9,
            "longitude": 151.2,
            "elevation": 580.0,
            "name": "Sydney",
        }

    def test_observer_location_defaults(self):
        loc = ObserverLocation(latitude=10.0, longitude=20.0)
        assert loc.to_dict() == {
            "latitude": 10.0,
            "longitude": 20.0,
            "elevation": 0,
            "name": None,
        }

    def test_altitude_point_to_dict_all_keys(self):
        point = AltitudePoint(
            time="2015-03-05T02:10:00+00:00",
            altitude=59.99,
            azimuth=179.1,
            compass_direction="S",
        )
        assert point.to_dict() == {
            "time": "2015-03-05T02:10:00+00:00",
            "altitude": 59.99,
            "azimuth": 179.1,
            "compassDirection": "S",
        }


class TestCalculateAltitude:
    def test_result_has_all_keys(self):
        result = altitude.calculate_altitude(
            90.0, 10.0, BOULDER, datetime(2015, 3, 5, 2, 10, tzinfo=UTC)
        )
        assert set(result) == {"time", "altitude", "azimuth", "compassDirection"}
        assert result["time"] == "2015-03-05T02:10:00+00:00"

    @pytest.mark.parametrize(
        "ra,dec,lat,lon,moment",
        [
            # Transit of a dec=+10 star as seen from lat +40: altitude 60 deg, due S
            (90.0, 10.0, 40.0, -105.26, datetime(2015, 3, 5, 2, 10, tzinfo=UTC)),
            # Six hours past transit, west of the meridian
            (90.0, 10.0, 40.0, -105.26, datetime(2015, 3, 5, 8, 10, tzinfo=UTC)),
            # Before transit, east of the meridian
            (90.0, 10.0, 40.0, -105.26, datetime(2015, 3, 5, 20, 10, tzinfo=UTC)),
            # Southern-hemisphere observer (lat < 0), eastern longitude (lon > 0)
            (90.0, -33.0, -33.0, 151.2, datetime(2015, 3, 5, 6, 0, tzinfo=UTC)),
            # Northern observer, eastern longitude, star below the horizon
            (45.0, -10.0, 64.0, 21.0, datetime(2015, 3, 6, 3, 30, tzinfo=UTC)),
        ],
    )
    def test_matches_independent_geometric_calculation(self, ra, dec, lat, lon, moment):
        result = altitude.calculate_altitude(
            ra, dec, ObserverLocation(latitude=lat, longitude=lon, elevation=100), moment
        )
        expected_alt, expected_az = _expected_altaz(ra, dec, lat, lon, moment)
        assert result["altitude"] == pytest.approx(expected_alt, abs=0.5)
        _assert_close_angles(result["azimuth"], expected_az)

    def test_star_at_zenith_reaches_ninety_degrees(self):
        """A star whose declination equals the latitude culminates at the zenith."""
        result = altitude.calculate_altitude(
            90.0, 40.0, BOULDER, datetime(2015, 3, 5, 2, 10, tzinfo=UTC)
        )
        assert result["altitude"] == pytest.approx(90.0, abs=0.5)

    def test_polaris_altitude_equals_latitude_at_any_hour(self):
        """A +90-declination star stands at the pole: altitude == latitude."""
        for hour in (0, 6, 12, 18):
            result = altitude.calculate_altitude(
                37.95, 89.99, BOULDER, datetime(2015, 3, 5, hour, tzinfo=UTC)
            )
            assert result["altitude"] == pytest.approx(40.0, abs=0.3)

    def test_naive_datetime_is_treated_as_utc(self):
        naive = altitude.calculate_altitude(90.0, 10.0, BOULDER, datetime(2015, 3, 5, 2, 10))
        aware = altitude.calculate_altitude(
            90.0, 10.0, BOULDER, datetime(2015, 3, 5, 2, 10, tzinfo=UTC)
        )
        assert naive["time"].endswith("+00:00")
        assert naive["altitude"] == aware["altitude"]
        _assert_close_angles(naive["azimuth"], aware["azimuth"], tol=0.01)

    def test_default_time_is_fixed_now(self, freeze_now):
        freeze_now(datetime(2015, 3, 5, 2, 10, tzinfo=UTC))
        result = altitude.calculate_altitude(90.0, 10.0, BOULDER)
        expected_alt, expected_az = _expected_altaz(
            90.0, 10.0, 40.0, -105.26, datetime(2015, 3, 5, 2, 10, tzinfo=UTC)
        )
        assert result["time"] == "2015-03-05T02:10:00+00:00"
        assert result["altitude"] == pytest.approx(expected_alt, abs=0.5)
        _assert_close_angles(result["azimuth"], expected_az)


class TestCalculateAltitudeData:
    def test_point_count_times_and_spacing(self):
        points = altitude.calculate_altitude_data(
            90.0,
            10.0,
            BOULDER,
            start_time=datetime(2015, 3, 5, 2, 0, tzinfo=UTC),
            duration_hours=2,
            interval_minutes=30,
        )
        # (2 h * 60 min / 30 min) + 1 endpoints
        assert len(points) == 5
        times = [datetime.fromisoformat(p["time"]) for p in points]
        assert times == sorted(times)
        for first, second in zip(times, times[1:]):
            assert second - first == timedelta(minutes=30)
        assert times[0] == datetime(2015, 3, 5, 2, 0, tzinfo=UTC)
        assert times[-1] == datetime(2015, 3, 5, 4, 0, tzinfo=UTC)

    def test_step_larger_than_window_yields_only_the_start_point(self):
        # int(2 h * 60 / 121 min) = 0, so only the start point plus nothing else
        points = altitude.calculate_altitude_data(
            90.0,
            10.0,
            BOULDER,
            start_time=datetime(2015, 3, 5, 2, 0, tzinfo=UTC),
            duration_hours=2,
            interval_minutes=121,
        )
        assert len(points) == 1
        assert points[0]["time"] == "2015-03-05T02:00:00+00:00"

    def test_longer_window_has_expected_point_count(self):
        points = altitude.calculate_altitude_data(
            90.0,
            10.0,
            BOULDER,
            start_time=datetime(2015, 3, 5, 0, 0, tzinfo=UTC),
            duration_hours=12,
            interval_minutes=15,
        )
        assert len(points) == 49

    def test_maximum_at_transit_inside_window(self):
        """The dec=+10 star transits ~02:09 UTC from Boulder; max alt is ~60 deg."""
        points = altitude.calculate_altitude_data(
            90.0,
            10.0,
            BOULDER,
            start_time=datetime(2015, 3, 5, 1, 0, tzinfo=UTC),
            duration_hours=2,
            interval_minutes=15,
        )
        top = max(points, key=lambda p: p["altitude"])
        assert top["altitude"] == pytest.approx(60.0, abs=0.5)
        # The transit (~02:10 UTC) falls between the 15-minute sample points;
        # the sampled maximum must be within one step of it.
        top_time = datetime.fromisoformat(top["time"])
        assert abs(top_time - datetime(2015, 3, 5, 2, 10, tzinfo=UTC)) <= timedelta(minutes=15)
        # Near the meridian the star is due south
        assert top["compassDirection"] == "S"

    def test_values_match_independent_calculation(self):
        points = altitude.calculate_altitude_data(
            45.0,
            -10.0,
            ObserverLocation(latitude=64.0, longitude=21.0, elevation=250),
            start_time=datetime(2015, 3, 6, 3, 30, tzinfo=UTC),
            duration_hours=1,
            interval_minutes=60,
        )
        assert len(points) == 2
        for point in points:
            dt = datetime.fromisoformat(point["time"])
            expected_alt, expected_az = _expected_altaz(45.0, -10.0, 64.0, 21.0, dt)
            assert point["altitude"] == pytest.approx(expected_alt, abs=0.5)
            _assert_close_angles(point["azimuth"], expected_az)

    def test_naive_start_time_treated_as_utc(self):
        naive = altitude.calculate_altitude_data(
            90.0,
            10.0,
            BOULDER,
            start_time=datetime(2015, 3, 5, 2, 0),
            duration_hours=1,
            interval_minutes=60,
        )
        aware = altitude.calculate_altitude_data(
            90.0,
            10.0,
            BOULDER,
            start_time=datetime(2015, 3, 5, 2, 0, tzinfo=UTC),
            duration_hours=1,
            interval_minutes=60,
        )
        assert [p["time"] for p in naive] == [p["time"] for p in aware]
        assert naive[0]["altitude"] == aware[0]["altitude"]

    def test_default_start_is_a_sun_event(self, freeze_now):
        """With no start_time the first point lands on the next sunset.

        now is 20:00 UTC (13:00 local); the next horizon crossing is the Mar 6
        sunset at 00:57 UTC, so this pins the neighbouring (already right) case.
        """
        freeze_now(datetime(2015, 3, 5, 20, 0, tzinfo=UTC))
        points = altitude.calculate_altitude_data(90.0, 10.0, BOULDER)
        assert len(points) == 49  # 12 h at 15 min steps, plus the endpoint
        first = datetime.fromisoformat(points[0]["time"])
        # Independent horizon crossings in the window (from the same kernel):
        sunset = datetime(2015, 3, 6, 0, 57, 5, tzinfo=UTC)
        sunrise = datetime(2015, 3, 6, 13, 27, 3, tzinfo=UTC)
        assert abs(first - sunset) < timedelta(minutes=2)
        assert abs(first - sunrise) > timedelta(hours=1)

    def test_default_start_skips_earlier_sunrise(self, freeze_now):
        """A few hours after local midnight the next sunset is the next day's;
        the window must not start at the sunrise in between."""
        freeze_now(datetime(2015, 3, 6, 10, 0, tzinfo=UTC))  # 03:00 local Mar 6
        points = altitude.calculate_altitude_data(
            90.0, 10.0, BOULDER, duration_hours=1, interval_minutes=30
        )
        first = datetime.fromisoformat(points[0]["time"])
        # Sunset for the night of Mar 6 (local evening Mar 6 = Mar 7 UTC),
        # from get_sunset_sunrise (same kernel):
        result = altitude.get_sunset_sunrise(BOULDER, datetime(2015, 3, 7, tzinfo=UTC))
        expected_sunset = datetime.fromisoformat(result["sunset"])
        assert abs(first - expected_sunset) < timedelta(minutes=2)
        # and not the Mar 6 sunrise, which comes before that sunset:
        assert abs(first - datetime(2015, 3, 6, 13, 27, 3, tzinfo=UTC)) > timedelta(hours=1)

    def test_no_sun_event_falls_back_to_now(self, freeze_now):
        """At 89N in early March the sun never rises: start falls back to now."""
        freeze_now(datetime(2015, 3, 5, 12, 0, tzinfo=UTC))
        polar = ObserverLocation(latitude=89.0, longitude=0.0)
        points = altitude.calculate_altitude_data(
            90.0, 10.0, polar, duration_hours=1, interval_minutes=30
        )
        assert len(points) == 3
        assert points[0]["time"] == "2015-03-05T12:00:00+00:00"
        times = [datetime.fromisoformat(p["time"]) for p in points]
        assert times[1] - times[0] == timedelta(minutes=30)


class TestGetSunsetSunrise:
    def test_midlatitude_day(self):
        """2015-03-05 at 40N 105.26W.

        Reference values computed independently from the same JPL DE430 kernel
        with skyfield's almanac (sun crosses -0.8333 deg):
        sunset 00:55:59 UTC, sunrise 13:28:35 UTC; civil twilight begins
        13:01:31; civil twilight ends at 01:23:07 (the 4->3 crossing at sunset
        itself is the first event of the window and is dropped because there
        is no previous event to pair it with); nautical 12:30:13 / 01:54:29;
        astronomical 11:58:48 / 02:25:56.
        """
        result = altitude.get_sunset_sunrise(BOULDER, datetime(2015, 3, 5, tzinfo=UTC))

        sunset = datetime.fromisoformat(result["sunset"])
        sunrise = datetime.fromisoformat(result["sunrise"])
        assert sunset < sunrise
        _near(result["sunset"], "2015-03-05T00:55:59+00:00", 120)
        _near(result["sunrise"], "2015-03-05T13:28:35+00:00", 120)
        _near(result["civilTwilightStart"], "2015-03-05T13:01:31+00:00", 120)
        _near(result["civilTwilightEnd"], "2015-03-05T01:23:07+00:00", 120)
        _near(result["nauticalTwilightStart"], "2015-03-05T12:30:13+00:00", 120)
        _near(result["nauticalTwilightEnd"], "2015-03-05T01:54:29+00:00", 120)
        _near(result["astronomicalTwilightStart"], "2015-03-05T11:58:48+00:00", 120)
        _near(result["astronomicalTwilightEnd"], "2015-03-05T02:25:56+00:00", 120)
        # The night ordering (UTC): sunset < civil end < nautical end < astro
        # end < mid-morning, and civil start < nautical start < astro start.
        civil_start = datetime.fromisoformat(result["civilTwilightStart"])
        naut_start = datetime.fromisoformat(result["nauticalTwilightStart"])
        astro_start = datetime.fromisoformat(result["astronomicalTwilightStart"])
        astro_end = datetime.fromisoformat(result["astronomicalTwilightEnd"])
        naut_end = datetime.fromisoformat(result["nauticalTwilightEnd"])
        civil_end = datetime.fromisoformat(result["civilTwilightEnd"])
        assert civil_end < naut_end < astro_end
        assert astro_start < naut_start < civil_start

    def test_first_events_of_the_two_day_window_are_kept(self):
        """A second sunrise/sunset within the 2-day window must not replace the first."""
        result = altitude.get_sunset_sunrise(BOULDER, datetime(2015, 3, 5, tzinfo=UTC))
        assert result["sunset"].startswith("2015-03-05")
        assert result["sunrise"].startswith("2015-03-05")

    def test_all_eight_keys_present(self):
        result = altitude.get_sunset_sunrise(BOULDER, datetime(2015, 3, 5, tzinfo=UTC))
        assert set(result) == {
            "sunrise",
            "sunset",
            "civilTwilightStart",
            "civilTwilightEnd",
            "nauticalTwilightStart",
            "nauticalTwilightEnd",
            "astronomicalTwilightStart",
            "astronomicalTwilightEnd",
        }

    def test_time_of_day_of_date_is_ignored(self):
        """The window is anchored to midnight of the given date, whatever time of
        day the datetime carries."""
        midnight = altitude.get_sunset_sunrise(BOULDER, datetime(2015, 3, 5, tzinfo=UTC))
        midday = altitude.get_sunset_sunrise(BOULDER, datetime(2015, 3, 5, 12, 30, tzinfo=UTC))
        assert midday == midnight

    def test_naive_date_treated_as_utc(self):
        naive = altitude.get_sunset_sunrise(BOULDER, datetime(2015, 3, 5))
        aware = altitude.get_sunset_sunrise(BOULDER, datetime(2015, 3, 5, tzinfo=UTC))
        assert naive == aware

    def test_default_date_is_fixed_now(self, freeze_now):
        freeze_now(datetime(2015, 3, 5, 12, 0, tzinfo=UTC))
        result = altitude.get_sunset_sunrise(BOULDER)
        _near(result["sunrise"], "2015-03-05T13:28:35+00:00", 120)

    def test_polar_night_sun_never_rises(self):
        """At 89N on 2015-03-05 the sun stays below the horizon all day.

        Reference values from the same kernel: no sunrise/sunset events at
        all.  The first transition in the window (the morning civil crossing
        on Mar 5 at 06:46:56) is dropped because there is no previous event
        to pair it with; the recorded civil twilight is the evening crossing
        at 18:18:49 and the morning crossing on Mar 6 at 05:22:48.  The sun
        never reaches the nautical or astronomical thresholds.
        """
        polar = ObserverLocation(latitude=89.0, longitude=0.0)
        result = altitude.get_sunset_sunrise(polar, datetime(2015, 3, 5, tzinfo=UTC))
        assert result["sunrise"] is None
        assert result["sunset"] is None
        assert result["nauticalTwilightStart"] is None
        assert result["nauticalTwilightEnd"] is None
        assert result["astronomicalTwilightStart"] is None
        assert result["astronomicalTwilightEnd"] is None
        _near(result["civilTwilightStart"], "2015-03-06T05:22:48+00:00", 120)
        _near(result["civilTwilightEnd"], "2015-03-05T18:18:49+00:00", 120)
