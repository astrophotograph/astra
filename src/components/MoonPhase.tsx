/**
 * Moon Phase Component - Displays moon phase with visual representation
 *
 * Uses the moon image and drawPlanetPhase algorithm from the legacy app
 */

import { useMemo } from "react";
import SunCalc from "suncalc";
import { format } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Moon as MoonIcon } from "lucide-react";
import { MoonImage } from "@/components/MoonImage";

interface MoonPhaseProps {
  date?: Date;
  latitude?: number;
  longitude?: number;
}

export function MoonPhase({
  date = new Date(),
  latitude = 41.8781, // Default to Chicago
  longitude = -87.6298,
}: MoonPhaseProps) {
  const moonData = useMemo(() => {
    const moonIllumination = SunCalc.getMoonIllumination(date);
    const moonTimes = SunCalc.getMoonTimes(date, latitude, longitude);
    const moonPosition = SunCalc.getMoonPosition(date, latitude, longitude);

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
    const pollutionLevel = getLightPollutionLevel(illuminationPercent);

    return {
      phase: getPhaseName(moonIllumination.phase),
      phaseValue: moonIllumination.phase,
      illumination: illuminationPercent,
      fraction: moonIllumination.fraction,
      age: moonIllumination.phase * 29.53, // Synodic month
      rise: moonTimes.rise ? format(moonTimes.rise, "HH:mm") : "N/A",
      set: moonTimes.set ? format(moonTimes.set, "HH:mm") : "N/A",
      altitude: (moonPosition.altitude * 180) / Math.PI, // Convert to degrees
      isVisible: moonPosition.altitude > 0,
      isWaxing: moonIllumination.phase <= 0.5,
      pollutionLevel,
    };
  }, [date, latitude, longitude]);

  // Format the date for display
  const dateDisplay = format(date, "eee MMM dd yyyy");

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <MoonIcon className="w-5 h-5" />
          Moon Phase
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Moon visualization using legacy algorithm */}
        <div className="flex justify-center">
          <MoonImage
            illumination={moonData.fraction}
            waxing={moonData.isWaxing}
            diameter={100}
          />
        </div>

        {/* Phase info */}
        <div className="text-center space-y-1">
          <div className="text-lg font-medium">{moonData.phase}</div>
          <div className="text-sm text-muted-foreground">
            {moonData.illumination.toFixed(0)}% illuminated
          </div>
          <div className="text-xs text-muted-foreground">
            Phase on {dateDisplay}
          </div>
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <div className="text-muted-foreground">Age</div>
            <div className="font-medium">{moonData.age.toFixed(1)} days</div>
          </div>
          <div>
            <div className="text-muted-foreground">Altitude</div>
            <div className="font-medium">
              {moonData.altitude > 0 ? `${moonData.altitude.toFixed(1)}°` : "Below horizon"}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Moonrise</div>
            <div className="font-medium">{moonData.rise}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Moonset</div>
            <div className="font-medium">{moonData.set}</div>
          </div>
        </div>

        {/* Visibility and light pollution */}
        <div className="space-y-2 pt-2 border-t">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Currently Visible</span>
            <Badge variant={moonData.isVisible ? "default" : "secondary"}>
              {moonData.isVisible ? "Yes" : "No"}
            </Badge>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Light Pollution</span>
            <Badge variant={moonData.pollutionLevel.variant}>
              {moonData.pollutionLevel.label}
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
  const moonData = useMemo(() => {
    const moonIllumination = SunCalc.getMoonIllumination(date);
    return {
      illumination: moonIllumination.fraction,
      isWaxing: moonIllumination.phase <= 0.5,
    };
  }, [date]);

  return (
    <MoonImage
      illumination={moonData.illumination}
      waxing={moonData.isWaxing}
      diameter={size}
      showImage={size >= 50} // Only show texture for larger sizes
    />
  );
}
