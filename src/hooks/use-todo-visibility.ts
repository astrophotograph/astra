/**
 * Per-todo visibility computation for the Todo page: current alt/az, moon
 * separation, tonight's altitude curve summary, and the visibility window.
 * Recomputes every 5 minutes so "now"-dependent values stay fresh.
 */

import { useEffect, useState } from "react";
import type { AstronomyTodo } from "@/lib/tauri/commands";
import {
  parseCoordinates,
  calculateCurrentAltitude,
  calculateAltitudeAtTime,
  calculateCurrentAzimuth,
  azimuthToCompassDirection,
  generateNightAltitudeData,
  getMaxAltitudeTime,
  getHorizonAltitude,
  calculateAngularDistance,
  getMoonPosition,
  type HorizonProfile,
} from "@/lib/astronomy-utils";
import { calculateVisibilityWindow } from "@/lib/recommendations";
// Type-only in the other direction, so no runtime cycle.
import { getNightBounds } from "@/lib/imaging-order";

export interface TodoVisibility {
  raDeg: number | null;
  decDeg: number | null;
  altitude: number | null;
  azimuth: number | null;
  direction: string | null;
  /** Whether the object is climbing or sinking right now. */
  trend: "rising" | "setting" | null;
  peakTime: Date | null;
  maxAltitude: number | null;
  neverVisible: boolean;
  notVisibleRestOfNight: boolean;
  horizonAltitude: number | null;
  belowHorizon: boolean;
  moonDistance: number | null;
  /** Above min(20°, local horizon) tonight; sampled over the fixed night. */
  window: { start: Date; end: Date } | null;
  windowHours: number;
  optimalTime: Date | null;
}

const EMPTY: TodoVisibility = {
  raDeg: null,
  decDeg: null,
  altitude: null,
  azimuth: null,
  direction: null,
  trend: null,
  peakTime: null,
  maxAltitude: null,
  neverVisible: false,
  notVisibleRestOfNight: false,
  horizonAltitude: null,
  belowHorizon: false,
  moonDistance: null,
  window: null,
  windowHours: 0,
  optimalTime: null,
};

const REFRESH_MS = 5 * 60 * 1000;
const MIN_ALTITUDE = 20;

export function useTodoVisibility(
  todos: AstronomyTodo[],
  location: { latitude: number; longitude: number },
  horizon: HorizonProfile | null,
): { map: Map<string, TodoVisibility>; computedAt: Date | null } {
  const [state, setState] = useState<{
    map: Map<string, TodoVisibility>;
    computedAt: Date | null;
  }>({ map: new Map(), computedAt: null });

  useEffect(() => {
    const compute = () => {
      const now = new Date();
      // Sample over the real night (dusk→dawn), so windows never start at a
      // daylight hour and stay fixed as the night progresses.
      const night = getNightBounds(now, location.latitude, location.longitude);
      const moonPos = getMoonPosition(location);
      const map = new Map<string, TodoVisibility>();

      for (const todo of todos) {
        const coords = parseCoordinates(todo.ra, todo.dec);
        if (!coords) {
          map.set(todo.id, EMPTY);
          continue;
        }

        const altitude = calculateCurrentAltitude(coords.raDeg, coords.decDeg, location);
        const azimuth = calculateCurrentAzimuth(coords.raDeg, coords.decDeg, location);
        const direction = azimuthToCompassDirection(azimuth);
        const inFifteen = calculateAltitudeAtTime(
          coords.raDeg,
          coords.decDeg,
          location,
          new Date(now.getTime() + 15 * 60 * 1000),
        );
        const trend: TodoVisibility["trend"] = inFifteen > altitude ? "rising" : "setting";

        const moonDistance = calculateAngularDistance(
          altitude,
          azimuth,
          moonPos.altitude,
          moonPos.azimuth,
        );

        const altitudeData = generateNightAltitudeData(coords.raDeg, coords.decDeg, location);
        const peakTime = getMaxAltitudeTime(altitudeData);
        const maxAltitude =
          altitudeData.length > 0 ? Math.max(...altitudeData.map((p) => p.altitude)) : null;

        const horizonAltitude = horizon ? getHorizonAltitude(horizon, azimuth) : 0;
        const belowHorizon = altitude < horizonAltitude;

        // Visibility verdicts over the night curve, checking each sample
        // against the local horizon at that sample's own azimuth.
        let neverVisible = true;
        let wasVisibleEarlier = false;
        let willBeVisibleLater = false;
        for (const point of altitudeData) {
          const pointHorizon = horizon ? getHorizonAltitude(horizon, point.azimuth) : 0;
          if (point.altitude > Math.max(MIN_ALTITUDE, pointHorizon)) {
            neverVisible = false;
            if (point.time < now) {
              wasVisibleEarlier = true;
            } else {
              willBeVisibleLater = true;
            }
          }
        }
        const notVisibleRestOfNight = !neverVisible && wasVisibleEarlier && !willBeVisibleLater;

        // Fixed full-night window so it doesn't shrink as the night goes on.
        // calculateVisibilityWindow takes RA in HOURS, not degrees.
        const vis = calculateVisibilityWindow(
          coords.raDeg / 15,
          coords.decDeg,
          location.latitude,
          location.longitude,
          MIN_ALTITUDE,
          horizon ?? undefined,
          night.dusk,
          night.dawn,
        );
        const window =
          vis.visibilityStart && vis.visibilityEnd
            ? { start: vis.visibilityStart, end: vis.visibilityEnd }
            : null;

        map.set(todo.id, {
          raDeg: coords.raDeg,
          decDeg: coords.decDeg,
          altitude,
          azimuth,
          direction,
          trend,
          peakTime: neverVisible ? null : peakTime,
          maxAltitude,
          neverVisible,
          notVisibleRestOfNight,
          horizonAltitude,
          belowHorizon,
          moonDistance,
          window,
          windowHours: vis.visibilityHours,
          optimalTime: window ? vis.optimalTime : null,
        });
      }

      setState({ map, computedAt: now });
    };

    compute();
    const interval = setInterval(compute, REFRESH_MS);
    return () => clearInterval(interval);
  }, [todos, location.latitude, location.longitude, horizon]);

  return state;
}
