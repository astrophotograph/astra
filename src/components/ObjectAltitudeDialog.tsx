/**
 * Object Altitude Dialog
 * Shows detailed altitude/visibility information for an astronomical object
 */

import { useEffect, useState, useMemo } from "react";
import { format } from "date-fns";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CalendarCheck, Camera, Clock, ImageIcon, Plus, Timer } from "lucide-react";
import { AltitudeChart, AltitudeDataPoint, HorizonDataPoint, ScheduledBlock } from "@/components/AltitudeChart";
import {
  parseCoordinates,
  calculateCurrentAltitude,
  calculateCurrentAzimuth,
  generateNightAltitudeData,
  formatTime,
  defaultCoordinates,
  getHorizonAltitude,
  type HorizonProfile,
} from "@/lib/astronomy-utils";
import { useLocations } from "@/contexts/LocationContext";
import { useTargetObservations } from "@/hooks/use-target-observations";

interface ScheduleItemInfo {
  object_name: string;
  start_time: string;
  end_time: string;
}

// Format seconds into human-readable duration (e.g., "2h 30m" or "45m 30s")
function formatDuration(totalSeconds: number): string {
  if (totalSeconds === 0) return "0s";

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.round(totalSeconds % 60);

  if (hours > 0) {
    if (minutes > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${hours}h`;
  }
  if (minutes > 0) {
    if (seconds > 0 && minutes < 10) {
      return `${minutes}m ${seconds}s`;
    }
    return `${minutes}m`;
  }
  return `${seconds}s`;
}

interface ObjectAltitudeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  objectName: string;
  ra: string;
  dec: string;
  onSetGoalTime?: (time: string) => void;
  // Schedule props
  onAddToSchedule?: (startTime: string, duration: number) => void;
  isScheduled?: boolean;
  activeScheduleName?: string;
  scheduleItems?: ScheduleItemInfo[];
}

export function ObjectAltitudeDialog({
  open,
  onOpenChange,
  objectName,
  ra,
  dec,
  onSetGoalTime,
  onAddToSchedule,
  isScheduled,
  activeScheduleName,
  scheduleItems = [],
}: ObjectAltitudeDialogProps) {
  const { activeLocation } = useLocations();
  const observations = useTargetObservations(objectName);
  const [altitudeData, setAltitudeData] = useState<AltitudeDataPoint[]>([]);
  const [horizonData, setHorizonData] = useState<HorizonDataPoint[]>([]);
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
  const [scheduleStartTime, setScheduleStartTime] = useState("");
  const [scheduleDuration, setScheduleDuration] = useState(60);

  // Get horizon profile from active location
  const horizonProfile: HorizonProfile | null = activeLocation?.horizon || null;

  // Load coordinates from active location when dialog opens
  useEffect(() => {
    if (!open) return;

    if (activeLocation) {
      setCoordinates({
        latitude: activeLocation.latitude,
        longitude: activeLocation.longitude,
      });
      setLatitude(activeLocation.latitude.toString());
      setLongitude(activeLocation.longitude.toString());
    }
  }, [open, activeLocation]);

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

  // Convert schedule items to blocks for chart display
  const scheduledBlocks: ScheduledBlock[] = useMemo(() => {
    return scheduleItems.map((item) => ({
      name: item.object_name,
      startTime: new Date(item.start_time),
      endTime: new Date(item.end_time),
      isNew: item.object_name.toLowerCase() === objectName.toLowerCase(),
    }));
  }, [scheduleItems, objectName]);

  // Handle adding to schedule
  const handleAddToSchedule = () => {
    if (onAddToSchedule && scheduleStartTime) {
      onAddToSchedule(scheduleStartTime, scheduleDuration);
      setScheduleStartTime("");
      setScheduleDuration(60);
    }
  };

  // Set default schedule time when best observation time is calculated
  useEffect(() => {
    if (bestObservationTime && !scheduleStartTime) {
      setScheduleStartTime(format(bestObservationTime, "HH:mm"));
    }
  }, [bestObservationTime, scheduleStartTime]);

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
                  scheduledBlocks={scheduledBlocks.length > 0 ? scheduledBlocks : undefined}
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

          {/* Schedule Section */}
          {onAddToSchedule && (
            <div className="pt-4 border-t">
              <h4 className="text-lg font-medium mb-3 flex items-center gap-2">
                <CalendarCheck className="w-5 h-5" />
                Add to Schedule
                {activeScheduleName && (
                  <Badge variant="outline" className="ml-2">
                    {activeScheduleName}
                  </Badge>
                )}
              </h4>
              {isScheduled ? (
                <div className="flex items-center gap-2 text-green-400">
                  <CalendarCheck className="w-4 h-4" />
                  <span>Already scheduled</span>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label htmlFor="schedule-start" className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        Start Time
                      </Label>
                      <Input
                        id="schedule-start"
                        type="time"
                        value={scheduleStartTime}
                        onChange={(e) => setScheduleStartTime(e.target.value)}
                        className="mt-1"
                      />
                    </div>
                    <div>
                      <Label htmlFor="schedule-duration">Duration (min)</Label>
                      <Input
                        id="schedule-duration"
                        type="number"
                        min={5}
                        max={480}
                        step={5}
                        value={scheduleDuration}
                        onChange={(e) => setScheduleDuration(parseInt(e.target.value) || 60)}
                        className="mt-1"
                      />
                    </div>
                  </div>
                  <Button
                    onClick={handleAddToSchedule}
                    disabled={!scheduleStartTime}
                    className="w-full"
                  >
                    <Plus className="w-4 h-4 mr-2" />
                    Add to Schedule
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* Previous Observations */}
          {observations && observations.totalImages > 0 && (
            <div className="pt-4 border-t">
              <h4 className="text-lg font-medium mb-3 flex items-center gap-2">
                <ImageIcon className="w-5 h-5" />
                Previous Observations
              </h4>
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">
                    {observations.totalImages} image{observations.totalImages !== 1 ? "s" : ""} of this target
                  </span>
                  {observations.totalExposureSeconds > 0 && (
                    <div className="flex items-center gap-1 text-green-400">
                      <Timer className="w-4 h-4" />
                      <span className="font-medium">{formatDuration(observations.totalExposureSeconds)}</span>
                      <span className="text-muted-foreground">total</span>
                    </div>
                  )}
                </div>
                {observations.groups.length > 0 && (
                  <div className="space-y-1">
                    {observations.groups.map((group, idx) => (
                      <div key={idx} className="flex items-center justify-between text-sm py-1.5 px-2 bg-muted/30 rounded">
                        <div className="flex items-center gap-2">
                          <Camera className="w-4 h-4 text-muted-foreground" />
                          <span>{group.camera}</span>
                          {group.focalLength && (
                            <Badge variant="outline" className="text-xs">
                              {group.focalLength}mm
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-muted-foreground">
                            {group.imageCount} image{group.imageCount !== 1 ? "s" : ""}
                          </span>
                          {group.totalExposureSeconds > 0 && (
                            <span className="text-green-400 font-medium">
                              {formatDuration(group.totalExposureSeconds)}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
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
