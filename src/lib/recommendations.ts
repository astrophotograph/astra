/**
 * Target Recommendation System
 *
 * Provides pluggable recommendation methods for suggesting observation targets
 * based on location, horizon, moon phase, weather, and equipment.
 */

import type { ObserverLocation, HorizonProfile, EquipmentSet } from "./astronomy-utils";
import { getHorizonAltitude } from "./astronomy-utils";

// ============================================================================
// Types
// ============================================================================

export interface RecommendedTarget {
  id: string;
  name: string;
  commonName?: string;
  type: string;
  ra: number;           // Right Ascension in hours
  dec: number;          // Declination in degrees
  magnitude?: number;
  size?: number;        // arcminutes
  constellation?: string;
  description?: string;

  // Computed visibility data
  altitude: number;     // Current altitude in degrees
  azimuth: number;      // Current azimuth in degrees
  direction: string;    // Cardinal direction (N, NE, E, etc.)
  isAboveHorizon: boolean;
  maxAltitude?: number;
  maxAltitudeTime?: Date;

  // Visibility window (times above minimum altitude tonight)
  visibilityStart?: Date;   // When it rises above min altitude
  visibilityEnd?: Date;     // When it sets below min altitude
  visibilityHours?: number; // Total hours visible tonight
  optimalTime?: Date;       // Best time to observe (highest altitude)

  // Recommendation metadata
  score: number;        // 0-100, higher is better
  reasons: string[];    // Why this target is recommended
}

export interface RecommendationContext {
  location: ObserverLocation;
  time: Date;
  moonIllumination: number;  // 0-100
  moonPhase: string;
  moonAltitude: number;
  cloudCover?: number;       // 0-100
  seeing?: number;           // arcseconds
  equipment?: EquipmentSet[];
}

export interface RecommenderOptions {
  minAltitude?: number;      // Minimum altitude above horizon (default: 20)
  maxTargets?: number;       // Maximum targets to return (default: 20)
  typeFilter?: string[];     // Filter by object types
  minMagnitude?: number;     // Minimum (faintest) magnitude
  maxMagnitude?: number;     // Maximum (brightest) magnitude
}

/**
 * Recommender interface - implement this for custom recommendation methods
 */
export interface Recommender {
  name: string;
  description: string;
  recommend(
    targets: CatalogTarget[],
    context: RecommendationContext,
    options?: RecommenderOptions
  ): Promise<RecommendedTarget[]>;
}

export interface CatalogTarget {
  id: string;
  name: string;
  ra: number;      // hours
  dec: number;     // degrees
  type: string;
  constellation?: string;
  magnitude?: number;
  distance?: number;
  commonName?: string;
  info?: string;
  size?: number;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Convert RA from hours to degrees
 */
export function raHoursToDegrees(raHours: number): number {
  return raHours * 15;
}

/**
 * Calculate altitude and azimuth of a celestial object
 */
export function calculateAltAz(
  raHours: number,
  dec: number,
  lat: number,
  lon: number,
  time: Date
): { altitude: number; azimuth: number } {
  const toRad = (deg: number) => deg * Math.PI / 180;
  const toDeg = (rad: number) => rad * 180 / Math.PI;

  const raDeg = raHoursToDegrees(raHours);
  const decRad = toRad(dec);
  const latRad = toRad(lat);

  // Calculate Julian Date
  const jd = time.getTime() / 86400000 + 2440587.5;

  // Calculate Greenwich Mean Sidereal Time (GMST)
  const T = (jd - 2451545.0) / 36525.0;
  const gmstHours = 18.697374558 + 24.06570982441908 * (jd - 2451545.0) +
                    0.000026 * T * T;
  const gmst = ((gmstHours % 24) + 24) % 24;

  // Calculate Local Sidereal Time
  const lstHours = gmst + lon / 15;
  const lst = ((lstHours % 24) + 24) % 24;

  // Calculate Hour Angle
  const ha = toRad((lst * 15 - raDeg + 360) % 360);

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
 * Get cardinal direction from azimuth
 */
export function getDirection(azimuth: number): string {
  const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                      'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const index = Math.round(azimuth / 22.5) % 16;
  return directions[index];
}

/**
 * Check if target is above custom horizon
 */
export function isAboveHorizon(
  altitude: number,
  azimuth: number,
  horizon?: HorizonProfile
): boolean {
  if (!horizon) return altitude > 0;
  const horizonAlt = getHorizonAltitude(horizon, azimuth);
  return altitude > horizonAlt;
}

/**
 * Find maximum altitude and time for a target tonight
 */
export function findMaxAltitude(
  raHours: number,
  dec: number,
  lat: number,
  lon: number,
  startTime: Date
): { maxAltitude: number; maxAltitudeTime: Date } {
  let maxAlt = -90;
  let maxTime = startTime;

  // Check every 15 minutes for 12 hours
  for (let i = 0; i < 48; i++) {
    const time = new Date(startTime.getTime() + i * 15 * 60 * 1000);
    const { altitude } = calculateAltAz(raHours, dec, lat, lon, time);
    if (altitude > maxAlt) {
      maxAlt = altitude;
      maxTime = time;
    }
  }

  return { maxAltitude: maxAlt, maxAltitudeTime: maxTime };
}

/**
 * Calculate visibility window - when target is above minimum altitude tonight
 */
export function calculateVisibilityWindow(
  raHours: number,
  dec: number,
  lat: number,
  lon: number,
  minAltitude: number,
  horizon?: HorizonProfile
): {
  visibilityStart: Date | undefined;
  visibilityEnd: Date | undefined;
  visibilityHours: number;
  optimalTime: Date;
  maxAltitude: number;
} {
  const now = new Date();

  // Start from 6 PM today (or now if after 6 PM)
  let startTime = new Date(now);
  if (now.getHours() < 18) {
    startTime.setHours(18, 0, 0, 0);
  }

  // End at 6 AM next day
  const endTime = new Date(startTime);
  endTime.setDate(endTime.getDate() + 1);
  endTime.setHours(6, 0, 0, 0);

  let visibilityStart: Date | undefined;
  let visibilityEnd: Date | undefined;
  let maxAlt = -90;
  let optimalTime = startTime;
  let wasAbove = false;
  let totalMinutesVisible = 0;

  // Check every 10 minutes through the night
  const intervalMs = 10 * 60 * 1000;
  let currentTime = new Date(startTime);

  while (currentTime <= endTime) {
    const { altitude, azimuth } = calculateAltAz(raHours, dec, lat, lon, currentTime);

    // Check against custom horizon or use minimum altitude
    const effectiveMinAlt = horizon
      ? Math.max(minAltitude, getHorizonAltitude(horizon, azimuth))
      : minAltitude;

    const isAbove = altitude >= effectiveMinAlt;

    if (isAbove) {
      totalMinutesVisible += 10;

      if (!wasAbove && !visibilityStart) {
        visibilityStart = new Date(currentTime);
      }

      if (altitude > maxAlt) {
        maxAlt = altitude;
        optimalTime = new Date(currentTime);
      }
    } else {
      if (wasAbove && visibilityStart && !visibilityEnd) {
        visibilityEnd = new Date(currentTime);
      }
    }

    wasAbove = isAbove;
    currentTime = new Date(currentTime.getTime() + intervalMs);
  }

  // If still visible at end of window, set end time
  if (wasAbove && visibilityStart && !visibilityEnd) {
    visibilityEnd = endTime;
  }

  return {
    visibilityStart,
    visibilityEnd,
    visibilityHours: totalMinutesVisible / 60,
    optimalTime,
    maxAltitude: maxAlt,
  };
}

// ============================================================================
// Visibility-Based Recommender
// ============================================================================

/**
 * Basic recommender based on visibility, altitude, and conditions
 */
export class VisibilityRecommender implements Recommender {
  name = "Visibility-Based";
  description = "Recommends targets based on current visibility, altitude, moon interference, and object brightness";

  async recommend(
    targets: CatalogTarget[],
    context: RecommendationContext,
    options: RecommenderOptions = {}
  ): Promise<RecommendedTarget[]> {
    const {
      minAltitude = 20,
      maxTargets = 20,
      typeFilter,
      minMagnitude,
      maxMagnitude,
    } = options;

    const { location, time, moonIllumination, moonAltitude } = context;
    const results: RecommendedTarget[] = [];

    for (const target of targets) {
      // Apply type filter
      if (typeFilter && typeFilter.length > 0 && !typeFilter.includes(target.type)) {
        continue;
      }

      // Apply magnitude filters
      if (minMagnitude !== undefined && target.magnitude !== undefined && target.magnitude > minMagnitude) {
        continue;
      }
      if (maxMagnitude !== undefined && target.magnitude !== undefined && target.magnitude < maxMagnitude) {
        continue;
      }

      // Calculate current position
      const { altitude, azimuth } = calculateAltAz(
        target.ra,
        target.dec,
        location.latitude,
        location.longitude,
        time
      );

      // Quick check if currently above horizon
      const aboveHorizon = isAboveHorizon(altitude, azimuth, location.horizon);
      if (!aboveHorizon || altitude < minAltitude) {
        continue;
      }

      // Calculate visibility window for tonight
      const visibility = calculateVisibilityWindow(
        target.ra,
        target.dec,
        location.latitude,
        location.longitude,
        minAltitude,
        location.horizon
      );

      // Skip if not visible tonight at all
      if (visibility.visibilityHours < 0.5) {
        continue;
      }

      // Score the target
      const { score, reasons } = this.scoreTarget(
        target,
        altitude,
        visibility.maxAltitude,
        moonIllumination,
        moonAltitude,
        context.cloudCover,
        context.seeing
      );

      results.push({
        id: target.id,
        name: target.name,
        commonName: target.commonName,
        type: target.type,
        ra: target.ra,
        dec: target.dec,
        magnitude: target.magnitude,
        size: target.size,
        constellation: target.constellation,
        description: target.info,
        altitude: Math.round(altitude),
        azimuth: Math.round(azimuth),
        direction: getDirection(azimuth),
        isAboveHorizon: true,
        maxAltitude: Math.round(visibility.maxAltitude),
        maxAltitudeTime: visibility.optimalTime,
        visibilityStart: visibility.visibilityStart,
        visibilityEnd: visibility.visibilityEnd,
        visibilityHours: Math.round(visibility.visibilityHours * 10) / 10,
        optimalTime: visibility.optimalTime,
        score,
        reasons,
      });
    }

    // Sort by score (highest first) and return top N
    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, maxTargets);
  }

  private scoreTarget(
    target: CatalogTarget,
    altitude: number,
    maxAltitudeTonight: number,
    moonIllumination: number,
    moonAltitude: number,
    cloudCover?: number,
    seeing?: number
  ): { score: number; reasons: string[] } {
    let score = 50; // Base score
    const reasons: string[] = [];

    // Altitude scoring (0-25 points)
    if (altitude >= 60) {
      score += 25;
      reasons.push("Excellent altitude (>60°)");
    } else if (altitude >= 40) {
      score += 15;
      reasons.push("Good altitude (40-60°)");
    } else if (altitude >= 30) {
      score += 8;
    }

    // Bonus if near max altitude (0-5 points)
    if (maxAltitudeTonight > 0 && altitude >= maxAltitudeTonight * 0.9) {
      score += 5;
      reasons.push("Near peak altitude");
    }

    // Moon interference scoring (-20 to +15 points)
    const isFaint = target.magnitude !== undefined && target.magnitude > 8;
    const moonIsUp = moonAltitude > 0;
    const moonIsBright = moonIllumination > 50;

    if (!moonIsUp || moonIllumination < 25) {
      score += 15;
      reasons.push("Dark sky (low moon)");
    } else if (moonIsBright && isFaint) {
      score -= 20;
      reasons.push("Moon interference (faint target)");
    } else if (moonIsBright) {
      score -= 5;
    }

    // Brightness scoring (0-15 points)
    if (target.magnitude !== undefined) {
      if (target.magnitude < 4) {
        score += 15;
        reasons.push("Very bright target");
      } else if (target.magnitude < 6) {
        score += 10;
        reasons.push("Easy to see");
      } else if (target.magnitude < 8) {
        score += 5;
      }
    }

    // Object type scoring (0-10 points)
    const popularTypes = ["Globular Cluster", "Open Cluster", "Galaxy", "Nebula", "Planetary Nebula"];
    if (popularTypes.some(t => target.type.toLowerCase().includes(t.toLowerCase()))) {
      score += 10;
    }

    // Weather adjustment (-15 to 0 points)
    if (cloudCover !== undefined && cloudCover > 50) {
      score -= Math.round((cloudCover - 50) * 0.3);
    }

    // Seeing adjustment (-10 to 0 points for detailed objects)
    if (seeing !== undefined && seeing > 3) {
      const detailedTypes = ["Planetary Nebula", "Galaxy", "Double Star"];
      if (detailedTypes.some(t => target.type.toLowerCase().includes(t.toLowerCase()))) {
        score -= 10;
      }
    }

    // Normalize score to 0-100
    score = Math.max(0, Math.min(100, score));

    return { score, reasons };
  }
}

// ============================================================================
// Registry of available recommenders
// ============================================================================

export const RECOMMENDERS: Record<string, Recommender> = {
  visibility: new VisibilityRecommender(),
  // Future: Add ML-based recommender, user preference-based, etc.
};

/**
 * Get a recommender by name
 */
export function getRecommender(name: string): Recommender | undefined {
  return RECOMMENDERS[name];
}

/**
 * Get all available recommenders
 */
export function getAvailableRecommenders(): { id: string; name: string; description: string }[] {
  return Object.entries(RECOMMENDERS).map(([id, r]) => ({
    id,
    name: r.name,
    description: r.description,
  }));
}
