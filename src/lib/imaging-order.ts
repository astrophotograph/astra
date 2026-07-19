/**
 * Tonight's imaging order — turns precomputed per-todo visibility into an
 * ordered observing sequence for the night. Pure; no astronomy math here
 * beyond night bounds (all windows come from useTodoVisibility).
 *
 * Ordering principle: catch what sets first. Objects are sequenced by when
 * their visibility window closes, so nothing is missed while imaging a
 * target that would have stayed up all night anyway.
 */

import SunCalc from "suncalc";
import type { AstronomyTodo } from "@/lib/tauri/commands";
import { parseTimeString } from "@/lib/astronomy-utils";
import type { TodoVisibility } from "@/hooks/use-todo-visibility";
import type { MoonData } from "@/lib/moon";

export type SlotStatus = "tonight" | "already-set" | "not-tonight" | "no-coords";

export interface ImagingSlot {
  todo: AstronomyTodo;
  status: SlotStatus;
  /** 1-based position in tonight's sequence; null outside it. */
  order: number | null;
  /** Visibility window clipped to the night bounds. */
  window: { start: Date; end: Date } | null;
  optimalTime: Date | null;
  maxAltitude: number | null;
  moonDistance: number | null;
  moonWarning: boolean;
  /** Parsed "HH:MM" goal for timeline markers; null for duration goals. */
  goalTimeOfDay: { hours: number; minutes: number } | null;
  goalLabel: string | null;
}

export interface NightBounds {
  dusk: Date;
  dawn: Date;
  source: "astronomical" | "nautical" | "civil" | "fallback";
}

export interface ImagingOrder {
  /** tonight (ordered) → already-set → not-tonight → no-coords. */
  slots: ImagingSlot[];
  night: NightBounds;
  /** True when flagged pending todos existed and defined the candidate set. */
  usedFlaggedOnly: boolean;
}

interface OrderOptions {
  minWindowMinutes?: number;
  moonWarnDeg?: number;
}

const valid = (d: Date | undefined): d is Date =>
  d instanceof Date && !isNaN(d.getTime());

function noon(date: Date): Date {
  const d = new Date(date);
  // Anchor on the previous noon so an after-midnight "now" resolves to the
  // night already in progress.
  if (d.getHours() < 12) {
    d.setDate(d.getDate() - 1);
  }
  d.setHours(12, 0, 0, 0);
  return d;
}

/**
 * Dusk→dawn for the night containing (or following) `date`. Falls back
 * astronomical → nautical → civil → fixed 18:00–06:00, for latitudes and
 * seasons where SunCalc reports no such twilight (returns invalid dates).
 */
export function getNightBounds(date: Date, lat: number, lon: number): NightBounds {
  const dayAnchor = noon(date);
  const nextAnchor = new Date(dayAnchor.getTime() + 24 * 60 * 60 * 1000);
  const tonight = SunCalc.getTimes(dayAnchor, lat, lon);
  const tomorrow = SunCalc.getTimes(nextAnchor, lat, lon);

  const attempts: Array<{
    dusk: Date | undefined;
    dawn: Date | undefined;
    source: NightBounds["source"];
  }> = [
    { dusk: tonight.night, dawn: tomorrow.nightEnd, source: "astronomical" },
    { dusk: tonight.nauticalDusk, dawn: tomorrow.nauticalDawn, source: "nautical" },
    { dusk: tonight.dusk, dawn: tomorrow.dawn, source: "civil" },
  ];
  for (const { dusk, dawn, source } of attempts) {
    if (valid(dusk) && valid(dawn) && dawn.getTime() > dusk.getTime()) {
      return { dusk, dawn, source };
    }
  }

  const dusk = new Date(dayAnchor);
  dusk.setHours(18, 0, 0, 0);
  const dawn = new Date(dayAnchor);
  dawn.setDate(dawn.getDate() + 1);
  dawn.setHours(6, 0, 0, 0);
  return { dusk, dawn, source: "fallback" };
}

export function computeImagingOrder(
  todos: AstronomyTodo[],
  visibility: Map<string, TodoVisibility>,
  location: { latitude: number; longitude: number },
  moon: Pick<MoonData, "illuminationPercent"> | null,
  now: Date = new Date(),
  opts: OrderOptions = {},
): ImagingOrder {
  const { minWindowMinutes = 30, moonWarnDeg = 30 } = opts;
  const night = getNightBounds(now, location.latitude, location.longitude);

  const pending = todos.filter((t) => !t.completed);
  const flagged = pending.filter((t) => t.flagged);
  const usedFlaggedOnly = flagged.length > 0;
  const candidates = usedFlaggedOnly ? flagged : pending;

  const tonight: ImagingSlot[] = [];
  const alreadySet: ImagingSlot[] = [];
  const notTonight: ImagingSlot[] = [];
  const noCoords: ImagingSlot[] = [];

  for (const todo of candidates) {
    const v = visibility.get(todo.id);
    const goalTimeOfDay = todo.goal_time ? parseTimeString(todo.goal_time) : null;
    const base = {
      todo,
      order: null as number | null,
      optimalTime: v?.optimalTime ?? null,
      maxAltitude: v?.maxAltitude ?? null,
      moonDistance: v?.moonDistance ?? null,
      moonWarning:
        v?.moonDistance != null &&
        v.moonDistance < moonWarnDeg &&
        (moon?.illuminationPercent ?? 0) >= 20,
      goalTimeOfDay,
      goalLabel: todo.goal_time,
    };

    if (!v || v.raDeg == null) {
      noCoords.push({ ...base, status: "no-coords", window: null });
      continue;
    }
    if (!v.window) {
      notTonight.push({ ...base, status: "not-tonight", window: null });
      continue;
    }

    // Clip the window to the night bounds.
    const start = new Date(Math.max(v.window.start.getTime(), night.dusk.getTime()));
    const end = new Date(Math.min(v.window.end.getTime(), night.dawn.getTime()));
    if (end.getTime() - start.getTime() < minWindowMinutes * 60 * 1000) {
      notTonight.push({ ...base, status: "not-tonight", window: null });
    } else if (end.getTime() < now.getTime()) {
      alreadySet.push({ ...base, status: "already-set", window: { start, end } });
    } else {
      tonight.push({ ...base, status: "tonight", window: { start, end } });
    }
  }

  const byWindowEnd = (a: ImagingSlot, b: ImagingSlot): number => {
    const endDiff = (a.window?.end.getTime() ?? 0) - (b.window?.end.getTime() ?? 0);
    if (endDiff !== 0) return endDiff;
    const optDiff =
      (a.optimalTime?.getTime() ?? Infinity) - (b.optimalTime?.getTime() ?? Infinity);
    if (optDiff !== 0) return optDiff;
    return a.todo.name.localeCompare(b.todo.name);
  };
  tonight.sort(byWindowEnd);
  alreadySet.sort(byWindowEnd);
  tonight.forEach((slot, i) => {
    slot.order = i + 1;
  });

  return {
    slots: [...tonight, ...alreadySet, ...notTonight, ...noCoords],
    night,
    usedFlaggedOnly,
  };
}
