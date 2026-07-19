/**
 * Live moon data for the active observer location, refreshed periodically.
 */

import { useEffect, useState } from "react";
import { useLocations } from "@/contexts/LocationContext";
import { getMoonData, type MoonData } from "@/lib/moon";

export function useMoonData(refreshMs = 5 * 60_000): MoonData | null {
  const { activeLocation } = useLocations();
  const latitude = activeLocation?.latitude;
  const longitude = activeLocation?.longitude;

  const [moon, setMoon] = useState<MoonData | null>(() =>
    latitude != null && longitude != null
      ? getMoonData(new Date(), latitude, longitude)
      : null,
  );

  useEffect(() => {
    if (latitude == null || longitude == null) {
      setMoon(null);
      return;
    }
    const compute = () => setMoon(getMoonData(new Date(), latitude, longitude));
    compute();
    const interval = setInterval(compute, refreshMs);
    return () => clearInterval(interval);
  }, [latitude, longitude, refreshMs]);

  return moon;
}
