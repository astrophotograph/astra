/**
 * Moon Phase Component - Displays moon phase with visual representation
 *
 * Uses the moon image and drawPlanetPhase algorithm from the legacy app
 */

import { useMemo } from "react";
import { format } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Moon as MoonIcon } from "lucide-react";
import { MoonImage } from "@/components/MoonImage";
import { getMoonData } from "@/lib/moon";

interface MoonPhaseProps {
  date?: Date;
  latitude?: number;
  longitude?: number;
}

/** A bright moon is a warning for imaging, not a hard failure. */
function lightPollutionLevel(illuminationPercent: number): {
  label: string;
  className: string;
} {
  if (illuminationPercent < 25)
    return { label: "Minimal", className: "border-teal-500/50 bg-teal-500/10 text-teal-300" };
  if (illuminationPercent < 75)
    return { label: "Moderate", className: "border-border bg-slate-700/60 text-slate-300" };
  return { label: "High", className: "border-amber-500/40 bg-amber-500/10 text-amber-300" };
}

export function MoonPhase({
  date = new Date(),
  latitude = 41.8781, // Default to Chicago
  longitude = -87.6298,
}: MoonPhaseProps) {
  const moon = useMemo(
    () => getMoonData(date, latitude, longitude),
    [date, latitude, longitude],
  );
  const pollution = lightPollutionLevel(moon.illuminationPercent);

  // Format the date for display
  const dateDisplay = format(date, "eee MMM dd yyyy");

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="font-serif text-xl font-light tracking-wide text-slate-100 flex items-center gap-2">
          <MoonIcon className="w-5 h-5 text-slate-400" />
          Moon Phase
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Moon visualization using legacy algorithm */}
        <div className="flex justify-center">
          <MoonImage illumination={moon.fraction} waxing={moon.waxing} diameter={100} />
        </div>

        {/* Phase info */}
        <div className="text-center space-y-1">
          <div className="text-lg font-medium text-slate-100">{moon.phaseName}</div>
          <div className="text-sm text-muted-foreground">
            {moon.illuminationPercent}% illuminated
          </div>
          <div className="text-xs text-muted-foreground">Phase on {dateDisplay}</div>
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <div className="text-muted-foreground">Age</div>
            <div className="font-medium">{moon.ageDays.toFixed(1)} days</div>
          </div>
          <div>
            <div className="text-muted-foreground">Altitude</div>
            <div className="font-medium">
              {moon.altitude > 0 ? `${moon.altitude.toFixed(1)}°` : "Below horizon"}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Moonrise</div>
            <div className="font-medium font-mono">
              {moon.rise ? format(moon.rise, "HH:mm") : "N/A"}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Moonset</div>
            <div className="font-medium font-mono">
              {moon.set ? format(moon.set, "HH:mm") : "N/A"}
            </div>
          </div>
        </div>

        {/* Visibility and light pollution */}
        <div className="space-y-2 pt-2 border-t">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Currently Visible</span>
            <Badge
              variant="outline"
              className={
                moon.altitude > 0
                  ? "border-teal-500/50 bg-teal-500/10 text-teal-300"
                  : "border-border bg-slate-700/60 text-slate-400"
              }
            >
              {moon.altitude > 0 ? "Yes" : "No"}
            </Badge>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Light Pollution</span>
            <Badge variant="outline" className={pollution.className}>
              {pollution.label}
            </Badge>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Compact moon phase indicator for use in lists or headers
 */
export function MoonPhaseIndicator({
  date = new Date(),
  size = 24,
}: {
  date?: Date;
  size?: number;
}) {
  const moon = useMemo(() => getMoonData(date, 0, 0), [date]);

  return (
    <MoonImage
      illumination={moon.fraction}
      waxing={moon.waxing}
      diameter={size}
      showImage={size >= 50} // Only show texture for larger sizes
    />
  );
}
