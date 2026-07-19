/**
 * Shared status color semantics for astronomy visibility UI.
 * Teal = good/visible, amber = warning, red only for never-visible.
 */

export function altitudeColorClass(altitude: number | null): string {
  if (altitude === null) return "text-muted-foreground";
  if (altitude < 0) return "text-slate-500";
  if (altitude < 20) return "text-amber-400";
  if (altitude < 40) return "text-teal-300";
  return "text-teal-400";
}

export type VisibilityStatus = "good" | "warning" | "never";

export function visibilityStatusClass(status: VisibilityStatus): string {
  switch (status) {
    case "good":
      return "text-teal-400";
    case "warning":
      return "text-amber-400";
    case "never":
      return "text-red-400";
  }
}
