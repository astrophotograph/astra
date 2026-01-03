/**
 * Sky Map Side Panel - Collapsible panel with weather, moon conditions, and altitude chart
 */

import { useEffect, useMemo, useState } from "react";
import { format, addHours, startOfDay } from "date-fns";
import SunCalc from "suncalc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ChevronLeft,
  ChevronRight,
  Cloud,
  Droplets,
  Eye,
  MapPin,
  Moon,
  RefreshCw,
  Target,
  Thermometer,
  Wind,
} from "lucide-react";
import { MoonImage } from "@/components/MoonImage";
import { AltitudeChart, type AltitudeDataPoint, type HorizonDataPoint } from "@/components/AltitudeChart";
import { cn } from "@/lib/utils";
import { getHorizonAltitude, type HorizonProfile } from "@/lib/astronomy-utils";
import { useLocations } from "@/contexts/LocationContext";
import type { TargetInfo } from "@/components/AladinLite";

interface Coordinates {
  latitude: number;
  longitude: number;
}

interface WeatherData {
  condition: string;
  description: string;
  temperature: number;
  humidity: number;
  windSpeed: number;
  visibility: number;
  cloudCover: number;
}

interface SkyMapSidePanelProps {
  className?: string;
  defaultCollapsed?: boolean;
  target?: TargetInfo | null;
  fovState?: { enabled: boolean; ra?: number; dec?: number };
}

/**
 * Calculate altitude of a celestial object given its RA/Dec and observer position
 * Uses standard equatorial to horizontal coordinate transformation
 */
function calculateAltitude(
  ra: number,       // Right Ascension in degrees
  dec: number,      // Declination in degrees
  lat: number,      // Observer latitude in degrees
  lon: number,      // Observer longitude in degrees
  time: Date        // Time of observation
): { altitude: number; azimuth: number } {
  // Convert to radians
  const toRad = (deg: number) => deg * Math.PI / 180;
  const toDeg = (rad: number) => rad * 180 / Math.PI;

  const decRad = toRad(dec);
  const latRad = toRad(lat);

  // Calculate Julian Date
  const jd = time.getTime() / 86400000 + 2440587.5;

  // Calculate Greenwich Mean Sidereal Time (GMST)
  const T = (jd - 2451545.0) / 36525.0;
  const gmstHours = 18.697374558 + 24.06570982441908 * (jd - 2451545.0) +
                    0.000026 * T * T - 0.0000000000002 * T * T * T;
  const gmst = ((gmstHours % 24) + 24) % 24; // Normalize to 0-24

  // Calculate Local Sidereal Time
  const lstHours = gmst + lon / 15;
  const lst = ((lstHours % 24) + 24) % 24;

  // Calculate Hour Angle
  const ha = toRad((lst * 15 - ra + 360) % 360);

  // Calculate Altitude
  const sinAlt = Math.sin(decRad) * Math.sin(latRad) +
                 Math.cos(decRad) * Math.cos(latRad) * Math.cos(ha);
  const altitude = toDeg(Math.asin(sinAlt));

  // Calculate Azimuth
  const cosAz = (Math.sin(decRad) - Math.sin(latRad) * sinAlt) /
                (Math.cos(latRad) * Math.cos(Math.asin(sinAlt)));
  const sinAz = -Math.cos(decRad) * Math.sin(ha) / Math.cos(Math.asin(sinAlt));
  let azimuth = toDeg(Math.atan2(sinAz, cosAz));
  azimuth = ((azimuth % 360) + 360) % 360;

  return { altitude, azimuth };
}

/**
 * Generate altitude data for a 24-hour period centered on midnight tonight
 */
function generateAltitudeData(
  ra: number,
  dec: number,
  lat: number,
  lon: number
): AltitudeDataPoint[] {
  const data: AltitudeDataPoint[] = [];
  const now = new Date();

  // Start from 6 PM today (or earlier if before 6 PM)
  let startTime: Date;
  if (now.getHours() < 18) {
    startTime = startOfDay(now);
    startTime.setHours(18, 0, 0, 0);
  } else {
    startTime = new Date(now);
    startTime.setHours(18, 0, 0, 0);
  }

  // Generate data points for 14 hours (6 PM to 8 AM)
  for (let i = 0; i <= 14 * 4; i++) {  // Every 15 minutes
    const time = addHours(startTime, i / 4);
    const { altitude, azimuth } = calculateAltitude(ra, dec, lat, lon, time);
    data.push({
      time,
      altitude: Math.max(0, altitude),  // Clamp to 0 for below horizon
      azimuth,
      isIdeal: altitude >= 30,
    });
  }

  return data;
}

export function SkyMapSidePanel({
  className,
  defaultCollapsed = false,
  target,
  fovState,
}: SkyMapSidePanelProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [weatherLoading, setWeatherLoading] = useState(false);
  const [weatherError, setWeatherError] = useState<string | null>(null);

  // Get location from context - this makes the panel reactive to location changes
  const { activeLocation } = useLocations();

  // Derive coordinates and horizon from active location
  const coordinates: Coordinates | null = activeLocation
    ? { latitude: activeLocation.latitude, longitude: activeLocation.longitude }
    : null;
  const horizonProfile: HorizonProfile | null = activeLocation?.horizon || null;

  // Fetch weather data
  const fetchWeather = async () => {
    if (!coordinates) return;

    setWeatherLoading(true);
    setWeatherError(null);

    try {
      // Use Open-Meteo API (no API key required)
      const response = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${coordinates.latitude}&longitude=${coordinates.longitude}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,cloud_cover,visibility`
      );

      if (!response.ok) {
        throw new Error("Failed to fetch weather");
      }

      const data = await response.json();
      const current = data.current;

      // Map weather code to description
      const getWeatherDescription = (code: number): { condition: string; description: string } => {
        if (code === 0) return { condition: "clear", description: "Clear sky" };
        if (code <= 3) return { condition: "partly cloudy", description: "Partly cloudy" };
        if (code <= 49) return { condition: "fog", description: "Fog or mist" };
        if (code <= 69) return { condition: "rain", description: "Rain" };
        if (code <= 79) return { condition: "snow", description: "Snow" };
        if (code <= 99) return { condition: "thunderstorm", description: "Thunderstorm" };
        return { condition: "unknown", description: "Unknown" };
      };

      const weatherInfo = getWeatherDescription(current.weather_code);

      setWeather({
        condition: weatherInfo.condition,
        description: weatherInfo.description,
        temperature: current.temperature_2m,
        humidity: current.relative_humidity_2m,
        windSpeed: current.wind_speed_10m / 3.6, // Convert km/h to m/s
        visibility: (current.visibility || 10000) / 1000, // Convert to km
        cloudCover: current.cloud_cover,
      });
    } catch (error) {
      console.error("Weather fetch error:", error);
      setWeatherError("Unable to fetch weather data");
    } finally {
      setWeatherLoading(false);
    }
  };

  useEffect(() => {
    if (coordinates) {
      fetchWeather();
    }
  }, [coordinates]);

  // Calculate moon data
  const moonData = useMemo(() => {
    if (!coordinates) return null;

    const now = new Date();
    const moonIllumination = SunCalc.getMoonIllumination(now);
    const moonTimes = SunCalc.getMoonTimes(now, coordinates.latitude, coordinates.longitude);
    const moonPosition = SunCalc.getMoonPosition(now, coordinates.latitude, coordinates.longitude);

    const getPhaseName = (phase: number): string => {
      if (phase < 0.03) return "New Moon";
      if (phase < 0.22) return "Waxing Crescent";
      if (phase < 0.28) return "First Quarter";
      if (phase < 0.47) return "Waxing Gibbous";
      if (phase < 0.53) return "Full Moon";
      if (phase < 0.72) return "Waning Gibbous";
      if (phase < 0.78) return "Last Quarter";
      if (phase < 0.97) return "Waning Crescent";
      return "New Moon";
    };

    const getLightPollutionLevel = (illumination: number): { label: string; variant: "default" | "secondary" | "destructive" } => {
      if (illumination < 25) return { label: "Minimal", variant: "default" };
      if (illumination < 75) return { label: "Moderate", variant: "secondary" };
      return { label: "High", variant: "destructive" };
    };

    const illuminationPercent = moonIllumination.fraction * 100;

    return {
      phase: getPhaseName(moonIllumination.phase),
      illumination: illuminationPercent,
      fraction: moonIllumination.fraction,
      age: moonIllumination.phase * 29.53,
      rise: moonTimes.rise ? format(moonTimes.rise, "HH:mm") : "N/A",
      set: moonTimes.set ? format(moonTimes.set, "HH:mm") : "N/A",
      altitude: (moonPosition.altitude * 180) / Math.PI,
      isVisible: moonPosition.altitude > 0,
      isWaxing: moonIllumination.phase <= 0.5,
      pollutionLevel: getLightPollutionLevel(illuminationPercent),
    };
  }, [coordinates]);

  // Calculate seeing condition
  const getSeeingCondition = (visibility: number, cloudCover: number, windSpeed: number) => {
    const visibilityScore = Math.min(visibility / 10, 1);
    const cloudScore = (100 - cloudCover) / 100;
    const windScore = Math.max(0, (15 - windSpeed) / 15);
    const overallScore = (visibilityScore + cloudScore + windScore) / 3;

    if (overallScore > 0.8) return { condition: "Excellent", value: 1.2, color: "text-green-400" };
    if (overallScore > 0.6) return { condition: "Good", value: 1.8, color: "text-green-300" };
    if (overallScore > 0.4) return { condition: "Fair", value: 2.5, color: "text-yellow-400" };
    return { condition: "Poor", value: 3.5, color: "text-red-400" };
  };

  const seeing = weather ? getSeeingCondition(weather.visibility, weather.cloudCover, weather.windSpeed) : null;

  // Calculate altitude data for target or FOV position
  const altitudeData = useMemo(() => {
    if (!coordinates) return null;

    // Use target if available, otherwise use FOV position
    let ra: number | undefined;
    let dec: number | undefined;
    let targetName: string | undefined;

    if (target) {
      ra = target.ra;
      dec = target.dec;
      targetName = target.name;
    } else if (fovState?.enabled && fovState.ra !== undefined && fovState.dec !== undefined) {
      ra = fovState.ra;
      dec = fovState.dec;
      targetName = "FOV Center";
    }

    if (ra === undefined || dec === undefined) return null;

    const data = generateAltitudeData(ra, dec, coordinates.latitude, coordinates.longitude);

    // Generate horizon data using the custom horizon profile
    // If no profile is set, use a flat horizon at 0°
    const horizonData: HorizonDataPoint[] = data.map(point => {
      const azimuth = point.azimuth ?? 0;
      const horizonAlt = horizonProfile
        ? getHorizonAltitude(horizonProfile, azimuth)
        : 0;
      return {
        time: point.time,
        altitude: horizonAlt,
      };
    });

    // Find current and max altitude
    const now = new Date();
    const currentPoint = data.reduce((closest, point) => {
      const currentDiff = Math.abs(point.time.getTime() - now.getTime());
      const closestDiff = Math.abs(closest.time.getTime() - now.getTime());
      return currentDiff < closestDiff ? point : closest;
    }, data[0]);

    const maxPoint = data.reduce((max, point) =>
      point.altitude > max.altitude ? point : max
    , data[0]);

    // Check if horizon profile is loaded
    const hasCustomHorizon = horizonProfile && horizonProfile.points.length > 0;

    return {
      data,
      horizonData,
      targetName,
      currentAltitude: currentPoint.altitude,
      currentAzimuth: currentPoint.azimuth || 0,
      maxAltitude: maxPoint.altitude,
      maxAltitudeTime: maxPoint.time,
      hasCustomHorizon,
    };
  }, [coordinates, target, fovState, horizonProfile]);

  if (collapsed) {
    return (
      <div className={cn("flex flex-col", className)}>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setCollapsed(false)}
          className="h-10 w-10 p-0 rounded-r-lg border border-l-0"
        >
          <ChevronLeft className="w-4 h-4" />
        </Button>
      </div>
    );
  }

  return (
    <div className={cn("w-96 flex flex-col border-l bg-card", className)}>
      {/* Collapse button */}
      <div className="flex justify-end p-2 border-b">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setCollapsed(true)}
          className="h-8 w-8 p-0"
        >
          <ChevronRight className="w-4 h-4" />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Target Altitude Section - at top when there's a target or FOV */}
        {altitudeData && (
          <div className="p-4 border-b">
            <h3 className="font-medium flex items-center gap-2 mb-3">
              <Target className="w-4 h-4" />
              Target Altitude
            </h3>

            <div className="space-y-3">
              {/* Target name */}
              <div className="text-center">
                <div className="text-lg font-medium">{altitudeData.targetName}</div>
                <div className="text-xs text-muted-foreground">
                  Tonight's visibility (18:00 - 08:00)
                </div>
              </div>

              {/* Altitude chart - larger size */}
              <div className="bg-muted/20 rounded-lg p-2">
                <AltitudeChart
                  data={altitudeData.data}
                  horizonData={altitudeData.horizonData}
                  width={340}
                  height={180}
                  showCurrentTime={true}
                  idealThreshold={30}
                />
              </div>

              {/* Current stats */}
              <div className="grid grid-cols-3 gap-2 text-sm">
                <div className="text-center p-2 bg-muted/30 rounded-md">
                  <div className="text-muted-foreground text-xs">Current Alt</div>
                  <div className="font-medium">{altitudeData.currentAltitude.toFixed(1)}°</div>
                </div>
                <div className="text-center p-2 bg-muted/30 rounded-md">
                  <div className="text-muted-foreground text-xs">Current Az</div>
                  <div className="font-medium">{altitudeData.currentAzimuth.toFixed(1)}°</div>
                </div>
                <div className="text-center p-2 bg-green-950/30 rounded-md border border-green-500/20">
                  <div className="text-muted-foreground text-xs">Max Alt</div>
                  <div className="font-medium text-green-400">
                    {altitudeData.maxAltitude.toFixed(1)}° @ {format(altitudeData.maxAltitudeTime, "HH:mm")}
                  </div>
                </div>
              </div>

              {/* Legend */}
              <div className="text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
                <span className="flex items-center gap-1">
                  <span className="w-3 h-0.5 bg-green-500 inline-block"></span>
                  Ideal (&gt;30°)
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-3 h-0.5 bg-red-500 inline-block"></span>
                  Now
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-3 h-0.5 bg-red-500/60 inline-block" style={{borderStyle: 'dashed'}}></span>
                  {altitudeData.hasCustomHorizon ? "Custom Horizon" : "Horizon"}
                </span>
              </div>
            </div>
          </div>
        )}
        {/* Weather Section */}
        <div className="p-4 border-b">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-medium flex items-center gap-2">
              <Cloud className="w-4 h-4" />
              Weather Conditions
            </h3>
            <Button
              variant="ghost"
              size="sm"
              onClick={fetchWeather}
              disabled={weatherLoading}
              className="h-6 w-6 p-0"
            >
              <RefreshCw className={cn("w-3 h-3", weatherLoading && "animate-spin")} />
            </Button>
          </div>

          {coordinates && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground mb-3">
              <MapPin className="w-3 h-3" />
              <span>{coordinates.latitude.toFixed(2)}, {coordinates.longitude.toFixed(2)}</span>
            </div>
          )}

          {!coordinates && (
            <div className="text-center py-4">
              <p className="text-sm text-muted-foreground">
                No location configured. Add one in Settings.
              </p>
            </div>
          )}

          {weatherError && (
            <div className="text-center py-4">
              <p className="text-sm text-muted-foreground">{weatherError}</p>
              <Button variant="outline" size="sm" className="mt-2" onClick={fetchWeather}>
                <RefreshCw className="w-4 h-4 mr-2" />
                Retry
              </Button>
            </div>
          )}

          {weatherLoading && !weather && (
            <div className="flex items-center justify-center py-4">
              <RefreshCw className="w-4 h-4 animate-spin mr-2" />
              <span className="text-sm text-muted-foreground">Loading weather...</span>
            </div>
          )}

          {weather && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="flex items-center gap-2">
                  <Cloud className="w-4 h-4 text-blue-400" />
                  <div>
                    <div className="text-muted-foreground text-xs">Sky</div>
                    <div className="font-medium capitalize">{weather.description}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Droplets className="w-4 h-4 text-blue-400" />
                  <div>
                    <div className="text-muted-foreground text-xs">Humidity</div>
                    <div className="font-medium">{weather.humidity}%</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Wind className="w-4 h-4 text-gray-400" />
                  <div>
                    <div className="text-muted-foreground text-xs">Wind</div>
                    <div className="font-medium">{weather.windSpeed.toFixed(1)} m/s</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Eye className={cn("w-4 h-4", seeing?.color)} />
                  <div>
                    <div className="text-muted-foreground text-xs">Seeing</div>
                    <div className="font-medium">
                      {seeing?.condition}
                      <span className="text-xs text-muted-foreground ml-1">({seeing?.value}")</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="flex items-center gap-2">
                  <Thermometer className="w-4 h-4 text-orange-400" />
                  <div>
                    <div className="text-muted-foreground text-xs">Temperature</div>
                    <div className="font-medium">{Math.round(weather.temperature)}°C</div>
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground text-xs">Visibility</div>
                  <div className="font-medium">{weather.visibility.toFixed(1)} km</div>
                </div>
              </div>

              <div className="pt-2 border-t">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Observing Conditions</span>
                  <Badge
                    variant={
                      seeing?.condition === "Excellent" || seeing?.condition === "Good"
                        ? "default"
                        : seeing?.condition === "Fair"
                          ? "secondary"
                          : "destructive"
                    }
                  >
                    {seeing?.condition === "Excellent" || seeing?.condition === "Good"
                      ? "Optimal"
                      : seeing?.condition === "Fair"
                        ? "Moderate"
                        : "Poor"}
                  </Badge>
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  Cloud cover: {weather.cloudCover}%
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Moon Phase Section */}
        <div className="p-4">
          <h3 className="font-medium flex items-center gap-2 mb-4">
            <Moon className="w-4 h-4" />
            Moon Phase
          </h3>

          {moonData && (
            <div className="space-y-4">
              {/* Moon visualization */}
              <div className="flex justify-center p-3 bg-muted/30 rounded-lg">
                <MoonImage
                  illumination={moonData.fraction}
                  waxing={moonData.isWaxing}
                  diameter={80}
                />
              </div>

              {/* Phase info */}
              <div className="text-center space-y-1">
                <div className="text-sm text-muted-foreground">Phase: {Math.round(moonData.illumination)}%</div>
                <div className="font-medium">{moonData.phase}</div>
                <div className="text-xs text-muted-foreground">
                  Phase on {format(new Date(), "eee MMM dd yyyy")}
                </div>
              </div>

              {/* Stats grid */}
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="text-center">
                  <div className="text-muted-foreground text-xs">Illumination</div>
                  <div className="font-medium">{moonData.illumination.toFixed(0)}%</div>
                </div>
                <div className="text-center">
                  <div className="text-muted-foreground text-xs">Age</div>
                  <div className="font-medium">{moonData.age.toFixed(1)} days</div>
                </div>
                <div className="text-center">
                  <div className="text-muted-foreground text-xs">Moonrise</div>
                  <div className="font-medium">{moonData.rise}</div>
                </div>
                <div className="text-center">
                  <div className="text-muted-foreground text-xs">Moonset</div>
                  <div className="font-medium">{moonData.set}</div>
                </div>
              </div>

              {/* Visibility and light pollution */}
              <div className="space-y-2 pt-2 border-t">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Currently Visible</span>
                  <Badge variant={moonData.isVisible ? "default" : "secondary"}>
                    {moonData.isVisible ? "Yes" : "No"}
                  </Badge>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Light Pollution</span>
                  <Badge variant={moonData.pollutionLevel.variant}>
                    {moonData.pollutionLevel.label}
                  </Badge>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
