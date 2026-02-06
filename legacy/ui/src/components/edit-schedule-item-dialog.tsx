import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { parseCoordinates, calculateAltitudeAtTime, calculateCurrentAzimuth, azimuthToCompassDirection, generateNightAltitudeData, formatTime as formatAstroTime } from "@/lib/astronomy-utils"

interface PlanningItem {
  id: string;
  objectName: string;
  startTime: string;
  duration: number; // in minutes
  ra: string;
  dec: string;
  magnitude: string;
  objectType?: string;
}

interface ObservationSchedule {
  id: string;
  user_id: string;
  name: string;
  description?: string;
  scheduled_date?: string;
  location?: string;
  items: PlanningItem[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface EditScheduleItemDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: PlanningItem | null;
  onSave: (updatedItem: PlanningItem) => void;
  activeSchedule: ObservationSchedule | null;
  userLocation: {latitude: number; longitude: number; city?: string} | null;
}

export function EditScheduleItemDialog({
  open,
  onOpenChange,
  item,
  onSave,
  activeSchedule,
  userLocation,
}: EditScheduleItemDialogProps) {
  const [objectName, setObjectName] = useState("");
  const [startTime, setStartTime] = useState("");
  const [duration, setDuration] = useState(30);

  // Update form fields when item changes
  useEffect(() => {
    if (item) {
      setObjectName(item.objectName);
      setStartTime(item.startTime);
      setDuration(item.duration);
    }
  }, [item]);

  const handleSave = () => {
    if (!item || !objectName.trim() || !startTime) return;

    const updatedItem: PlanningItem = {
      ...item,
      objectName: objectName.trim(),
      startTime,
      duration,
    };

    onSave(updatedItem);
    onOpenChange(false);
  };

  const handleCancel = () => {
    // Reset form to original values
    if (item) {
      setObjectName(item.objectName);
      setStartTime(item.startTime);
      setDuration(item.duration);
    }
    onOpenChange(false);
  };

  // Get schedule conflicts for time visualization
  const getScheduleConflicts = (checkStartTime: string, checkDuration: number) => {
    if (!activeSchedule || !checkStartTime || !item) return [];
    
    const conflicts: PlanningItem[] = [];
    const calculateEndTime = (st: string, dur: number) => {
      if (!st) return '';
      const [hours, minutes] = st.split(':').map(Number);
      const endMinutes = minutes + dur;
      const endHours = hours + Math.floor(endMinutes / 60);
      const finalMinutes = endMinutes % 60;
      return `${(endHours % 24).toString().padStart(2, '0')}:${finalMinutes.toString().padStart(2, '0')}`;
    };
    
    const newEndTime = calculateEndTime(checkStartTime, checkDuration);
    
    activeSchedule.items.forEach(scheduleItem => {
      // Skip the item being edited
      if (scheduleItem.id === item.id) return;
      
      const itemEndTime = calculateEndTime(scheduleItem.startTime, scheduleItem.duration);
      
      // Check for time overlap
      if (
        (checkStartTime >= scheduleItem.startTime && checkStartTime < itemEndTime) ||
        (newEndTime > scheduleItem.startTime && newEndTime <= itemEndTime) ||
        (checkStartTime <= scheduleItem.startTime && newEndTime >= itemEndTime)
      ) {
        conflicts.push(scheduleItem);
      }
    });
    
    return conflicts;
  };

  // Generate altitude data for the item being edited
  const getItemAltitudeData = () => {
    if (!item || !userLocation) return [];
    
    const coords = parseCoordinates(item.ra, item.dec);
    if (!coords) return [];
    
    return generateNightAltitudeData(coords.raDeg, coords.decDeg, userLocation);
  };

  // Calculate current altitude and direction
  const getCurrentAltitudeInfo = () => {
    if (!item || !userLocation) return null;
    
    const coords = parseCoordinates(item.ra, item.dec);
    if (!coords) return null;
    
    const now = new Date();
    const altitude = calculateAltitudeAtTime(coords.raDeg, coords.decDeg, userLocation, now);
    const azimuth = calculateCurrentAzimuth(coords.raDeg, coords.decDeg, userLocation);
    const direction = azimuthToCompassDirection(azimuth);
    
    return {
      altitude: Math.round(altitude),
      azimuth: Math.round(azimuth),
      direction
    };
  };

  const formatTime = (timeString: string) => {
    if (!timeString) return '';
    const [hours, minutes] = timeString.split(':');
    return `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}`;
  };

  const calculateEndTime = (startTimeStr: string, durationMin: number) => {
    if (!startTimeStr) return '';
    const [hours, minutes] = startTimeStr.split(':').map(Number);
    const endMinutes = minutes + durationMin;
    const endHours = hours + Math.floor(endMinutes / 60);
    const finalMinutes = endMinutes % 60;
    return `${(endHours % 24).toString().padStart(2, '0')}:${finalMinutes.toString().padStart(2, '0')}`;
  };

  if (!item) return null;

  const currentAltitudeInfo = getCurrentAltitudeInfo();
  const conflicts = getScheduleConflicts(startTime, duration);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Schedule Item</DialogTitle>
        </DialogHeader>
        
        <div className="space-y-6">
          {/* Object Details */}
          <div className="p-3 border rounded-lg bg-muted/50">
            <div className="flex items-center gap-2 mb-2">
              <h3 className="font-semibold text-lg">{item.objectName}</h3>
              {item.objectType && (
                <span className="text-xs px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded-full">
                  {item.objectType}
                </span>
              )}
            </div>
            
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-muted-foreground">RA: </span>
                <span className="font-medium">{item.ra}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Dec: </span>
                <span className="font-medium">{item.dec}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Magnitude: </span>
                <span className="font-medium">{item.magnitude}</span>
              </div>
              {currentAltitudeInfo && (
                <>
                  <div>
                    <span className="text-muted-foreground">Current Altitude: </span>
                    <span className="font-medium">{currentAltitudeInfo.altitude}°</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Direction: </span>
                    <span className="font-medium">{currentAltitudeInfo.direction}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Azimuth: </span>
                    <span className="font-medium">{currentAltitudeInfo.azimuth}°</span>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Altitude Chart */}
          <div className="space-y-2">
            <h4 className="font-medium">Tonight&apos;s Altitude Profile</h4>
            <div className="p-4 border rounded-lg bg-white dark:bg-gray-900">
              {(() => {
                const altitudeData = getItemAltitudeData();
                if (altitudeData.length === 0) {
                  return (
                    <div className="text-center py-8 text-muted-foreground">
                      <p>Unable to generate altitude chart</p>
                      <p className="text-sm">Check object coordinates or location</p>
                    </div>
                  );
                }

                const chartHeight = 200;
                const chartWidth = 600;
                const padding = 40;

                return (
                  <div className="relative">
                    <svg width={chartWidth} height={chartHeight + padding * 2} className="w-full">
                      {/* Grid lines */}
                      {[0, 20, 40, 60, 80].map(alt => (
                        <g key={alt}>
                          <line
                            x1={padding}
                            y1={padding + chartHeight - (alt / 90) * chartHeight}
                            x2={chartWidth - padding}
                            y2={padding + chartHeight - (alt / 90) * chartHeight}
                            stroke="#e5e7eb"
                            strokeWidth="1"
                            strokeDasharray="2,2"
                          />
                          <text
                            x={padding - 5}
                            y={padding + chartHeight - (alt / 90) * chartHeight + 4}
                            fontSize="12"
                            fill="#6b7280"
                            textAnchor="end"
                          >
                            {alt}°
                          </text>
                        </g>
                      ))}

                      {/* Time labels */}
                      {altitudeData.filter((_, i) => i % 6 === 0).map((point, i) => (
                        <text
                          key={i}
                          x={padding + (i * 6 / (altitudeData.length - 1)) * (chartWidth - 2 * padding)}
                          y={chartHeight + padding + 20}
                          fontSize="12"
                          fill="#6b7280"
                          textAnchor="middle"
                        >
                          {formatAstroTime(point.time)}
                        </text>
                      ))}

                      {/* Altitude curve */}
                      <path
                        d={`M ${altitudeData.map((point, i) => 
                          `${padding + (i / (altitudeData.length - 1)) * (chartWidth - 2 * padding)},${
                            padding + chartHeight - (Math.max(0, point.altitude) / 90) * chartHeight
                          }`
                        ).join(' L ')}`}
                        fill="none"
                        stroke="#3b82f6"
                        strokeWidth="2"
                      />

                      {/* Horizon line */}
                      <line
                        x1={padding}
                        y1={padding + chartHeight}
                        x2={chartWidth - padding}
                        y2={padding + chartHeight}
                        stroke="#ef4444"
                        strokeWidth="2"
                      />

                      {/* Ideal observation zone (above 20°) */}
                      <rect
                        x={padding}
                        y={padding + chartHeight - (20 / 90) * chartHeight}
                        width={chartWidth - 2 * padding}
                        height={(20 / 90) * chartHeight}
                        fill="rgba(34, 197, 94, 0.1)"
                      />

                      {/* Other schedule items */}
                      {activeSchedule?.items.map((scheduleItem, i) => {
                        // Skip the item being edited
                        if (scheduleItem.id === item.id) return null;
                        
                        const startMinutes = parseInt(scheduleItem.startTime.split(':')[0]) * 60 + parseInt(scheduleItem.startTime.split(':')[1]);
                        
                        // Convert to chart position (assuming 18:00 to 06:00 time range)
                        const startPos = ((startMinutes - 18 * 60) / (12 * 60)) * (chartWidth - 2 * padding);
                        const width = (scheduleItem.duration / (12 * 60)) * (chartWidth - 2 * padding);
                        
                        if (startPos >= 0 && startPos <= chartWidth - 2 * padding) {
                          return (
                            <g key={i}>
                              <rect
                                x={padding + startPos}
                                y={padding}
                                width={Math.min(width, chartWidth - 2 * padding - startPos)}
                                height={chartHeight}
                                fill="rgba(239, 68, 68, 0.2)"
                                stroke="#ef4444"
                                strokeWidth="1"
                                strokeDasharray="3,3"
                              />
                              <text
                                x={padding + startPos + 5}
                                y={padding + 15}
                                fontSize="10"
                                fill="#dc2626"
                                fontWeight="bold"
                              >
                                {scheduleItem.objectName}
                              </text>
                            </g>
                          );
                        }
                        return null;
                      })}

                      {/* Current edited time */}
                      {startTime && (() => {
                        const [hours, minutes] = startTime.split(':').map(Number);
                        const totalMinutes = hours * 60 + minutes;
                        const pos = ((totalMinutes - 18 * 60) / (12 * 60)) * (chartWidth - 2 * padding);
                        const width = (duration / (12 * 60)) * (chartWidth - 2 * padding);
                        
                        if (pos >= 0 && pos <= chartWidth - 2 * padding) {
                          return (
                            <g>
                              <rect
                                x={padding + pos}
                                y={padding}
                                width={Math.min(width, chartWidth - 2 * padding - pos)}
                                height={chartHeight}
                                fill="rgba(59, 130, 246, 0.3)"
                                stroke="#3b82f6"
                                strokeWidth="2"
                              />
                              <text
                                x={padding + pos + 5}
                                y={padding + 30}
                                fontSize="10"
                                fill="#1d4ed8"
                                fontWeight="bold"
                              >
                                Edited: {objectName}
                              </text>
                            </g>
                          );
                        }
                        return null;
                      })()}
                    </svg>
                    
                    {/* Legend */}
                    <div className="flex flex-wrap gap-4 mt-2 text-xs">
                      <div className="flex items-center gap-1">
                        <div className="w-3 h-3 bg-blue-500 rounded"></div>
                        <span>Altitude curve</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <div className="w-3 h-3 bg-green-500/20 border border-green-500 rounded"></div>
                        <span>Good observing (20°+)</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <div className="w-3 h-3 bg-red-500 rounded"></div>
                        <span>Horizon (0°)</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <div className="w-3 h-3 bg-red-500/20 border border-red-500 border-dashed rounded"></div>
                        <span>Other schedule items</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <div className="w-3 h-3 bg-blue-500/30 border border-blue-500 rounded"></div>
                        <span>Edited observation</span>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>

          {/* Edit Form */}
          <div className="space-y-4">
            <div>
              <Label htmlFor="objectName">Object Name</Label>
              <Input
                id="objectName"
                value={objectName}
                onChange={(e) => setObjectName(e.target.value)}
                placeholder="Object name"
                className="mt-1"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="startTime">Start Time</Label>
                <Input
                  id="startTime"
                  type="time"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="duration">Duration (minutes)</Label>
                <Input
                  id="duration"
                  type="number"
                  min="5"
                  max="300"
                  value={duration}
                  onChange={(e) => setDuration(parseInt(e.target.value) || 30)}
                  className="mt-1"
                />
              </div>
            </div>
          </div>

          {/* Schedule Conflicts */}
          {startTime && conflicts.length > 0 && (
            <div className="p-3 border rounded-lg bg-red-50 dark:bg-red-900/20">
              <h4 className="font-medium text-red-800 dark:text-red-200 mb-2">
                Schedule Conflicts Detected
              </h4>
              <div className="space-y-1">
                {conflicts.map((conflict) => (
                  <div key={conflict.id} className="text-sm text-red-700 dark:text-red-300">
                    <span className="font-medium">{conflict.objectName}</span>
                    <span className="ml-2">
                      {formatTime(conflict.startTime)} - {calculateEndTime(conflict.startTime, conflict.duration)}
                    </span>
                    <span className="ml-2">({conflict.duration} min)</span>
                  </div>
                ))}
              </div>
              <p className="text-xs text-red-600 dark:text-red-400 mt-2">
                Consider adjusting the start time to avoid conflicts.
              </p>
            </div>
          )}

          {/* Current Schedule Overview */}
          {activeSchedule && activeSchedule.items.length > 1 && (
            <div className="space-y-2">
              <h4 className="font-medium">Current Schedule Overview</h4>
              <div className="p-3 border rounded-lg bg-muted/50 max-h-32 overflow-y-auto">
                <div className="space-y-1">
                  {activeSchedule.items
                    .sort((a, b) => a.startTime.localeCompare(b.startTime))
                    .map((scheduleItem) => (
                      <div key={scheduleItem.id} className={`text-sm flex justify-between items-center ${
                        scheduleItem.id === item.id ? 'font-bold text-blue-600' : ''
                      }`}>
                        <span className="font-medium">
                          {scheduleItem.id === item.id ? `${objectName} (editing)` : scheduleItem.objectName}
                        </span>
                        <span className="text-muted-foreground">
                          {scheduleItem.id === item.id 
                            ? `${formatTime(startTime)} - ${calculateEndTime(startTime, duration)}`
                            : `${formatTime(scheduleItem.startTime)} - ${calculateEndTime(scheduleItem.startTime, scheduleItem.duration)}`
                          }
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleCancel}>
            Cancel
          </Button>
          <Button 
            onClick={handleSave}
            disabled={!objectName.trim() || !startTime}
          >
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}