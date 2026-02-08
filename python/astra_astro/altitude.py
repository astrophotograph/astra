"""Altitude calculations for astronomical objects.

This module provides functions to calculate the altitude and azimuth of
celestial objects at a given observer location using Skyfield.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

from skyfield import almanac
from skyfield.api import E, N, S, W, load, wgs84


@dataclass
class ObserverLocation:
    """Observer's location on Earth."""

    latitude: float  # degrees, positive = North
    longitude: float  # degrees, positive = East
    elevation: float = 0  # meters above sea level
    name: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "latitude": self.latitude,
            "longitude": self.longitude,
            "elevation": self.elevation,
            "name": self.name,
        }


@dataclass
class AltitudePoint:
    """Altitude/azimuth data at a specific time."""

    time: str  # ISO format datetime
    altitude: float  # degrees above horizon
    azimuth: float  # degrees from North
    compass_direction: str  # N, NE, E, SE, S, SW, W, NW

    def to_dict(self) -> dict:
        return {
            "time": self.time,
            "altitude": self.altitude,
            "azimuth": self.azimuth,
            "compassDirection": self.compass_direction,
        }


def _azimuth_to_compass(azimuth: float) -> str:
    """Convert azimuth in degrees to compass direction."""
    directions = [
        "N",
        "NNE",
        "NE",
        "ENE",
        "E",
        "ESE",
        "SE",
        "SSE",
        "S",
        "SSW",
        "SW",
        "WSW",
        "W",
        "WNW",
        "NW",
        "NNW",
    ]
    index = round(azimuth / 22.5) % 16
    return directions[index]


def calculate_altitude(
    ra_deg: float,
    dec_deg: float,
    location: ObserverLocation,
    time: Optional[datetime] = None,
) -> dict:
    """
    Calculate altitude and azimuth for a celestial object at a given time.

    Args:
        ra_deg: Right ascension in degrees
        dec_deg: Declination in degrees
        location: Observer's location
        time: Time for calculation (defaults to now)

    Returns:
        Dictionary with altitude, azimuth, and compass direction
    """
    ts = load.timescale()
    eph = load("de421.bsp")
    earth = eph["earth"]

    # Create observer location
    observer = earth + wgs84.latlon(
        location.latitude * N if location.latitude >= 0 else abs(location.latitude) * S,
        location.longitude * E if location.longitude >= 0 else abs(location.longitude) * W,
        elevation_m=location.elevation,
    )

    # Convert RA/Dec to position
    ra_hours = ra_deg / 15.0

    # Get time
    if time is None:
        time = datetime.now(timezone.utc)
    elif time.tzinfo is None:
        time = time.replace(tzinfo=timezone.utc)

    t = ts.from_datetime(time)

    # Create a star position from RA/Dec
    from skyfield.starlib import Star

    target = Star(ra_hours=ra_hours, dec_degrees=dec_deg)

    # Calculate apparent position
    astrometric = observer.at(t).observe(target)
    apparent = astrometric.apparent()
    alt, az, _ = apparent.altaz()

    altitude = alt.degrees
    azimuth = az.degrees
    compass = _azimuth_to_compass(azimuth)

    return AltitudePoint(
        time=time.isoformat(),
        altitude=altitude,
        azimuth=azimuth,
        compass_direction=compass,
    ).to_dict()


def calculate_altitude_data(
    ra_deg: float,
    dec_deg: float,
    location: ObserverLocation,
    start_time: Optional[datetime] = None,
    duration_hours: float = 12,
    interval_minutes: int = 15,
) -> list[dict]:
    """
    Calculate altitude data over a time range for plotting.

    Args:
        ra_deg: Right ascension in degrees
        dec_deg: Declination in degrees
        location: Observer's location
        start_time: Start time (defaults to current sunset)
        duration_hours: Duration to calculate in hours
        interval_minutes: Time interval between points

    Returns:
        List of AltitudePoint dictionaries
    """
    ts = load.timescale()
    eph = load("de421.bsp")
    earth = eph["earth"]
    eph["sun"]

    # Create observer location
    observer_location = wgs84.latlon(
        abs(location.latitude) * (1 if location.latitude >= 0 else -1),
        abs(location.longitude) * (1 if location.longitude >= 0 else -1),
        elevation_m=location.elevation,
    )
    observer = earth + observer_location

    # Convert RA/Dec to position
    ra_hours = ra_deg / 15.0
    from skyfield.starlib import Star

    target = Star(ra_hours=ra_hours, dec_degrees=dec_deg)

    # Determine start time (find sunset if not provided)
    if start_time is None:
        now = datetime.now(timezone.utc)
        t0 = ts.from_datetime(now)
        t1 = ts.from_datetime(now + timedelta(days=1))

        # Find sunset
        f = almanac.sunrise_sunset(eph, observer_location)
        times, events = almanac.find_discrete(t0, t1, f)

        # events: 0 = sunrise, 1 = sunset
        sunset_found = False
        for t, event in zip(times, events):
            if event == 0:  # sunrise
                continue
            # This is sunset
            start_time = t.utc_datetime()
            sunset_found = True
            break

        if not sunset_found:
            # Default to current time if no sunset found
            start_time = now
    elif start_time.tzinfo is None:
        start_time = start_time.replace(tzinfo=timezone.utc)

    # Generate time points
    points = []
    num_points = int((duration_hours * 60) / interval_minutes) + 1

    for i in range(num_points):
        point_time = start_time + timedelta(minutes=i * interval_minutes)
        t = ts.from_datetime(point_time)

        # Calculate position
        astrometric = observer.at(t).observe(target)
        apparent = astrometric.apparent()
        alt, az, _ = apparent.altaz()

        points.append(
            AltitudePoint(
                time=point_time.isoformat(),
                altitude=alt.degrees,
                azimuth=az.degrees,
                compass_direction=_azimuth_to_compass(az.degrees),
            ).to_dict()
        )

    return points


def get_sunset_sunrise(
    location: ObserverLocation,
    date: Optional[datetime] = None,
) -> dict:
    """
    Get sunset and sunrise times for a location.

    Args:
        location: Observer's location
        date: Date to calculate for (defaults to today)

    Returns:
        Dictionary with sunset, sunrise, and twilight times
    """
    ts = load.timescale()
    eph = load("de421.bsp")

    observer_location = wgs84.latlon(
        location.latitude,
        location.longitude,
        elevation_m=location.elevation,
    )

    if date is None:
        date = datetime.now(timezone.utc)
    elif date.tzinfo is None:
        date = date.replace(tzinfo=timezone.utc)

    # Calculate for the day
    t0 = ts.from_datetime(date.replace(hour=0, minute=0, second=0, microsecond=0))
    end_date = date.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=2)
    t1 = ts.from_datetime(end_date)

    # Sunrise/sunset
    f = almanac.sunrise_sunset(eph, observer_location)
    times, events = almanac.find_discrete(t0, t1, f)

    result = {
        "sunrise": None,
        "sunset": None,
        "civilTwilightStart": None,
        "civilTwilightEnd": None,
        "nauticalTwilightStart": None,
        "nauticalTwilightEnd": None,
        "astronomicalTwilightStart": None,
        "astronomicalTwilightEnd": None,
    }

    for t, event in zip(times, events):
        dt = t.utc_datetime()
        if event == 1:  # sunrise
            if result["sunrise"] is None:
                result["sunrise"] = dt.isoformat()
        else:  # sunset
            if result["sunset"] is None:
                result["sunset"] = dt.isoformat()

    # Twilight calculations
    # Civil twilight (sun at -6 degrees)
    f_civil = almanac.dark_twilight_day(eph, observer_location)
    times, events = almanac.find_discrete(t0, t1, f_civil)

    twilight_names = {
        0: "night",
        1: "astronomicalTwilight",
        2: "nauticalTwilight",
        3: "civilTwilight",
        4: "day",
    }

    prev_event = None
    for t, event in zip(times, events):
        dt = t.utc_datetime()
        event_name = twilight_names.get(event, "unknown")

        if prev_event is not None:
            prev_name = twilight_names.get(prev_event, "unknown")

            # Transitions going from night to day (morning)
            if prev_event < event:
                if prev_name == "night" and event_name == "astronomicalTwilight":
                    if result["astronomicalTwilightStart"] is None:
                        result["astronomicalTwilightStart"] = dt.isoformat()
                elif prev_name == "astronomicalTwilight" and event_name == "nauticalTwilight":
                    if result["nauticalTwilightStart"] is None:
                        result["nauticalTwilightStart"] = dt.isoformat()
                elif prev_name == "nauticalTwilight" and event_name == "civilTwilight":
                    if result["civilTwilightStart"] is None:
                        result["civilTwilightStart"] = dt.isoformat()

            # Transitions going from day to night (evening)
            elif prev_event > event:
                if prev_name == "civilTwilight" and event_name == "nauticalTwilight":
                    if result["civilTwilightEnd"] is None:
                        result["civilTwilightEnd"] = dt.isoformat()
                elif prev_name == "nauticalTwilight" and event_name == "astronomicalTwilight":
                    if result["nauticalTwilightEnd"] is None:
                        result["nauticalTwilightEnd"] = dt.isoformat()
                elif prev_name == "astronomicalTwilight" and event_name == "night":
                    if result["astronomicalTwilightEnd"] is None:
                        result["astronomicalTwilightEnd"] = dt.isoformat()

        prev_event = event

    return result
