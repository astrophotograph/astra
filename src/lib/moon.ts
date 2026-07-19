/**
 * Moon math — the single source of truth for phase/illumination/rise/set.
 *
 * Components must not call SunCalc moon functions directly: SunCalc's
 * azimuth is south-based and its phase needs bucketing into names, and
 * getting either wrong silently produces a believable-but-wrong moon.
 */

import SunCalc from "suncalc";

export interface MoonData {
  date: Date;
  /** Illuminated fraction 0–1 (0 = new, 1 = full). */
  fraction: number;
  /** Illuminated fraction as a rounded percentage. */
  illuminationPercent: number;
  /** Raw SunCalc phase 0–1 (0 = new, 0.5 = full). */
  phase: number;
  phaseName: string;
  /** True through new → full (shadow on the left when drawn). */
  waxing: boolean;
  ageDays: number;
  /** Degrees above the horizon (negative when set). */
  altitude: number;
  /** Degrees, north-based (0 = N, 90 = E). */
  azimuth: number;
  rise: Date | null;
  set: Date | null;
}

const SYNODIC_MONTH_DAYS = 29.53;

export function getMoonPhaseName(phase: number): string {
  if (phase < 0.03) return "New Moon";
  if (phase < 0.22) return "Waxing Crescent";
  if (phase < 0.28) return "First Quarter";
  if (phase < 0.47) return "Waxing Gibbous";
  if (phase < 0.53) return "Full Moon";
  if (phase < 0.72) return "Waning Gibbous";
  if (phase < 0.78) return "Last Quarter";
  if (phase < 0.97) return "Waning Crescent";
  return "New Moon";
}

export function getMoonData(date: Date, latitude: number, longitude: number): MoonData {
  const illum = SunCalc.getMoonIllumination(date);
  const pos = SunCalc.getMoonPosition(date, latitude, longitude);
  const times = SunCalc.getMoonTimes(date, latitude, longitude);

  const valid = (d: Date | undefined): Date | null =>
    d instanceof Date && !isNaN(d.getTime()) ? d : null;

  return {
    date,
    fraction: illum.fraction,
    illuminationPercent: Math.round(illum.fraction * 100),
    phase: illum.phase,
    phaseName: getMoonPhaseName(illum.phase),
    waxing: illum.phase <= 0.5,
    ageDays: illum.phase * SYNODIC_MONTH_DAYS,
    altitude: (pos.altitude * 180) / Math.PI,
    // SunCalc azimuth is measured from south; normalize to north-based.
    azimuth: ((pos.azimuth * 180) / Math.PI + 180) % 360,
    rise: valid(times.rise),
    set: valid(times.set),
  };
}
