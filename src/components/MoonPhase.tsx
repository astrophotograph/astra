/**
 * Moon Phase Component - Displays current moon phase with visual representation
 */

import { useMemo } from "react";
import SunCalc from "suncalc";
import { format } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Moon as MoonIcon } from "lucide-react";

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
      age: moonIllumination.phase * 29.53, // Synodic month
      rise: moonTimes.rise ? format(moonTimes.rise, "HH:mm") : "N/A",
      set: moonTimes.set ? format(moonTimes.set, "HH:mm") : "N/A",
      altitude: (moonPosition.altitude * 180) / Math.PI, // Convert to degrees
      isVisible: moonPosition.altitude > 0,
      isWaxing: moonIllumination.phase < 0.5,
      pollutionLevel,
    };
  }, [date, latitude, longitude]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <MoonIcon className="w-5 h-5" />
          Moon Phase
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Moon visualization */}
        <div className="flex justify-center">
          <MoonVisualization
            illumination={moonData.illumination / 100}
            isWaxing={moonData.isWaxing}
          />
        </div>

        {/* Phase info */}
        <div className="text-center space-y-1">
          <div className="text-lg font-medium">{moonData.phase}</div>
          <div className="text-sm text-muted-foreground">
            {moonData.illumination.toFixed(0)}% illuminated
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
 * Visual representation of the moon phase using CSS
 */
function MoonVisualization({
  illumination,
  isWaxing,
  size = 80,
}: {
  illumination: number;
  isWaxing: boolean;
  size?: number;
}) {
  // Calculate the shadow position based on illumination and phase
  // illumination: 0 = new moon, 1 = full moon
  // isWaxing: true = growing (shadow on left), false = shrinking (shadow on right)

  const getShadowStyle = () => {
    if (illumination < 0.01) {
      // New moon - completely dark
      return {
        background: "#1a1a2e",
      };
    }

    if (illumination > 0.99) {
      // Full moon - completely lit
      return {
        background: "radial-gradient(circle at 30% 30%, #f5f5f0, #c9c9c0)",
      };
    }

    // Calculate the terminator position
    // We use an ellipse overlay to create the shadow effect
    const shadowColor = "#1a1a2e";
    const lightColor = "#e8e8e0";

    if (illumination < 0.5) {
      // Less than half lit
      const coverPercent = (0.5 - illumination) * 2 * 100;
      if (isWaxing) {
        // Waxing crescent - light on right
        return {
          background: `linear-gradient(90deg, ${shadowColor} ${coverPercent}%, ${lightColor} ${coverPercent}%)`,
        };
      } else {
        // Waning crescent - light on left
        return {
          background: `linear-gradient(90deg, ${lightColor} ${100 - coverPercent}%, ${shadowColor} ${100 - coverPercent}%)`,
        };
      }
    } else {
      // More than half lit
      const coverPercent = (illumination - 0.5) * 2 * 100;
      if (isWaxing) {
        // Waxing gibbous - shadow on left
        return {
          background: `linear-gradient(90deg, ${shadowColor} ${100 - coverPercent}%, ${lightColor} ${100 - coverPercent}%)`,
        };
      } else {
        // Waning gibbous - shadow on right
        return {
          background: `linear-gradient(90deg, ${lightColor} ${coverPercent}%, ${shadowColor} ${coverPercent}%)`,
        };
      }
    }
  };

  return (
    <div
      className="relative rounded-full overflow-hidden"
      style={{
        width: size,
        height: size,
        boxShadow: "inset 0 0 20px rgba(0,0,0,0.3), 0 0 10px rgba(255,255,255,0.1)",
      }}
    >
      {/* Base moon surface */}
      <div
        className="absolute inset-0 rounded-full"
        style={{
          background: "radial-gradient(circle at 35% 35%, #f5f5f0 0%, #d4d4cc 50%, #a8a8a0 100%)",
        }}
      />

      {/* Shadow overlay */}
      <div
        className="absolute inset-0 rounded-full"
        style={{
          ...getShadowStyle(),
          mixBlendMode: "multiply",
        }}
      />

      {/* Crater details (subtle) */}
      <div
        className="absolute inset-0 rounded-full opacity-20"
        style={{
          background: `
            radial-gradient(circle at 25% 30%, rgba(0,0,0,0.3) 0%, transparent 8%),
            radial-gradient(circle at 60% 40%, rgba(0,0,0,0.2) 0%, transparent 12%),
            radial-gradient(circle at 45% 65%, rgba(0,0,0,0.25) 0%, transparent 10%),
            radial-gradient(circle at 70% 25%, rgba(0,0,0,0.15) 0%, transparent 6%)
          `,
        }}
      />
    </div>
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
      isWaxing: moonIllumination.phase < 0.5,
    };
  }, [date]);

  return (
    <MoonVisualization
      illumination={moonData.illumination}
      isWaxing={moonData.isWaxing}
      size={size}
    />
  );
}
