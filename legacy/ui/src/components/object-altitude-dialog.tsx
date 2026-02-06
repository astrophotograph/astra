"use client";

import {useEffect, useState} from "react"
import {Button} from "@/components/ui/button"
import {Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle} from "@/components/ui/dialog"
import {AltitudeChart} from "@/components/altitude-chart"
import {
  AltitudePoint,
  calculateCurrentAltitude,
  defaultCoordinates,
  formatTime,
  generateNightAltitudeData,
  getIdealObservationTimeRange,
  parseCoordinates,
} from "@/lib/astronomy-utils"
import {Label} from "@/components/ui/label"
import {Input} from "@/components/ui/input"
import {toast} from "sonner"

// Safe localStorage helpers for SSR
const safeGetItem = (key: string): string | null => {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const safeSetItem = (key: string, value: string): void => {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore storage errors
  }
};

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
  const [altitudeData, setAltitudeData] = useState<AltitudePoint[]>([]);
  const [currentAltitude, setCurrentAltitude] = useState<number | null>(null);
  const [idealTimeRange, setIdealTimeRange] = useState<{ start: Date | null; end: Date | null }>({
    start: null,
    end: null,
  });
  const [coordinates, setCoordinates] = useState(defaultCoordinates);
  const [isEditingLocation, setIsEditingLocation] = useState(false);
  const [latitude, setLatitude] = useState(defaultCoordinates.latitude.toString());
  const [longitude, setLongitude] = useState(defaultCoordinates.longitude.toString());
  const [bestObservationTime, setBestObservationTime] = useState<Date | null>(null);

  useEffect(() => {
    if (!open) return;
    if (typeof window === 'undefined') return;

    // Try to load coordinates from localStorage
    const savedCoordinates = safeGetItem("userAstronomyCoordinates");
    if (savedCoordinates) {
      const parsedCoordinates = JSON.parse(savedCoordinates);
      setCoordinates(parsedCoordinates);
      setLatitude(parsedCoordinates.latitude.toString());
      setLongitude(parsedCoordinates.longitude.toString());
    } else {
      // Try to get the user's location
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (position) => {
            const newCoordinates = {
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
            };
            setCoordinates(newCoordinates);
            setLatitude(newCoordinates.latitude.toString());
            setLongitude(newCoordinates.longitude.toString());
            safeSetItem("userAstronomyCoordinates", JSON.stringify(newCoordinates));
          },
          (error) => {
            console.error("Error getting location:", error);
          }
        );
      }
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const parsedCoords = parseCoordinates(ra, dec);
    if (!parsedCoords) return;

    const { raDeg, decDeg } = parsedCoords;

    // Calculate current altitude
    const altitude = calculateCurrentAltitude(raDeg, decDeg, coordinates);
    setCurrentAltitude(altitude);

    // Generate altitude data for the night
    const data = generateNightAltitudeData(raDeg, decDeg, coordinates);
    setAltitudeData(data);

    // Calculate ideal observation time range
    const timeRange = getIdealObservationTimeRange(data);
    setIdealTimeRange(timeRange);

    // Find the best observation time (highest altitude during the night)
    if (data.length > 0) {
      const maxAltitudePoint = data.reduce((max, point) =>
        point.altitude > max.altitude ? point : max, data[0]
      );
      setBestObservationTime(maxAltitudePoint.time);
    } else {
      setBestObservationTime(null);
    }
  }, [ra, dec, coordinates, open]);

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
      safeSetItem("userAstronomyCoordinates", JSON.stringify(newCoordinates));
      setIsEditingLocation(false);
    } catch (e: unknown) {
      alert("Please enter valid coordinates");
      console.error(e);
    }
  };

  const handleSetGoalTime = (time: Date) => {
    if (onSetGoalTime) {
      const formattedTime = `${time.getHours().toString().padStart(2, '0')}:${time.getMinutes().toString().padStart(2, '0')}`;
      onSetGoalTime(formattedTime);
      toast.success(`Goal time set to ${formattedTime}`);
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>{objectName} Altitude</DialogTitle>
        </DialogHeader>

        <div className="mt-4 space-y-6">
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
                  <Label htmlFor="latitude">Latitude</Label>
                  <Input
                    id="latitude"
                    value={latitude}
                    onChange={(e) => setLatitude(e.target.value)}
                    placeholder="40.7128"
                  />
                </div>
                <div>
                  <Label htmlFor="longitude">Longitude</Label>
                  <Input
                    id="longitude"
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

          <div className="space-y-2">
            <h4 className="text-lg font-medium">Current Altitude</h4>
            <div className="flex items-center">
              <div
                className={`text-3xl font-bold ${
                  currentAltitude !== null && currentAltitude > 20 
                    ? "text-green-400" 
                    : currentAltitude !== null && currentAltitude > 0 
                      ? "text-yellow-400" 
                      : "text-red-400"
                }`}
              >
                {currentAltitude !== null ? currentAltitude.toFixed(1) : "N/A"}°
              </div>
              <div className="ml-3 text-sm text-muted-foreground">
                {currentAltitude !== null && currentAltitude > 20
                  ? "Ideal for observation"
                  : currentAltitude !== null && currentAltitude > 0
                    ? "Visible but low on horizon"
                    : "Below horizon - not visible"}
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <h4 className="text-lg font-medium">Tonight&#39;s Visibility</h4>
            {altitudeData.length > 0 ? (
              <div>
                <AltitudeChart data={altitudeData} width={500} height={250} />
                <div className="mt-4 grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-sm text-muted-foreground">Best observation window:</p>
                    <p className="font-medium">
                      {idealTimeRange.start && idealTimeRange.end
                        ? `${formatTime(idealTimeRange.start)} - ${formatTime(idealTimeRange.end)}`
                        : "Not visible above 20° tonight"}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Maximum altitude:</p>
                    <p className="font-medium">
                      {Math.max(...altitudeData.map(p => p.altitude)).toFixed(1)}°
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <p>Could not calculate visibility. Please check coordinates.</p>
            )}
          </div>

          {onSetGoalTime && (
            <div className="pt-4 border-t">
              <h4 className="text-lg font-medium mb-3">Recommended Goal Times</h4>
              <div className="flex flex-wrap gap-2">
                {bestObservationTime && (
                  <Button
                    variant="outline"
                    onClick={() => handleSetGoalTime(bestObservationTime)}
                    className="flex-grow"
                  >
                    Best Time: {formatTime(bestObservationTime)}
                  </Button>
                )}

                {idealTimeRange.start && (
                  <Button
                    variant="outline"
                    onClick={() => handleSetGoalTime(idealTimeRange.start!)}
                    className="flex-grow"
                  >
                    Start: {formatTime(idealTimeRange.start)}
                  </Button>
                )}

                {idealTimeRange.end && (
                  <Button
                    variant="outline"
                    onClick={() => handleSetGoalTime(idealTimeRange.end!)}
                    className="flex-grow"
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
