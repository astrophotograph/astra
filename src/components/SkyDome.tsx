/**
 * SkyDome — polar all-sky chart of current object positions.
 *
 * Overhead-view projection: zenith at the center, horizon at the rim,
 * north up and east on the LEFT (the astronomy convention for a chart
 * held up against the sky, mirroring a ground map).
 */

import { useState } from "react";
import type { HorizonProfile } from "@/lib/astronomy-utils";
import { getHorizonAltitude, azimuthToCompassDirection } from "@/lib/astronomy-utils";
import type { MoonData } from "@/lib/moon";
import { cn } from "@/lib/utils";

export interface SkyDomeObject {
  id: string;
  name: string;
  altitude: number;
  /** Degrees, north-based (0 = N, 90 = E). */
  azimuth: number;
  state: "flagged" | "pending" | "completed";
  /** Tonight's slot number, shown beside flagged dots. */
  order?: number | null;
}

interface SkyDomeProps {
  objects: SkyDomeObject[];
  moon?: Pick<MoonData, "altitude" | "azimuth" | "illuminationPercent" | "fraction"> | null;
  horizon?: HorizonProfile | null;
  size?: number;
  selectedId?: string | null;
  onSelectObject?: (id: string) => void;
  showLabels?: "flagged" | "all" | "none";
  className?: string;
}

export function SkyDome({
  objects,
  moon,
  horizon,
  size = 300,
  selectedId,
  onSelectObject,
  showLabels = "flagged",
  className,
}: SkyDomeProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const c = size / 2;
  const R = c - 24;

  // alt 90° → center, alt 0° → rim; N up, E left (overhead view).
  const project = (altitude: number, azimuth: number): { x: number; y: number } => {
    const r = (R * (90 - Math.max(0, altitude))) / 90;
    const az = (azimuth * Math.PI) / 180;
    return { x: c - r * Math.sin(az), y: c - r * Math.cos(az) };
  };

  // Horizon-profile blockage: ring between the rim and the local horizon
  // line, built as an evenodd path (outer circle minus horizon polygon).
  let horizonPath: string | null = null;
  if (horizon && horizon.points.length > 0) {
    const outer =
      `M ${c} ${c - R} A ${R} ${R} 0 1 1 ${c - 0.01} ${c - R} Z`;
    const pts: string[] = [];
    for (let az = 0; az <= 360; az += 3) {
      const alt = Math.max(0, getHorizonAltitude(horizon, az % 360));
      const { x, y } = project(alt, az % 360);
      pts.push(`${az === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`);
    }
    horizonPath = `${outer} ${pts.join(" ")} Z`;
  }

  const visible = objects.filter((o) => o.altitude >= 0);
  const moonUp = moon && moon.altitude > 0;
  const moonPos = moonUp ? project(moon.altitude, moon.azimuth) : null;

  return (
    <div className={cn("flex flex-col items-center gap-1.5", className)}>
      <svg
        viewBox={`0 0 ${size} ${size}`}
        className="w-full max-w-[320px] aspect-square"
        role="img"
        aria-label="Sky chart of current object positions"
      >
        {/* Sky disc */}
        <circle cx={c} cy={c} r={R} fill="#0a0e1a" stroke="rgba(99,102,241,0.25)" />

        {/* Altitude rings at 30° and 60° */}
        {[30, 60].map((alt) => (
          <g key={alt}>
            <circle
              cx={c}
              cy={c}
              r={(R * (90 - alt)) / 90}
              fill="none"
              stroke="rgba(99,102,241,0.12)"
            />
            <text
              x={c + 3}
              y={c - (R * (90 - alt)) / 90 - 2}
              fontSize={8}
              fill="#4a5578"
            >
              {alt}°
            </text>
          </g>
        ))}
        {/* Cross hairs */}
        <line x1={c - R} y1={c} x2={c + R} y2={c} stroke="rgba(99,102,241,0.08)" />
        <line x1={c} y1={c - R} x2={c} y2={c + R} stroke="rgba(99,102,241,0.08)" />

        {/* Horizon-profile blockage */}
        {horizonPath && (
          <path d={horizonPath} fill="rgba(6,9,18,0.8)" fillRule="evenodd" />
        )}

        {/* Cardinal labels — E left: looking up, not down at a map */}
        {(
          [
            { label: "N", x: c, y: c - R - 8, anchor: "middle", baseline: "auto" },
            { label: "S", x: c, y: c + R + 14, anchor: "middle", baseline: "auto" },
            { label: "E", x: c - R - 8, y: c + 3, anchor: "end", baseline: "middle" },
            { label: "W", x: c + R + 8, y: c + 3, anchor: "start", baseline: "middle" },
          ] as const
        ).map(({ label, x, y, anchor }) => (
          <text
            key={label}
            x={x}
            y={y}
            fontSize={10}
            letterSpacing={1}
            textAnchor={anchor}
            fill={label === "N" ? "#c8cdd8" : "#4a5578"}
          >
            {label}
          </text>
        ))}

        {/* Moon */}
        {moonUp && moonPos && (
          <g>
            <defs>
              <radialGradient id="skydome-moon-glow">
                <stop offset="0%" stopColor="#e8ecf4" stopOpacity={0.5} />
                <stop offset="100%" stopColor="#e8ecf4" stopOpacity={0} />
              </radialGradient>
            </defs>
            <circle
              cx={moonPos.x}
              cy={moonPos.y}
              r={6 + moon.illuminationPercent / 12}
              fill="url(#skydome-moon-glow)"
            />
            <circle
              cx={moonPos.x}
              cy={moonPos.y}
              r={5}
              fill="#e8ecf4"
              opacity={0.5 + moon.fraction / 2}
            />
            <title>Moon — {moon.illuminationPercent}% illuminated</title>
          </g>
        )}

        {/* Objects */}
        {visible.map((o) => {
          const { x, y } = project(o.altitude, o.azimuth);
          const belowLocalHorizon =
            horizon != null && o.altitude < getHorizonAltitude(horizon, o.azimuth);
          const selected = selectedId === o.id;
          const labeled =
            showLabels === "all" ||
            (showLabels === "flagged" && o.state === "flagged") ||
            hoveredId === o.id;
          const dotFill =
            o.state === "flagged"
              ? "#818cf8"
              : o.state === "completed"
                ? "rgba(128,203,196,0.6)"
                : "#8891a4";

          return (
            <g
              key={o.id}
              role={onSelectObject ? "button" : undefined}
              tabIndex={onSelectObject ? 0 : undefined}
              className={onSelectObject ? "cursor-pointer" : undefined}
              opacity={belowLocalHorizon ? 0.35 : 1}
              onClick={() => onSelectObject?.(o.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") onSelectObject?.(o.id);
              }}
              onMouseEnter={() => setHoveredId(o.id)}
              onMouseLeave={() => setHoveredId(null)}
            >
              {o.state === "flagged" && (
                <circle cx={x} cy={y} r={10} fill="rgba(99,102,241,0.25)" />
              )}
              {selected && (
                <circle cx={x} cy={y} r={8} fill="none" stroke="#80cbc4" strokeWidth={1.5} />
              )}
              <circle cx={x} cy={y} r={o.state === "flagged" ? 4.5 : 3} fill={dotFill} />
              {o.state === "flagged" && o.order != null && (
                <text x={x + 7} y={y - 5} fontSize={9} fill="#c7d2fe" fontFamily="monospace">
                  {o.order}
                </text>
              )}
              {labeled && (
                <text x={x + 7} y={y + 9} fontSize={9} fill="#c8cdd8">
                  {o.name}
                </text>
              )}
              <title>
                {o.name} — {o.altitude.toFixed(0)}° {azimuthToCompassDirection(o.azimuth)}
              </title>
            </g>
          );
        })}
      </svg>
      <p className="text-[11px] text-slate-500">
        Sky now · N up, E left · refreshes every 5 min
      </p>
    </div>
  );
}
