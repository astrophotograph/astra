/**
 * TonightTimeline — the night's imaging sequence as horizontal window bars
 * on a dusk→dawn axis. Indigo bars = visibility windows, teal tick =
 * optimal time, violet diamond = HH:MM goal, violet line = now.
 */

import { useState } from "react";
import { Moon } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatTime } from "@/lib/astronomy-utils";
import type { ImagingOrder, ImagingSlot } from "@/lib/imaging-order";

interface TonightTimelineProps {
  order: ImagingOrder;
  now?: Date;
  selectedId?: string | null;
  onSelectObject?: (id: string) => void;
  maxRows?: number;
}

export function TonightTimeline({
  order,
  now = new Date(),
  selectedId,
  onSelectObject,
  maxRows = 8,
}: TonightTimelineProps) {
  const [showAll, setShowAll] = useState(false);
  const { dusk, dawn } = order.night;
  const nightMs = dawn.getTime() - dusk.getTime();

  const pct = (t: Date): number =>
    Math.min(100, Math.max(0, ((t.getTime() - dusk.getTime()) / nightMs) * 100));

  const tonightSlots = order.slots.filter((s) => s.status === "tonight");
  const alreadySet = order.slots.filter((s) => s.status === "already-set");
  const skipped = order.slots.filter(
    (s) => s.status === "not-tonight" || s.status === "no-coords",
  );

  const visibleSlots = showAll ? tonightSlots : tonightSlots.slice(0, maxRows);
  const hiddenCount = tonightSlots.length - visibleSlots.length;

  // Hour ticks every 2h starting at the first full hour after dusk.
  const ticks: Date[] = [];
  const firstTick = new Date(dusk);
  firstTick.setMinutes(0, 0, 0);
  if (firstTick <= dusk) firstTick.setHours(firstTick.getHours() + 1);
  for (let t = new Date(firstTick); t < dawn; t = new Date(t.getTime() + 2 * 3600_000)) {
    ticks.push(new Date(t));
  }

  const nowVisible = now >= dusk && now <= dawn;

  // Resolve an HH:MM goal onto the night axis: evening hours belong to the
  // dusk day, small hours to the dawn day.
  const goalDate = (slot: ImagingSlot): Date | null => {
    if (!slot.goalTimeOfDay) return null;
    const { hours, minutes } = slot.goalTimeOfDay;
    const d = new Date(dusk);
    if (hours < 12) d.setDate(d.getDate() + 1);
    d.setHours(hours, minutes, 0, 0);
    return d >= dusk && d <= dawn ? d : null;
  };

  const LABEL_COL = "w-[120px] sm:w-[140px] shrink-0";

  return (
    <div className="min-w-0">
      {/* Axis */}
      <div className="flex items-center">
        <div className={LABEL_COL} />
        <div className="relative flex-1 h-5">
          {ticks.map((t) => (
            <span
              key={t.getTime()}
              className="absolute -translate-x-1/2 text-[10px] text-slate-500 font-mono"
              style={{ left: `${pct(t)}%` }}
            >
              {formatTime(t)}
            </span>
          ))}
        </div>
      </div>

      {/* Rows */}
      <div className="relative">
        {/* Hour grid lines + now line span the bar area only */}
        <div className={cn("absolute inset-y-0 right-0", "left-[120px] sm:left-[140px]")}>
          {ticks.map((t) => (
            <div
              key={t.getTime()}
              className="absolute inset-y-0 w-px bg-indigo-500/10"
              style={{ left: `${pct(t)}%` }}
            />
          ))}
          {nowVisible && (
            <div
              className="absolute inset-y-0 w-px bg-violet-400/70 z-10"
              style={{ left: `${pct(now)}%` }}
            >
              <div className="absolute -top-0.5 -translate-x-1/2 w-1.5 h-1.5 rounded-full bg-violet-400" />
            </div>
          )}
        </div>

        {visibleSlots.map((slot) => (
          <TimelineRow
            key={slot.todo.id}
            slot={slot}
            pct={pct}
            goal={goalDate(slot)}
            nowPct={nowVisible ? pct(now) : null}
            selected={selectedId === slot.todo.id}
            onSelect={onSelectObject}
            labelCol={LABEL_COL}
          />
        ))}
        {alreadySet.map((slot) => (
          <TimelineRow
            key={slot.todo.id}
            slot={slot}
            pct={pct}
            goal={null}
            nowPct={null}
            selected={selectedId === slot.todo.id}
            onSelect={onSelectObject}
            labelCol={LABEL_COL}
            dimmed
          />
        ))}
      </div>

      {hiddenCount > 0 && (
        <button
          className="mt-1 text-xs text-indigo-300 hover:text-indigo-200 transition-colors"
          onClick={() => setShowAll(true)}
        >
          Show all {tonightSlots.length}
        </button>
      )}

      {skipped.length > 0 && (
        <p className="mt-2 text-xs text-slate-500">
          Not tonight:{" "}
          {skipped.map((slot, i) => (
            <span key={slot.todo.id}>
              {i > 0 && ", "}
              <button
                className="hover:text-slate-300 underline decoration-slate-600 underline-offset-2 transition-colors"
                onClick={() => onSelectObject?.(slot.todo.id)}
                title={
                  slot.status === "no-coords"
                    ? "No coordinates"
                    : "Below the visibility threshold all night"
                }
              >
                {slot.todo.name}
              </button>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

interface TimelineRowProps {
  slot: ImagingSlot;
  pct: (t: Date) => number;
  goal: Date | null;
  nowPct: number | null;
  selected: boolean;
  onSelect?: (id: string) => void;
  labelCol: string;
  dimmed?: boolean;
}

function TimelineRow({ slot, pct, goal, nowPct, selected, onSelect, labelCol, dimmed }: TimelineRowProps) {
  if (!slot.window) return null;
  const left = pct(slot.window.start);
  const width = Math.max(1.5, pct(slot.window.end) - left);
  const windowTitle = `${slot.todo.name}: ${formatTime(slot.window.start)}–${formatTime(
    slot.window.end,
  )}${slot.optimalTime ? ` · best ${formatTime(slot.optimalTime)}` : ""}`;

  return (
    <div
      className={cn(
        "flex items-center h-8 rounded-md cursor-pointer transition-colors",
        selected ? "bg-slate-700/40" : "hover:bg-slate-700/25",
        dimmed && "opacity-40",
      )}
      onClick={() => onSelect?.(slot.todo.id)}
      title={windowTitle}
    >
      <div className={cn(labelCol, "flex items-center gap-1.5 min-w-0 pl-1.5")}>
        {selected && <span className="w-0.5 self-stretch my-1 rounded bg-teal-400 shrink-0" />}
        {slot.order != null && (
          <span className="font-mono text-[11px] text-indigo-300 shrink-0">#{slot.order}</span>
        )}
        <span
          className={cn(
            "text-sm truncate",
            dimmed ? "text-slate-500 line-through decoration-slate-600" : "text-slate-100",
          )}
        >
          {slot.todo.name}
        </span>
        {slot.moonWarning && (
          <Moon
            className="w-3 h-3 text-amber-400 shrink-0"
            aria-label={`${slot.moonDistance?.toFixed(0)}° from the moon`}
          />
        )}
      </div>
      <div className="relative flex-1 h-full">
        {/* Window bar */}
        <div
          className="absolute top-1/2 -translate-y-1/2 h-2.5 rounded-full bg-indigo-500/30 ring-1 ring-inset ring-indigo-400/40"
          style={{ left: `${left}%`, width: `${width}%` }}
        />
        {/* Elapsed dimming over the past part of the bar */}
        {nowPct != null && nowPct > left && (
          <div
            className="absolute top-1/2 -translate-y-1/2 h-2.5 rounded-l-full bg-slate-900/50"
            style={{ left: `${left}%`, width: `${Math.min(nowPct, left + width) - left}%` }}
          />
        )}
        {/* Optimal-time tick */}
        {slot.optimalTime && (
          <div
            className="absolute top-1/2 -translate-y-1/2 w-0.5 h-4 bg-teal-400 rounded"
            style={{ left: `${pct(slot.optimalTime)}%` }}
          />
        )}
        {/* Goal marker */}
        {goal && (
          <div
            className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-[7px] h-[7px] rotate-45 bg-violet-400"
            style={{ left: `${pct(goal)}%` }}
            title={`Goal ${formatTime(goal)}`}
          />
        )}
      </div>
    </div>
  );
}
