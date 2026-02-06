/**
 * Plan Page - Astronomy observation planning
 */

import { useState, useMemo } from "react";
import { format } from "date-fns";
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
  Sparkles,
  Telescope,
  Trash2,
  Settings2,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useEquipment } from "@/contexts/EquipmentContext";
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
  parseScheduleItems,
  type ScheduleItem,
} from "@/lib/tauri/commands";

export default function PlanPage() {
  const [newScheduleDialogOpen, setNewScheduleDialogOpen] = useState(false);
  const [newScheduleName, setNewScheduleName] = useState("");
  const [newScheduleDescription, setNewScheduleDescription] = useState("");
  const [newScheduleEquipmentId, setNewScheduleEquipmentId] = useState<string>("");
  const [activeTab, setActiveTab] = useState("recommendations");

  // Pending target to add after schedule creation
  const [pendingTargetForSchedule, setPendingTargetForSchedule] = useState<RecommendedTarget | null>(null);

  // Sky map target/FOV state for altitude chart
  const [skyMapTarget, setSkyMapTarget] = useState<TargetInfo | null>(null);
  const [skyMapFov, setSkyMapFov] = useState<{ enabled: boolean; ra?: number; dec?: number }>({ enabled: false });

  // Equipment context
  const { equipmentSets, getEquipmentById } = useEquipment();

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
        equipment_id: newScheduleEquipmentId || undefined,
      });
      toast.success(`Created schedule: ${newScheduleName}`);
      setNewScheduleDialogOpen(false);
      setNewScheduleName("");
      setNewScheduleDescription("");
      setNewScheduleEquipmentId("");

      // If there's a pending target, add it to the new schedule
      if (pendingTargetForSchedule && newSchedule) {
        const now = new Date();
        const startTime = format(now, "yyyy-MM-dd'T'HH:mm");
        const endTime = format(new Date(now.getTime() + 30 * 60 * 1000), "yyyy-MM-dd'T'HH:mm");

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

  // Utility function
  const formatTime = (time: string): string => {
    try {
      const date = new Date(time);
      return format(date, "HH:mm");
    } catch {
      return time.slice(11, 16) || time;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Telescope className="w-8 h-8 text-blue-400" />
        <h1 className="text-2xl font-bold">Observation Planning</h1>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="recommendations" className="flex items-center gap-2">
            <Sparkles className="w-4 h-4" />
            Recommendations
          </TabsTrigger>
          <TabsTrigger value="skymap" className="flex items-center gap-2">
            <Map className="w-4 h-4" />
            Sky Map
          </TabsTrigger>
          <TabsTrigger value="schedule" className="flex items-center gap-2">
            <Calendar className="w-4 h-4" />
            Schedule
          </TabsTrigger>
        </TabsList>

        {/* Recommendations Tab */}
        <TabsContent value="recommendations" className="space-y-6">
          <RecommendationsPanel
            onAddToSchedule={async (target: RecommendedTarget, startTime: string, duration: number) => {
              if (!activeSchedule) {
                // No schedule exists - prompt user to create one
                setPendingTargetForSchedule(target);
                setNewScheduleName(`Tonight's Observations`);
                setNewScheduleDescription(`Observation schedule including ${target.name}`);
                setNewScheduleDialogOpen(true);
                return;
              }

              // Calculate end time in local time format (not UTC)
              const endDate = new Date(new Date(startTime).getTime() + duration * 60 * 1000);
              const endTime = format(endDate, "yyyy-MM-dd'T'HH:mm");

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
                    // Clear pending target and reset form when dialog is cancelled
                    setPendingTargetForSchedule(null);
                    setNewScheduleEquipmentId("");
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
                      {equipmentSets.length > 0 && (
                        <div>
                          <Label>Equipment (Optional)</Label>
                          <Select
                            value={newScheduleEquipmentId}
                            onValueChange={setNewScheduleEquipmentId}
                          >
                            <SelectTrigger className="mt-1">
                              <SelectValue placeholder="Select equipment set..." />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="">None</SelectItem>
                              {equipmentSets.map((eq) => (
                                <SelectItem key={eq.id} value={eq.id}>
                                  <div className="flex items-center gap-2">
                                    <Settings2 className="w-4 h-4 text-muted-foreground" />
                                    {eq.name}
                                  </div>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <p className="text-xs text-muted-foreground mt-1">
                            Associate this schedule with specific equipment to allow multiple active schedules.
                          </p>
                        </div>
                      )}
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
                    {schedules.map((schedule) => {
                      const equipment = schedule.equipment_id
                        ? getEquipmentById(schedule.equipment_id)
                        : null;
                      return (
                        <Button
                          key={schedule.id}
                          variant={schedule.is_active ? "default" : "outline"}
                          size="sm"
                          onClick={() => handleSetActive(schedule.id)}
                          className="flex items-center gap-1"
                        >
                          {schedule.name}
                          {equipment && (
                            <Badge variant="outline" className="ml-1 text-xs">
                              <Settings2 className="w-3 h-3 mr-1" />
                              {equipment.name}
                            </Badge>
                          )}
                          {schedule.is_active && (
                            <Badge variant="secondary" className="ml-1">
                              Active
                            </Badge>
                          )}
                        </Button>
                      );
                    })}
                  </div>

                  {/* Active schedule items */}
                  {activeSchedule && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <h3 className="font-medium">{activeSchedule.name}</h3>
                        {activeSchedule.equipment_id && getEquipmentById(activeSchedule.equipment_id) && (
                          <Badge variant="outline" className="text-xs">
                            <Settings2 className="w-3 h-3 mr-1" />
                            {getEquipmentById(activeSchedule.equipment_id)?.name}
                          </Badge>
                        )}
                      </div>
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
