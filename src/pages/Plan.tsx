/**
 * Plan Page - Astronomy observation planning
 */

import { useState, useMemo } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Calendar,
  Clock,
  Map,
  Plus,
  Search,
  Sparkles,
  Telescope,
  Trash2,
} from "lucide-react";
import { AladinLite, type TargetInfo } from "@/components/AladinLite";
import { SkyMapSidePanel } from "@/components/SkyMapSidePanel";
import { RecommendationsPanel } from "@/components/RecommendationsPanel";
import type { RecommendedTarget } from "@/lib/recommendations";
import {
  useSchedules,
  useActiveSchedule,
  useCreateSchedule,
  useUpdateSchedule,
  useAddScheduleItem,
  useRemoveScheduleItem,
} from "@/hooks/use-schedules";
import {
  astronomyApi,
  parseScheduleItems,
  type SimbadObject,
  type ScheduleItem,
} from "@/lib/tauri/commands";
import { getObjectTypeInfo } from "@/lib/objectTypeMap";

export default function PlanPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResult, setSearchResult] = useState<SimbadObject | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [newScheduleDialogOpen, setNewScheduleDialogOpen] = useState(false);
  const [newScheduleName, setNewScheduleName] = useState("");
  const [newScheduleDescription, setNewScheduleDescription] = useState("");
  const [addItemDialogOpen, setAddItemDialogOpen] = useState(false);
  const [newItemStartTime, setNewItemStartTime] = useState("");
  const [newItemDuration, setNewItemDuration] = useState(30);
  const [activeTab, setActiveTab] = useState("lookup");

  // Pending target to add after schedule creation
  const [pendingTargetForSchedule, setPendingTargetForSchedule] = useState<RecommendedTarget | null>(null);

  // Sky map target/FOV state for altitude chart
  const [skyMapTarget, setSkyMapTarget] = useState<TargetInfo | null>(null);
  const [skyMapFov, setSkyMapFov] = useState<{ enabled: boolean; ra?: number; dec?: number }>({ enabled: false });

  // Queries and mutations
  const { data: schedules = [] } = useSchedules();
  const { data: activeSchedule } = useActiveSchedule();
  const createSchedule = useCreateSchedule();
  const updateSchedule = useUpdateSchedule();
  const addScheduleItem = useAddScheduleItem();
  const removeScheduleItem = useRemoveScheduleItem();

  // Parse schedule items
  const scheduleItems = activeSchedule ? parseScheduleItems(activeSchedule) : [];

  // Get list of scheduled object names for recommendations
  const scheduledObjectNames = useMemo(() =>
    scheduleItems.map(item => item.object_name),
    [scheduleItems]
  );

  // Search for astronomical object
  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;

    setIsSearching(true);
    try {
      const result = await astronomyApi.lookupObject(searchQuery);
      if (result) {
        setSearchResult(result);
        toast.success(`Found: ${result.name}`);
      } else {
        setSearchResult(null);
        toast.error("Object not found in SIMBAD");
      }
    } catch (err) {
      toast.error("Failed to search SIMBAD");
      console.error(err);
    } finally {
      setIsSearching(false);
    }
  };

  // Create new schedule
  const handleCreateSchedule = async () => {
    if (!newScheduleName.trim()) {
      toast.error("Please enter a schedule name");
      return;
    }

    try {
      const newSchedule = await createSchedule.mutateAsync({
        name: newScheduleName,
        description: newScheduleDescription || undefined,
        is_active: true,
      });
      toast.success(`Created schedule: ${newScheduleName}`);
      setNewScheduleDialogOpen(false);
      setNewScheduleName("");
      setNewScheduleDescription("");

      // If there's a pending target, add it to the new schedule
      if (pendingTargetForSchedule && newSchedule) {
        const now = new Date();
        const startTime = now.toISOString().slice(0, 16);
        const endTime = new Date(now.getTime() + 30 * 60 * 1000).toISOString().slice(0, 16);

        const newItem: ScheduleItem = {
          id: crypto.randomUUID(),
          todo_id: "",
          object_name: pendingTargetForSchedule.name,
          start_time: startTime,
          end_time: endTime,
          priority: 1,
          notes: `${pendingTargetForSchedule.type}${pendingTargetForSchedule.magnitude ? ` - Mag: ${pendingTargetForSchedule.magnitude.toFixed(1)}` : ""}`,
          completed: false,
        };

        try {
          await addScheduleItem.mutateAsync({
            scheduleId: newSchedule.id,
            item: newItem,
          });
          toast.success(`Added ${pendingTargetForSchedule.name} to schedule`);
        } catch (itemErr) {
          toast.error("Schedule created, but failed to add target");
          console.error(itemErr);
        }
        setPendingTargetForSchedule(null);
      }
    } catch (err) {
      toast.error("Failed to create schedule");
      console.error(err);
    }
  };

  // Add item to schedule
  const handleAddToSchedule = async () => {
    if (!searchResult) {
      toast.error("Please search for an object first");
      return;
    }
    if (!activeSchedule) {
      toast.error("Please create or select a schedule first");
      return;
    }
    if (!newItemStartTime) {
      toast.error("Please set a start time");
      return;
    }

    const endTime = calculateEndTime(newItemStartTime, newItemDuration);

    const newItem: ScheduleItem = {
      id: crypto.randomUUID(),
      todo_id: "",
      object_name: searchResult.name,
      start_time: newItemStartTime,
      end_time: endTime,
      priority: 1,
      notes: `${searchResult.objectType} - Mag: ${searchResult.magnitude || "N/A"}`,
      completed: false,
    };

    try {
      await addScheduleItem.mutateAsync({
        scheduleId: activeSchedule.id,
        item: newItem,
      });
      toast.success(`Added ${searchResult.name} to schedule`);
      setAddItemDialogOpen(false);
      setNewItemStartTime("");
    } catch (err) {
      toast.error("Failed to add to schedule");
      console.error(err);
    }
  };

  // Remove item from schedule
  const handleRemoveItem = async (itemId: string) => {
    if (!activeSchedule) return;

    try {
      await removeScheduleItem.mutateAsync({
        scheduleId: activeSchedule.id,
        itemId,
      });
      toast.success("Removed from schedule");
    } catch (err) {
      toast.error("Failed to remove item");
      console.error(err);
    }
  };

  // Set schedule as active
  const handleSetActive = async (scheduleId: string) => {
    try {
      await updateSchedule.mutateAsync({
        id: scheduleId,
        is_active: true,
      });
      toast.success("Schedule activated");
    } catch (err) {
      toast.error("Failed to activate schedule");
      console.error(err);
    }
  };

  // Utility functions
  const calculateEndTime = (startTime: string, duration: number): string => {
    const [hours, minutes] = startTime.split(":").map(Number);
    const endMinutes = minutes + duration;
    const endHours = hours + Math.floor(endMinutes / 60);
    return `${(endHours % 24).toString().padStart(2, "0")}:${(endMinutes % 60)
      .toString()
      .padStart(2, "0")}`;
  };

  const formatTime = (time: string): string => {
    return time.slice(0, 5);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Telescope className="w-8 h-8 text-blue-400" />
        <h1 className="text-2xl font-bold">Observation Planning</h1>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="lookup" className="flex items-center gap-2">
            <Search className="w-4 h-4" />
            Object Lookup
          </TabsTrigger>
          <TabsTrigger value="recommendations" className="flex items-center gap-2">
            <Sparkles className="w-4 h-4" />
            Recommendations
          </TabsTrigger>
          <TabsTrigger value="schedule" className="flex items-center gap-2">
            <Calendar className="w-4 h-4" />
            Schedule
          </TabsTrigger>
          <TabsTrigger value="skymap" className="flex items-center gap-2">
            <Map className="w-4 h-4" />
            Sky Map
          </TabsTrigger>
        </TabsList>

        {/* Object Lookup Tab */}
        <TabsContent value="lookup" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Search className="w-5 h-5" />
                SIMBAD Object Search
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <form onSubmit={handleSearch} className="flex gap-2">
                <Input
                  placeholder="Search by name (e.g., M31, NGC 7000, Orion Nebula)..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="flex-1"
                />
                <Button type="submit" disabled={isSearching}>
                  {isSearching ? "Searching..." : "Search"}
                </Button>
              </form>

              {searchResult && (
                <Card className="bg-muted/30">
                  <CardContent className="pt-4">
                    <div className="flex justify-between items-start">
                      <div>
                        <h3 className="text-lg font-semibold">{searchResult.name}</h3>
                        {searchResult.commonName && (
                          <p className="text-muted-foreground">{searchResult.commonName}</p>
                        )}
                        <div className="mt-2 space-y-1 text-sm">
                          <p>
                            <span className="text-muted-foreground">Type:</span>{" "}
                            <Badge variant="outline">
                              {getObjectTypeInfo(searchResult.objectType).label}
                            </Badge>
                          </p>
                          <p>
                            <span className="text-muted-foreground">RA:</span> {searchResult.ra}
                          </p>
                          <p>
                            <span className="text-muted-foreground">Dec:</span> {searchResult.dec}
                          </p>
                          {searchResult.magnitude && (
                            <p>
                              <span className="text-muted-foreground">Magnitude:</span>{" "}
                              {searchResult.magnitude}
                            </p>
                          )}
                          {searchResult.size && (
                            <p>
                              <span className="text-muted-foreground">Size:</span>{" "}
                              {searchResult.size}
                            </p>
                          )}
                        </div>
                      </div>
                      <Dialog open={addItemDialogOpen} onOpenChange={(open) => {
                        setAddItemDialogOpen(open);
                        if (open && !newItemStartTime) {
                          // Set default start time to current time rounded to next 15 minutes
                          const now = new Date();
                          const minutes = Math.ceil(now.getMinutes() / 15) * 15;
                          now.setMinutes(minutes, 0, 0);
                          const timeStr = now.toTimeString().slice(0, 5);
                          setNewItemStartTime(timeStr);
                        }
                      }}>
                        <DialogTrigger asChild>
                          <Button disabled={!activeSchedule}>
                            <Plus className="w-4 h-4 mr-1" />
                            Add to Schedule
                          </Button>
                        </DialogTrigger>
                        <DialogContent>
                          <DialogHeader>
                            <DialogTitle>Add to Schedule</DialogTitle>
                            <DialogDescription>
                              Add {searchResult.name} to {activeSchedule?.name || "schedule"}
                            </DialogDescription>
                          </DialogHeader>
                          <div className="grid gap-4 py-4">
                            <div className="grid grid-cols-2 gap-4">
                              <div>
                                <Label>Start Time</Label>
                                <Input
                                  type="time"
                                  value={newItemStartTime}
                                  onChange={(e) => setNewItemStartTime(e.target.value)}
                                  className="mt-1"
                                />
                              </div>
                              <div>
                                <Label>Duration (minutes)</Label>
                                <Input
                                  type="number"
                                  min="5"
                                  max="300"
                                  value={newItemDuration}
                                  onChange={(e) => setNewItemDuration(Number(e.target.value))}
                                  className="mt-1"
                                />
                              </div>
                            </div>
                          </div>
                          <DialogFooter>
                            <Button variant="outline" onClick={() => setAddItemDialogOpen(false)}>
                              Cancel
                            </Button>
                            <Button onClick={handleAddToSchedule} disabled={addScheduleItem.isPending}>
                              {addScheduleItem.isPending ? "Adding..." : "Add"}
                            </Button>
                          </DialogFooter>
                        </DialogContent>
                      </Dialog>
                    </div>
                  </CardContent>
                </Card>
              )}

              {!activeSchedule && (
                <p className="text-sm text-muted-foreground">
                  Create a schedule first to add objects to it.
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Recommendations Tab */}
        <TabsContent value="recommendations" className="space-y-6">
          <RecommendationsPanel
            onTargetSelect={(target: RecommendedTarget) => {
              // Convert to search result format and show
              setSearchResult({
                name: target.name,
                commonName: target.commonName,
                objectType: target.type,
                ra: `${target.ra.toFixed(4)}h`,
                dec: `${target.dec > 0 ? "+" : ""}${target.dec.toFixed(4)}°`,
                magnitude: target.magnitude?.toString(),
                size: target.size ? `${target.size}'` : undefined,
              });
              setSearchQuery(target.name);
            }}
            onViewInLookup={(target: RecommendedTarget) => {
              // Set search result and switch to object lookup tab
              setSearchResult({
                name: target.name,
                commonName: target.commonName,
                objectType: target.type,
                ra: `${target.ra.toFixed(4)}h`,
                dec: `${target.dec > 0 ? "+" : ""}${target.dec.toFixed(4)}°`,
                magnitude: target.magnitude?.toString(),
                size: target.size ? `${target.size}'` : undefined,
              });
              setSearchQuery(target.name);
              setActiveTab("lookup");
            }}
            onAddToSchedule={async (target: RecommendedTarget, startTime: string, duration: number) => {
              if (!activeSchedule) {
                // No schedule exists - prompt user to create one
                setPendingTargetForSchedule(target);
                setNewScheduleName(`Tonight's Observations`);
                setNewScheduleDescription(`Observation schedule including ${target.name}`);
                setNewScheduleDialogOpen(true);
                return;
              }

              const endTime = new Date(new Date(startTime).getTime() + duration * 60 * 1000).toISOString().slice(0, 16);

              const newItem: ScheduleItem = {
                id: crypto.randomUUID(),
                todo_id: "",
                object_name: target.name,
                start_time: startTime,
                end_time: endTime,
                priority: 1,
                notes: `${target.type}${target.magnitude ? ` - Mag: ${target.magnitude.toFixed(1)}` : ""}`,
                completed: false,
              };

              try {
                await addScheduleItem.mutateAsync({
                  scheduleId: activeSchedule.id,
                  item: newItem,
                });
                toast.success(`Added ${target.name} to schedule`);
              } catch (err) {
                toast.error("Failed to add to schedule");
                console.error(err);
              }
            }}
            scheduledObjectNames={scheduledObjectNames}
            scheduleItems={scheduleItems.map(item => ({
              object_name: item.object_name,
              start_time: item.start_time,
              end_time: item.end_time,
            }))}
            activeScheduleName={activeSchedule?.name}
          />
        </TabsContent>

        {/* Schedule Tab */}
        <TabsContent value="schedule" className="space-y-6">
          <Card>
            <CardHeader>
              <div className="flex justify-between items-center">
                <CardTitle className="flex items-center gap-2">
                  <Calendar className="w-5 h-5" />
                  Observation Schedules
                </CardTitle>
                <Dialog open={newScheduleDialogOpen} onOpenChange={(open) => {
                  setNewScheduleDialogOpen(open);
                  if (!open) {
                    // Clear pending target when dialog is cancelled
                    setPendingTargetForSchedule(null);
                  }
                }}>
                  <DialogTrigger asChild>
                    <Button size="sm">
                      <Plus className="w-4 h-4 mr-1" />
                      New Schedule
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Create Schedule</DialogTitle>
                      {pendingTargetForSchedule && (
                        <DialogDescription>
                          After creating, "{pendingTargetForSchedule.name}" will be added to this schedule.
                        </DialogDescription>
                      )}
                    </DialogHeader>
                    <div className="grid gap-4 py-4">
                      <div>
                        <Label>Name</Label>
                        <Input
                          value={newScheduleName}
                          onChange={(e) => setNewScheduleName(e.target.value)}
                          placeholder="Tonight's Session"
                          className="mt-1"
                        />
                      </div>
                      <div>
                        <Label>Description</Label>
                        <Textarea
                          value={newScheduleDescription}
                          onChange={(e) => setNewScheduleDescription(e.target.value)}
                          placeholder="Optional description..."
                          className="mt-1"
                        />
                      </div>
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setNewScheduleDialogOpen(false)}>
                        Cancel
                      </Button>
                      <Button onClick={handleCreateSchedule} disabled={createSchedule.isPending}>
                        {createSchedule.isPending ? "Creating..." : "Create"}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>
            </CardHeader>
            <CardContent>
              {schedules.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Calendar className="w-12 h-12 mx-auto mb-4 opacity-50" />
                  <p>No schedules yet. Create one to get started!</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Schedule selector */}
                  <div className="flex flex-wrap gap-2">
                    {schedules.map((schedule) => (
                      <Button
                        key={schedule.id}
                        variant={schedule.is_active ? "default" : "outline"}
                        size="sm"
                        onClick={() => handleSetActive(schedule.id)}
                      >
                        {schedule.name}
                        {schedule.is_active && (
                          <Badge variant="secondary" className="ml-2">
                            Active
                          </Badge>
                        )}
                      </Button>
                    ))}
                  </div>

                  {/* Active schedule items */}
                  {activeSchedule && (
                    <div className="space-y-2">
                      <h3 className="font-medium">{activeSchedule.name}</h3>
                      {activeSchedule.description && (
                        <p className="text-sm text-muted-foreground">
                          {activeSchedule.description}
                        </p>
                      )}

                      {scheduleItems.length === 0 ? (
                        <p className="text-sm text-muted-foreground py-4">
                          No objects scheduled. Search for objects to add them here.
                        </p>
                      ) : (
                        <div className="space-y-2">
                          {scheduleItems.map((item) => (
                            <div
                              key={item.id}
                              className="flex justify-between items-center p-3 border rounded-lg"
                            >
                              <div>
                                <h4 className="font-medium">{item.object_name}</h4>
                                <div className="text-sm text-muted-foreground flex items-center gap-3">
                                  <span className="flex items-center gap-1">
                                    <Clock className="w-3 h-3" />
                                    {formatTime(item.start_time)} - {formatTime(item.end_time)}
                                  </span>
                                  {item.notes && <span>{item.notes}</span>}
                                </div>
                              </div>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleRemoveItem(item.id)}
                              >
                                <Trash2 className="w-4 h-4" />
                              </Button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Sky Map Tab */}
        <TabsContent value="skymap" className="min-h-[calc(100vh-16rem)]">
          <div className="flex min-h-[calc(100vh-16rem)] gap-0">
            <div className="flex-1 min-w-0">
              <AladinLite
                height={500}
                className="min-h-full"
                initialTarget="M31"
                onTargetChange={setSkyMapTarget}
                onFovChange={setSkyMapFov}
              />
            </div>
            <SkyMapSidePanel
              defaultCollapsed={false}
              target={skyMapTarget}
              fovState={skyMapFov}
            />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
