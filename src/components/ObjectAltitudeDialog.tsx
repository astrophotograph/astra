/**
 * Object Altitude Dialog
 * Shows detailed altitude/visibility information for an astronomical object
 */

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AltitudeChart, AltitudeDataPoint, HorizonDataPoint } from "@/components/AltitudeChart";
import {
  parseCoordinates,
  calculateCurrentAltitude,
  calculateCurrentAzimuth,
  generateNightAltitudeData,
  formatTime,
  defaultCoordinates,
  loadHorizonProfile,
  getHorizonAltitude,
  type HorizonProfile,
} from "@/lib/astronomy-utils";

interface ObjectAltitudeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  objectName: string;
  ra: string;
  dec: string;
  onSetGoalTime?: (time: string) => void;
}

export function ObjectAltitudeDialog({
  open,
  onOpenChange,
  objectName,
  ra,
  dec,
  onSetGoalTime,
}: ObjectAltitudeDialogProps) {
  const [altitudeData, setAltitudeData] = useState<AltitudeDataPoint[]>([]);
  const [horizonData, setHorizonData] = useState<HorizonDataPoint[]>([]);
  const [horizonProfile, setHorizonProfile] = useState<HorizonProfile | null>(null);
  const [currentAltitude, setCurrentAltitude] = useState<number | null>(null);
  const [currentHorizonAlt, setCurrentHorizonAlt] = useState<number | null>(null);
  const [idealTimeRange, setIdealTimeRange] = useState<{ start: Date | null; end: Date | null }>({
    start: null,
    end: null,
  });
  const [coordinates, setCoordinates] = useState(defaultCoordinates);
  const [isEditingLocation, setIsEditingLocation] = useState(false);
  const [latitude, setLatitude] = useState(defaultCoordinates.latitude.toString());
  const [longitude, setLongitude] = useState(defaultCoordinates.longitude.toString());
  const [bestObservationTime, setBestObservationTime] = useState<Date | null>(null);
  const [maxAltitude, setMaxAltitude] = useState<number | null>(null);

  // Load coordinates and horizon profile from localStorage when dialog opens
  useEffect(() => {
    if (!open) return;

    const savedLocation = localStorage.getItem("observer_location");
    if (savedLocation) {
      try {
        const parsed = JSON.parse(savedLocation);
        if (parsed.latitude && parsed.longitude) {
          setCoordinates({
            latitude: parsed.latitude,
            longitude: parsed.longitude,
          });
          setLatitude(parsed.latitude.toString());
          setLongitude(parsed.longitude.toString());
        }
      } catch {
        // Use default
      }
    }

    // Load horizon profile
    setHorizonProfile(loadHorizonProfile());
  }, [open]);

  // Calculate altitude data when dialog opens or coordinates change
  useEffect(() => {
    if (!open) return;

    const parsedCoords = parseCoordinates(ra, dec);
    if (!parsedCoords) {
      setAltitudeData([]);
      setHorizonData([]);
      setCurrentAltitude(null);
      setCurrentHorizonAlt(null);
      return;
    }

    const { raDeg, decDeg } = parsedCoords;

    // Calculate current altitude and azimuth
    const altitude = calculateCurrentAltitude(raDeg, decDeg, coordinates);
    const currentAzimuth = calculateCurrentAzimuth(raDeg, decDeg, coordinates);
    setCurrentAltitude(altitude);

    // Calculate current horizon altitude
    const currentHorizon = horizonProfile
      ? getHorizonAltitude(horizonProfile, currentAzimuth)
      : 0;
    setCurrentHorizonAlt(currentHorizon);

    // Generate altitude data for the night
    const data = generateNightAltitudeData(raDeg, decDeg, coordinates);

    // Convert to AltitudeDataPoint format and generate horizon data
    const chartData: AltitudeDataPoint[] = [];
    const horizonChartData: HorizonDataPoint[] = [];

    for (const point of data) {
      chartData.push({
        time: point.time,
        altitude: point.altitude,
        azimuth: point.azimuth,
        isIdeal: point.isIdeal,
      });

      // Calculate horizon altitude at this azimuth
      if (horizonProfile) {
        const horizonAlt = getHorizonAltitude(horizonProfile, point.azimuth);
        horizonChartData.push({
          time: point.time,
          altitude: horizonAlt,
        });
      }
    }

    setAltitudeData(chartData);
    setHorizonData(horizonChartData);

    // Calculate ideal observation time range considering horizon
    // An object is "ideal" when above both 20° AND the local horizon
    const idealPoints = data.filter((point) => {
      const horizonAlt = horizonProfile
        ? getHorizonAltitude(horizonProfile, point.azimuth)
        : 0;
      const effectiveThreshold = Math.max(20, horizonAlt);
      return point.altitude >= effectiveThreshold;
    });

    if (idealPoints.length > 0) {
      setIdealTimeRange({
        start: idealPoints[0].time,
        end: idealPoints[idealPoints.length - 1].time,
      });
    } else {
      setIdealTimeRange({ start: null, end: null });
    }

    // Find the best observation time (highest altitude above horizon during the night)
    if (data.length > 0) {
      // Find point with maximum "clearance" above the effective threshold
      let bestPoint = data[0];
      let bestClearance = -Infinity;

      for (const point of data) {
        const horizonAlt = horizonProfile
          ? getHorizonAltitude(horizonProfile, point.azimuth)
          : 0;
        const effectiveThreshold = Math.max(20, horizonAlt);
        const clearance = point.altitude - effectiveThreshold;

        if (clearance > bestClearance) {
          bestClearance = clearance;
          bestPoint = point;
        }
      }

      setBestObservationTime(bestPoint.time);
      setMaxAltitude(bestPoint.altitude);
    } else {
      setBestObservationTime(null);
      setMaxAltitude(null);
    }
  }, [ra, dec, coordinates, horizonProfile, open]);

  const saveLocation = () => {
    try {
      const newLat = parseFloat(latitude);
      const newLng = parseFloat(longitude);

      if (isNaN(newLat) || isNaN(newLng)) {
        throw new Error("Invalid coordinates");
      }

      if (newLat < -90 || newLat > 90) {
        throw new Error("Latitude must be between -90 and 90");
      }

      if (newLng < -180 || newLng > 180) {
        throw new Error("Longitude must be between -180 and 180");
      }

      const newCoordinates = {
        latitude: newLat,
        longitude: newLng,
      };

      setCoordinates(newCoordinates);
      localStorage.setItem("observer_location", JSON.stringify(newCoordinates));
      setIsEditingLocation(false);
      toast.success("Location updated");
    } catch (e) {
      toast.error("Please enter valid coordinates");
      console.error(e);
    }
  };

  const handleSetGoalTime = (time: Date) => {
    if (onSetGoalTime) {
      const formattedTime = formatTime(time);
      onSetGoalTime(formattedTime);
      toast.success("Goal time set to " + formattedTime);
      onOpenChange(false);
    }
  };

  const getAltitudeStatus = (alt: number | null, horizonAlt: number | null) => {
    if (alt === null) return { color: "text-muted-foreground", text: "Unknown" };
    const effectiveHorizon = horizonAlt ?? 0;
    const effectiveThreshold = Math.max(20, effectiveHorizon);

    if (alt > effectiveThreshold) return { color: "text-green-400", text: "Ideal for observation" };
    if (alt > effectiveHorizon) return { color: "text-yellow-400", text: "Visible but below ideal threshold" };
    if (alt > 0) return { color: "text-orange-400", text: "Below local horizon" };
    return { color: "text-red-400", text: "Below horizon - not visible" };
  };

  const status = getAltitudeStatus(currentAltitude, currentHorizonAlt);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>{objectName} Altitude</DialogTitle>
        </DialogHeader>

        <div className="mt-4 space-y-6">
          {/* Location Section */}
          <div className="flex flex-col gap-2">
            <div className="flex justify-between items-center">
              <p className="text-sm text-muted-foreground">Current Location:</p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIsEditingLocation(!isEditingLocation)}
              >
                {isEditingLocation ? "Cancel" : "Change Location"}
              </Button>
            </div>

            {isEditingLocation ? (
              <div className="grid grid-cols-2 gap-4 mt-2">
                <div>
                  <Label htmlFor="altitude-latitude">Latitude</Label>
                  <Input
                    id="altitude-latitude"
                    value={latitude}
                    onChange={(e) => setLatitude(e.target.value)}
                    placeholder="40.7128"
                  />
                </div>
                <div>
                  <Label htmlFor="altitude-longitude">Longitude</Label>
                  <Input
                    id="altitude-longitude"
                    value={longitude}
                    onChange={(e) => setLongitude(e.target.value)}
                    placeholder="-74.0060"
                  />
                </div>
                <div className="col-span-2 flex justify-end">
                  <Button onClick={saveLocation}>Save Location</Button>
                </div>
              </div>
            ) : (
              <p className="font-medium">
                {coordinates.latitude.toFixed(4)}, {coordinates.longitude.toFixed(4)}
              </p>
            )}
          </div>

          {/* Current Altitude */}
          <div className="space-y-2">
            <h4 className="text-lg font-medium">Current Altitude</h4>
            <div className="flex items-center">
              <div className={"text-3xl font-bold " + status.color}>
                {currentAltitude !== null ? currentAltitude.toFixed(1) + "\u00B0" : "N/A"}
              </div>
              <div className="ml-3 text-sm text-muted-foreground">
                {status.text}
              </div>
            </div>
          </div>

          {/* Visibility Chart */}
          <div className="space-y-2">
            <h4 className="text-lg font-medium">Tonight's Visibility</h4>
            {altitudeData.length > 0 ? (
              <div>
                <AltitudeChart
                  data={altitudeData}
                  horizonData={horizonData.length > 0 ? horizonData : undefined}
                  width={520}
                  height={220}
                />
                <div className="mt-4 grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-sm text-muted-foreground">Best observation window:</p>
                    <p className="font-medium">
                      {idealTimeRange.start && idealTimeRange.end
                        ? formatTime(idealTimeRange.start) + " - " + formatTime(idealTimeRange.end)
                        : horizonProfile
                          ? "Not visible above horizon tonight"
                          : "Not visible above 20\u00B0 tonight"}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Maximum altitude:</p>
                    <p className="font-medium">
                      {maxAltitude !== null ? maxAltitude.toFixed(1) + "\u00B0" : "N/A"}
                    </p>
                  </div>
                </div>
                {horizonProfile && (
                  <div className="text-xs text-muted-foreground mt-2">
                    Local horizon profile active ({horizonProfile.points.length} points)
                  </div>
                )}
              </div>
            ) : (
              <p className="text-muted-foreground">
                Could not calculate visibility. Please check coordinates.
              </p>
            )}
          </div>

          {/* Recommended Goal Times */}
          {onSetGoalTime && (bestObservationTime || idealTimeRange.start || idealTimeRange.end) && (
            <div className="pt-4 border-t">
              <h4 className="text-lg font-medium mb-3">Recommended Goal Times</h4>
              <div className="flex flex-wrap gap-2">
                {bestObservationTime && (
                  <Button
                    variant="outline"
                    onClick={() => handleSetGoalTime(bestObservationTime)}
                    className="flex-1"
                  >
                    Best Time: {formatTime(bestObservationTime)}
                  </Button>
                )}

                {idealTimeRange.start && (
                  <Button
                    variant="outline"
                    onClick={() => handleSetGoalTime(idealTimeRange.start!)}
                    className="flex-1"
                  >
                    Start: {formatTime(idealTimeRange.start)}
                  </Button>
                )}

                {idealTimeRange.end && (
                  <Button
                    variant="outline"
                    onClick={() => handleSetGoalTime(idealTimeRange.end!)}
                    className="flex-1"
                  >
                    End: {formatTime(idealTimeRange.end)}
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
