/**
 * Recommendations Panel - Shows recommended observation targets
 */

import { useState, useEffect, useMemo, useCallback } from "react";
import { format } from "date-fns";
import SunCalc from "suncalc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import {
  CalendarCheck,
  Camera,
  Clock,
  Eye,
  ImageIcon,
  MapPin,
  Moon,
  Plus,
  RefreshCw,
  Sparkles,
  Target,
} from "lucide-react";
import { AltitudeChart, type AltitudeDataPoint, type HorizonDataPoint, type ScheduledBlock } from "@/components/AltitudeChart";
import { Input } from "@/components/ui/input";
import { getHorizonAltitude } from "@/lib/astronomy-utils";
import { cn } from "@/lib/utils";
import { useLocations } from "@/contexts/LocationContext";
import { useTargetObservations } from "@/hooks/use-target-observations";
import { getObjectTypeInfo } from "@/lib/objectTypeMap";
import {
  type CatalogTarget,
  type RecommendedTarget,
  type RecommendationContext,
  type RecommenderOptions,
  VisibilityRecommender,
  calculateAltAz,
} from "@/lib/recommendations";

export interface ScheduleItemInfo {
  object_name: string;
  start_time: string;
  end_time: string;
}

interface RecommendationsPanelProps {
  onTargetSelect?: (target: RecommendedTarget) => void;
  onAddToSchedule?: (target: RecommendedTarget, startTime: string, duration: number) => void;
  scheduledObjectNames?: string[];
  scheduleItems?: ScheduleItemInfo[];
  activeScheduleName?: string;
}

// Object type categories for filtering
const TYPE_CATEGORIES = [
  { id: "all", name: "All Objects" },
  { id: "cluster", name: "Clusters", types: ["Globular Cluster", "Open Cluster", "Open (galactic) Cluster"] },
  { id: "galaxy", name: "Galaxies", types: ["Galaxy", "Spiral Galaxy", "Elliptical Galaxy"] },
  { id: "nebula", name: "Nebulae", types: ["Nebula", "Planetary Nebula", "HII (ionized) region", "SuperNova Remnant", "Emission Nebula", "Reflection Nebula"] },
  { id: "star", name: "Stars", types: ["Star", "Double Star", "Variable Star"] },
  { id: "other", name: "Other", types: [] },
];

export function RecommendationsPanel({
  onTargetSelect,
  onAddToSchedule,
  scheduledObjectNames = [],
  scheduleItems = [],
  activeScheduleName,
}: RecommendationsPanelProps) {
  const { activeLocation } = useLocations();
  const [recommendations, setRecommendations] = useState<RecommendedTarget[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState("all");
  const [catalogTargets, setCatalogTargets] = useState<CatalogTarget[]>([]);
  const [catalogsLoaded, setCatalogsLoaded] = useState(false);
  const [selectedTarget, setSelectedTarget] = useState<RecommendedTarget | null>(null);
  const [isDetailOpen, setIsDetailOpen] = useState(false);

  // Get observation stats for selected target
  const observations = useTargetObservations(selectedTarget?.name || null);

  // Schedule time state (used in detail dialog)
  const [scheduleStartTime, setScheduleStartTime] = useState("");
  const [scheduleDuration, setScheduleDuration] = useState(30);

  // Load catalogs on mount
  useEffect(() => {
    const loadCatalogs = async () => {
      try {
        const catalogs = ["Messier", "OpenNGC"];
        const allTargets: CatalogTarget[] = [];

        for (const catalog of catalogs) {
          const response = await fetch(`/catalogs/${catalog}.json`);
          if (!response.ok) continue;

          const data = await response.json();
          const format = data.format as string[];

          for (const entry of data.data) {
            const target: CatalogTarget = {
              id: `${catalog}-${entry[0]}`,
              name: entry[format.indexOf("CAT")],
              ra: entry[format.indexOf("RA")],
              dec: entry[format.indexOf("DEC")],
              type: entry[format.indexOf("TYPE")] || "Unknown",
              constellation: entry[format.indexOf("CON")] || undefined,
              magnitude: entry[format.indexOf("BMAG")] || undefined,
              commonName: entry[format.indexOf("NAME")] || undefined,
              info: entry[format.indexOf("INFO")] || undefined,
              size: entry[format.indexOf("SIZE")] || undefined,
            };

            // Skip entries without valid coordinates
            if (target.ra && target.dec) {
              allTargets.push(target);
            }
          }
        }

        setCatalogTargets(allTargets);
        setCatalogsLoaded(true);
      } catch (err) {
        console.error("Failed to load catalogs:", err);
        setError("Failed to load catalog data");
      }
    };

    loadCatalogs();
  }, []);

  // Calculate moon data
  const moonData = useMemo(() => {
    if (!activeLocation) return null;

    const now = new Date();
    const moonIllum = SunCalc.getMoonIllumination(now);
    const moonPos = SunCalc.getMoonPosition(now, activeLocation.latitude, activeLocation.longitude);

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

    return {
      illumination: Math.round(moonIllum.fraction * 100),
      phase: getPhaseName(moonIllum.phase),
      altitude: (moonPos.altitude * 180) / Math.PI,
    };
  }, [activeLocation]);

  // Generate altitude data for a target over the night
  const generateAltitudeData = useCallback((target: RecommendedTarget): {
    altitudeData: AltitudeDataPoint[];
    horizonData: HorizonDataPoint[];
  } => {
    if (!activeLocation) {
      return { altitudeData: [], horizonData: [] };
    }

    const altitudeData: AltitudeDataPoint[] = [];
    const horizonData: HorizonDataPoint[] = [];

    // Start from 6 PM today (or now if after 6 PM)
    const now = new Date();
    let startTime = new Date(now);
    if (now.getHours() < 18) {
      startTime.setHours(18, 0, 0, 0);
    }

    // End at 6 AM next day
    const endTime = new Date(startTime);
    endTime.setDate(endTime.getDate() + 1);
    endTime.setHours(6, 0, 0, 0);

    // Calculate altitude every 15 minutes
    const intervalMs = 15 * 60 * 1000;
    let currentTime = new Date(startTime);

    while (currentTime <= endTime) {
      const { altitude, azimuth } = calculateAltAz(
        target.ra,
        target.dec,
        activeLocation.latitude,
        activeLocation.longitude,
        currentTime
      );

      altitudeData.push({
        time: new Date(currentTime),
        altitude,
        azimuth,
        isIdeal: altitude >= 20,
      });

      // Get horizon altitude at this azimuth
      const horizonAlt = activeLocation.horizon
        ? getHorizonAltitude(activeLocation.horizon, azimuth)
        : 0;

      horizonData.push({
        time: new Date(currentTime),
        altitude: horizonAlt,
      });

      currentTime = new Date(currentTime.getTime() + intervalMs);
    }

    return { altitudeData, horizonData };
  }, [activeLocation]);

  // Handle target click - open detail dialog
  const handleTargetClick = useCallback((target: RecommendedTarget) => {
    setSelectedTarget(target);
    setIsDetailOpen(true);
    onTargetSelect?.(target);

    // Set default schedule time
    let defaultTime: Date;
    if (target.optimalTime && target.optimalTime > new Date()) {
      defaultTime = target.optimalTime;
    } else {
      const now = new Date();
      const minutes = Math.ceil(now.getMinutes() / 15) * 15;
      defaultTime = new Date(now);
      defaultTime.setMinutes(minutes, 0, 0);
    }
    setScheduleStartTime(format(defaultTime, "yyyy-MM-dd'T'HH:mm"));
    setScheduleDuration(30);
  }, [onTargetSelect]);

  // Get altitude data for selected target
  const selectedTargetAltitudeData = useMemo(() => {
    if (!selectedTarget) return { altitudeData: [], horizonData: [] };
    return generateAltitudeData(selectedTarget);
  }, [selectedTarget, generateAltitudeData]);

  // Convert schedule items to ScheduledBlock format for chart
  const existingScheduleBlocks = useMemo((): ScheduledBlock[] => {
    return scheduleItems.map(item => ({
      name: item.object_name,
      startTime: new Date(item.start_time),
      endTime: new Date(item.end_time),
      isNew: false,
    }));
  }, [scheduleItems]);

  // Generate recommendations
  const generateRecommendations = async () => {
    if (!activeLocation || !catalogsLoaded) return;

    setIsLoading(true);
    setError(null);

    try {
      const recommender = new VisibilityRecommender();

      // Build context
      const context: RecommendationContext = {
        location: activeLocation,
        time: new Date(),
        moonIllumination: moonData?.illumination || 0,
        moonPhase: moonData?.phase || "Unknown",
        moonAltitude: moonData?.altitude || -90,
      };

      // Build options
      const options: RecommenderOptions = {
        minAltitude: 20,
        maxTargets: 50,
      };

      // Apply type filter
      if (typeFilter !== "all") {
        const category = TYPE_CATEGORIES.find(c => c.id === typeFilter);
        if (category && category.types && category.types.length > 0) {
          options.typeFilter = category.types;
        }
      }

      const results = await recommender.recommend(catalogTargets, context, options);
      setRecommendations(results);
    } catch (err) {
      console.error("Failed to generate recommendations:", err);
      setError("Failed to generate recommendations");
    } finally {
      setIsLoading(false);
    }
  };

  // Auto-generate recommendations when location or filter changes
  useEffect(() => {
    if (activeLocation && catalogsLoaded) {
      generateRecommendations();
    }
  }, [activeLocation, catalogsLoaded, typeFilter]);

  const getScoreBadgeVariant = (score: number): "default" | "secondary" | "destructive" => {
    if (score >= 70) return "default";
    if (score >= 40) return "secondary";
    return "destructive";
  };

  if (!activeLocation) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="w-5 h-5" />
            Recommended Targets
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8 text-muted-foreground">
            <MapPin className="w-12 h-12 mx-auto mb-4 opacity-50" />
            <p>No location configured. Add one in Settings to see recommendations.</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="w-5 h-5" />
            Bright Objects Visible Tonight
          </CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={generateRecommendations}
            disabled={isLoading}
          >
            <RefreshCw className={cn("w-4 h-4 mr-1", isLoading && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Location and conditions info */}
        <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
          <div className="flex items-center gap-1">
            <MapPin className="w-4 h-4" />
            <span>{activeLocation.name}</span>
          </div>
          {moonData && (
            <div className="flex items-center gap-1">
              <Moon className="w-4 h-4" />
              <span>{moonData.phase} ({moonData.illumination}%)</span>
            </div>
          )}
        </div>

        <p className="text-sm text-muted-foreground">
          Currently visible objects above 20° altitude • Click to view details
        </p>

        {/* Filter */}
        <div className="flex items-center gap-4">
          <div className="flex-1">
            <Label className="text-sm">Filter by Type</Label>
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPE_CATEGORIES.map((cat) => (
                  <SelectItem key={cat.id} value={cat.id}>
                    {cat.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Error state */}
        {error && (
          <div className="text-center py-4 text-destructive">
            <p>{error}</p>
          </div>
        )}

        {/* Loading state */}
        {isLoading && (
          <div className="text-center py-8">
            <RefreshCw className="w-8 h-8 mx-auto mb-4 animate-spin text-muted-foreground" />
            <p className="text-muted-foreground">Calculating recommendations...</p>
          </div>
        )}

        {/* Results */}
        {!isLoading && !error && recommendations.length === 0 && (
          <div className="text-center py-8 text-muted-foreground">
            <Target className="w-12 h-12 mx-auto mb-4 opacity-50" />
            <p>No visible targets found matching your criteria.</p>
          </div>
        )}

        {!isLoading && !error && recommendations.length > 0 && (
          <div className="space-y-2">
            {recommendations.map((target) => {
              const typeInfo = getObjectTypeInfo(target.type);
              const isScheduled = scheduledObjectNames.includes(target.name);

              return (
                <div
                  key={target.id}
                  className={cn(
                    "p-4 border rounded-lg hover:bg-muted/50 transition-colors cursor-pointer",
                    isScheduled && "border-green-500/50 bg-green-500/5"
                  )}
                  onClick={() => handleTargetClick(target)}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        {isScheduled && (
                          <CalendarCheck className="w-4 h-4 text-green-500 flex-shrink-0" />
                        )}
                        <h3 className="font-semibold">
                          {target.name}
                          {target.commonName && (
                            <span className="font-normal text-muted-foreground ml-1">
                              ({target.commonName})
                            </span>
                          )}
                        </h3>
                        <Badge variant="outline" className="text-xs">
                          {typeInfo.label}
                        </Badge>
                        {isScheduled && (
                          <Badge variant="default" className="text-xs bg-green-600">
                            Scheduled
                          </Badge>
                        )}
                      </div>

                      {target.description && (
                        <p className="text-sm text-muted-foreground mb-2">{target.description}</p>
                      )}

                      <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1 text-sm">
                        {target.magnitude !== undefined && target.magnitude > 0 && (
                          <div>
                            <span className="text-muted-foreground">Mag:</span>{" "}
                            <span className="font-medium">{target.magnitude.toFixed(1)}</span>
                          </div>
                        )}
                        <div>
                          <span className="text-muted-foreground">Alt:</span>{" "}
                          <span className="font-medium">{target.altitude}°</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Dir:</span>{" "}
                          <span className="font-medium">{target.direction}</span>
                        </div>
                        {target.visibilityHours !== undefined && (
                          <div>
                            <span className="text-muted-foreground">Visible:</span>{" "}
                            <span className="font-medium">{target.visibilityHours}h</span>
                          </div>
                        )}
                      </div>

                      {/* Visibility time info */}
                      {target.optimalTime && (
                        <div className="mt-1 text-xs text-muted-foreground flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          <span>Best at {format(target.optimalTime, "HH:mm")}</span>
                          {target.maxAltitude && (
                            <span>({target.maxAltitude}° max)</span>
                          )}
                        </div>
                      )}

                      {/* Recommendation reasons */}
                      {target.reasons.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {target.reasons.slice(0, 3).map((reason, i) => (
                            <Badge key={i} variant="secondary" className="text-xs">
                              {reason}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="flex flex-col items-end gap-2 ml-4">
                      <Badge variant={getScoreBadgeVariant(target.score)}>
                        Score: {target.score}
                      </Badge>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleTargetClick(target);
                        }}
                        title="View details"
                      >
                        <Eye className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Results count */}
        {!isLoading && recommendations.length > 0 && (
          <p className="text-xs text-muted-foreground text-center pt-2">
            Showing {recommendations.length} targets • Last updated: {format(new Date(), "HH:mm")}
          </p>
        )}
      </CardContent>

      {/* Target Detail Dialog */}
      <Dialog open={isDetailOpen} onOpenChange={setIsDetailOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          {selectedTarget && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  {selectedTarget.name}
                  {selectedTarget.commonName && (
                    <span className="font-normal text-muted-foreground">
                      ({selectedTarget.commonName})
                    </span>
                  )}
                </DialogTitle>
                <DialogDescription>
                  {getObjectTypeInfo(selectedTarget.type).label}
                  {selectedTarget.constellation && ` in ${selectedTarget.constellation}`}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                {/* Current Position Info */}
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="space-y-1">
                    <div className="text-muted-foreground text-xs">Altitude</div>
                    <div className="text-lg font-semibold">{selectedTarget.altitude}°</div>
                  </div>
                  <div className="space-y-1">
                    <div className="text-muted-foreground text-xs">Direction</div>
                    <div className="text-lg font-semibold">{selectedTarget.direction} ({selectedTarget.azimuth}°)</div>
                  </div>
                  {selectedTarget.magnitude !== undefined && selectedTarget.magnitude > 0 && (
                    <div className="space-y-1">
                      <div className="text-muted-foreground text-xs">Magnitude</div>
                      <div className="text-lg font-semibold">{selectedTarget.magnitude.toFixed(1)}</div>
                    </div>
                  )}
                  {selectedTarget.size !== undefined && (
                    <div className="space-y-1">
                      <div className="text-muted-foreground text-xs">Size</div>
                      <div className="text-lg font-semibold">{selectedTarget.size}'</div>
                    </div>
                  )}
                </div>

                {/* Visibility Window Info */}
                <div className="p-3 bg-muted/50 rounded-lg">
                  <div className="flex items-center gap-2 mb-2">
                    <Clock className="w-4 h-4" />
                    <span className="font-medium text-sm">Visibility Tonight</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    {selectedTarget.visibilityStart && (
                      <div>
                        <span className="text-muted-foreground text-xs">Rises: </span>
                        <span className="font-medium">{format(selectedTarget.visibilityStart, "HH:mm")}</span>
                      </div>
                    )}
                    {selectedTarget.visibilityEnd && (
                      <div>
                        <span className="text-muted-foreground text-xs">Sets: </span>
                        <span className="font-medium">{format(selectedTarget.visibilityEnd, "HH:mm")}</span>
                      </div>
                    )}
                    {selectedTarget.optimalTime && (
                      <div>
                        <span className="text-muted-foreground text-xs">Best: </span>
                        <span className="font-medium">{format(selectedTarget.optimalTime, "HH:mm")}</span>
                        {selectedTarget.maxAltitude !== undefined && (
                          <span className="text-muted-foreground"> ({selectedTarget.maxAltitude}°)</span>
                        )}
                      </div>
                    )}
                    {selectedTarget.visibilityHours !== undefined && (
                      <div>
                        <span className="text-muted-foreground text-xs">Duration: </span>
                        <span className="font-medium">{selectedTarget.visibilityHours}h</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Altitude Chart with schedule blocks */}
                <div className="border rounded-lg p-3">
                  <h4 className="text-sm font-medium mb-2">Altitude Over Time</h4>
                  <AltitudeChart
                    data={selectedTargetAltitudeData.altitudeData}
                    horizonData={selectedTargetAltitudeData.horizonData}
                    scheduledBlocks={[
                      ...existingScheduleBlocks,
                      ...(selectedTarget && scheduleStartTime && !scheduledObjectNames.includes(selectedTarget.name) ? [{
                        name: selectedTarget.name,
                        startTime: new Date(scheduleStartTime),
                        endTime: new Date(new Date(scheduleStartTime).getTime() + scheduleDuration * 60 * 1000),
                        isNew: true,
                      }] : []),
                    ]}
                    width={420}
                    height={160}
                    showCurrentTime={true}
                    idealThreshold={20}
                  />
                  <div className="flex flex-wrap gap-3 text-xs text-muted-foreground mt-2">
                    <div className="flex items-center gap-1">
                      <div className="w-3 h-3 bg-green-500/20 rounded-sm" />
                      <span>Good (20°+)</span>
                    </div>
                    {existingScheduleBlocks.length > 0 && (
                      <div className="flex items-center gap-1">
                        <div className="w-3 h-3 bg-red-500/20 border border-red-500/50 border-dashed rounded-sm" />
                        <span>Scheduled</span>
                      </div>
                    )}
                    {!scheduledObjectNames.includes(selectedTarget.name) && (
                      <div className="flex items-center gap-1">
                        <div className="w-3 h-3 bg-indigo-500/20 border border-indigo-500/50 border-dashed rounded-sm" />
                        <span>New</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Schedule Time Selection - only show if not already scheduled */}
                {onAddToSchedule && !scheduledObjectNames.includes(selectedTarget.name) && (
                  <div className="space-y-3 p-3 bg-muted/30 rounded-lg">
                    {activeScheduleName && (
                      <div className="text-sm">
                        <span className="text-muted-foreground">Adding to: </span>
                        <span className="font-medium text-blue-500">{activeScheduleName}</span>
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label htmlFor="detail-start-time" className="text-xs">Start Time</Label>
                        <Input
                          id="detail-start-time"
                          type="datetime-local"
                          value={scheduleStartTime}
                          onChange={(e) => setScheduleStartTime(e.target.value)}
                          className="h-8 text-sm"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="detail-duration" className="text-xs">Duration (min)</Label>
                        <Input
                          id="detail-duration"
                          type="number"
                          min={5}
                          max={240}
                          step={5}
                          value={scheduleDuration}
                          onChange={(e) => setScheduleDuration(parseInt(e.target.value) || 30)}
                          className="h-8 text-sm"
                        />
                      </div>
                    </div>
                  </div>
                )}

                {/* Current Schedule Overview */}
                {scheduleItems.length > 0 && (
                  <div className="space-y-1">
                    <h4 className="text-xs font-medium text-muted-foreground">Current Schedule</h4>
                    <div className="border rounded-lg divide-y max-h-24 overflow-y-auto">
                      {scheduleItems.map((item, i) => (
                        <div key={i} className="flex items-center justify-between px-2 py-1.5 text-xs">
                          <span className="truncate">{item.object_name}</span>
                          <span className="text-muted-foreground flex-shrink-0 ml-2">
                            {format(new Date(item.start_time), "HH:mm")} - {format(new Date(item.end_time), "HH:mm")}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Coordinates */}
                <div className="text-xs text-muted-foreground">
                  <span>RA: {selectedTarget.ra.toFixed(4)}h</span>
                  <span className="mx-2">|</span>
                  <span>Dec: {selectedTarget.dec.toFixed(4)}°</span>
                </div>

                {/* Previous Observations */}
                {observations && observations.totalImages > 0 && (
                  <div className="pt-3 border-t mt-3">
                    <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
                      <ImageIcon className="w-4 h-4" />
                      Previous Observations
                    </h4>
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">
                        {observations.totalImages} image{observations.totalImages !== 1 ? "s" : ""} of this target
                      </p>
                      {observations.groups.map((group, idx) => (
                        <div key={idx} className="flex items-center justify-between text-xs py-1 px-2 bg-muted/30 rounded">
                          <div className="flex items-center gap-2">
                            <Camera className="w-3 h-3 text-muted-foreground" />
                            <span>{group.camera}</span>
                            {group.focalLength && (
                              <Badge variant="outline" className="text-xs h-4">
                                {group.focalLength}mm
                              </Badge>
                            )}
                          </div>
                          <span className="text-muted-foreground">
                            {group.imageCount} image{group.imageCount !== 1 ? "s" : ""}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <DialogFooter>
                {onAddToSchedule && (
                  scheduledObjectNames.includes(selectedTarget.name) ? (
                    <Button variant="outline" disabled className="text-green-600">
                      <CalendarCheck className="w-4 h-4 mr-2" />
                      Already Scheduled
                    </Button>
                  ) : (
                    <Button onClick={() => {
                      if (selectedTarget && scheduleStartTime) {
                        onAddToSchedule(selectedTarget, scheduleStartTime, scheduleDuration);
                        setIsDetailOpen(false);
                      }
                    }}>
                      <Plus className="w-4 h-4 mr-2" />
                      Add to Schedule
                    </Button>
                  )
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
