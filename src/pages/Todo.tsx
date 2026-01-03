/**
 * Todo Page - Astronomy observation todo list
 * Enhanced with computed altitude, direction, sortable columns, and action buttons
 */

import { useState, useEffect, useMemo } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Checkbox } from "@/components/ui/checkbox";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import {
  ArrowUpDown,
  ChevronDown,
  ChevronUp,
  Clock,
  Edit,
  Filter,
  Flag,
  Moon,
  Plus,
  Trash2,
  LineChart,
} from "lucide-react";
import {
  useTodos,
  useCreateTodo,
  useUpdateTodo,
  useDeleteTodo,
} from "@/hooks/use-todos";
import { astronomyApi } from "@/lib/tauri/commands";
import type { AstronomyTodo } from "@/lib/tauri/commands";
import { getObjectTypeInfo } from "@/lib/objectTypeMap";
import {
  parseCoordinates,
  calculateCurrentAltitude,
  calculateCurrentAzimuth,
  azimuthToCompassDirection,
  generateNightAltitudeData,
  getMaxAltitudeTime,
  formatTime,
  defaultCoordinates,
  loadHorizonProfile,
  getHorizonAltitude,
  calculateAngularDistance,
  getMoonPosition,
  type HorizonProfile,
} from "@/lib/astronomy-utils";
import { cn } from "@/lib/utils";
import { ObjectAltitudeDialog } from "@/components/ObjectAltitudeDialog";

type TabValue = "all" | "pending" | "flagged" | "completed";
type SortField = "name" | "magnitude" | "size" | "altitude" | "direction" | "peakTime" | "goalTime" | "moonDistance";
type SortDirection = "asc" | "desc";

interface ComputedData {
  altitude: number | null;
  azimuth: number | null;
  direction: string | null;
  peakTime: string | null;
  maxAltitude: number | null;  // Maximum altitude during the night
  neverVisible: boolean;       // True if never rises above local horizon during night
  horizonAltitude: number | null;  // Local horizon altitude at current azimuth
  belowHorizon: boolean;       // True if currently below local horizon
  moonDistance: number | null; // Angular distance from the moon in degrees
  raDeg: number | null;
  decDeg: number | null;
}

export default function TodoPage() {
  const [activeTab, setActiveTab] = useState<TabValue>("all");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [goalDialogOpen, setGoalDialogOpen] = useState(false);
  const [editingTodo, setEditingTodo] = useState<AstronomyTodo | null>(null);
  const [goalTodo, setGoalTodo] = useState<AstronomyTodo | null>(null);
  const [goalTimeValue, setGoalTimeValue] = useState("");
  const [altitudeDialogOpen, setAltitudeDialogOpen] = useState(false);
  const [altitudeTodo, setAltitudeTodo] = useState<AstronomyTodo | null>(null);
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [typeFilters, setTypeFilters] = useState<Set<string>>(new Set());

  // Form state for adding new todo
  const [objectName, setObjectName] = useState("");
  const [notes, setNotes] = useState("");
  const [isLookupLoading, setIsLookupLoading] = useState(false);

  // Computed altitude data cache
  const [computedDataMap, setComputedDataMap] = useState<Map<string, ComputedData>>(new Map());

  // Get observer location from localStorage or use default
  const [observerLocation, setObserverLocation] = useState(defaultCoordinates);

  // Horizon profile for local obstructions
  const [horizonProfile, setHorizonProfile] = useState<HorizonProfile | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem("observer_location");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed.latitude && parsed.longitude) {
          setObserverLocation({
            latitude: parsed.latitude,
            longitude: parsed.longitude,
          });
        }
      } catch {
        // Use default
      }
    }

    // Load horizon profile
    setHorizonProfile(loadHorizonProfile());
  }, []);

  // Queries and mutations
  const { data: todos = [], isLoading, error } = useTodos();
  const createTodo = useCreateTodo();
  const updateTodo = useUpdateTodo();
  const deleteTodo = useDeleteTodo();

  // Get unique object types for filter
  const uniqueTypes = useMemo(() => {
    const types = new Set<string>();
    todos.forEach((todo) => {
      if (todo.object_type) {
        types.add(todo.object_type);
      }
    });
    return Array.from(types).sort();
  }, [todos]);

  // Compute altitude and direction for all todos
  useEffect(() => {
    const computeData = async () => {
      const newMap = new Map<string, ComputedData>();

      // Get current moon position once for all calculations
      const moonPos = getMoonPosition(observerLocation);

      for (const todo of todos) {
        const coords = parseCoordinates(todo.ra, todo.dec);
        if (coords) {
          const altitude = calculateCurrentAltitude(coords.raDeg, coords.decDeg, observerLocation);
          const azimuth = calculateCurrentAzimuth(coords.raDeg, coords.decDeg, observerLocation);
          const direction = azimuthToCompassDirection(azimuth);

          // Calculate angular distance from the moon
          const moonDistance = calculateAngularDistance(
            altitude,
            azimuth,
            moonPos.altitude,
            moonPos.azimuth
          );

          // Calculate altitude data for the night
          const altitudeData = generateNightAltitudeData(coords.raDeg, coords.decDeg, observerLocation);
          const peakTimeDate = getMaxAltitudeTime(altitudeData);
          const peakTime = peakTimeDate ? formatTime(peakTimeDate) : null;

          // Calculate max altitude during the night
          const maxAltitude = altitudeData.length > 0
            ? Math.max(...altitudeData.map(p => p.altitude))
            : null;

          // Get local horizon altitude at current azimuth
          const horizonAltitude = horizonProfile
            ? getHorizonAltitude(horizonProfile, azimuth)
            : 0;

          // Check if currently below local horizon
          const belowHorizon = altitude < horizonAltitude;

          // Object is "never visible" if it never rises above visibility threshold during the night
          // Check each altitude point against the local horizon at that time's azimuth
          let neverVisible = true;
          if (altitudeData.length > 0) {
            for (const point of altitudeData) {
              // For night altitude data, we'd need azimuth at each time - use a simplified check
              // Consider visible if altitude exceeds both 20° and local horizon at peak
              const pointHorizon = horizonProfile
                ? getHorizonAltitude(horizonProfile, azimuth) // approximation - uses current azimuth
                : 0;
              if (point.altitude > Math.max(20, pointHorizon)) {
                neverVisible = false;
                break;
              }
            }
          }

          newMap.set(todo.id, {
            altitude,
            azimuth,
            direction,
            peakTime: neverVisible ? null : peakTime,  // Don't show peak time if never visible
            maxAltitude,
            neverVisible,
            horizonAltitude,
            belowHorizon,
            moonDistance,
            raDeg: coords.raDeg,
            decDeg: coords.decDeg,
          });
        } else {
          newMap.set(todo.id, {
            altitude: null,
            azimuth: null,
            direction: null,
            peakTime: null,
            maxAltitude: null,
            neverVisible: false,
            horizonAltitude: null,
            belowHorizon: false,
            moonDistance: null,
            raDeg: null,
            decDeg: null,
          });
        }
      }

      setComputedDataMap(newMap);
    };

    if (todos.length > 0) {
      computeData();
    }

    // Refresh computed data every 5 minutes
    const interval = setInterval(computeData, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [todos, observerLocation, horizonProfile]);

  // Filter todos based on active tab and type filters
  const filteredTodos = useMemo(() => {
    let filtered = todos.filter((todo) => {
      if (activeTab === "all") return true;
      if (activeTab === "pending") return !todo.completed;
      if (activeTab === "flagged") return todo.flagged;
      if (activeTab === "completed") return todo.completed;
      return true;
    });

    // Apply type filters
    if (typeFilters.size > 0) {
      filtered = filtered.filter((todo) =>
        todo.object_type && typeFilters.has(todo.object_type)
      );
    }

    return filtered;
  }, [todos, activeTab, typeFilters]);

  // Sort filtered todos
  const sortedTodos = useMemo(() => {
    const sorted = [...filteredTodos];

    sorted.sort((a, b) => {
      let comparison = 0;
      const dataA = computedDataMap.get(a.id);
      const dataB = computedDataMap.get(b.id);

      switch (sortField) {
        case "name":
          comparison = a.name.localeCompare(b.name);
          break;
        case "magnitude": {
          const magA = a.magnitude !== "N/A" ? parseFloat(a.magnitude) : 999;
          const magB = b.magnitude !== "N/A" ? parseFloat(b.magnitude) : 999;
          comparison = magA - magB;
          break;
        }
        case "size": {
          // Parse size (e.g., "45'" or "2.5°")
          const parseSize = (s: string) => {
            if (s === "N/A") return 0;
            const match = s.match(/([\d.]+)/);
            return match ? parseFloat(match[1]) : 0;
          };
          comparison = parseSize(a.size) - parseSize(b.size);
          break;
        }
        case "altitude": {
          const altA = dataA?.altitude ?? -999;
          const altB = dataB?.altitude ?? -999;
          comparison = altA - altB;
          break;
        }
        case "direction": {
          const dirA = dataA?.direction ?? "ZZZ";
          const dirB = dataB?.direction ?? "ZZZ";
          comparison = dirA.localeCompare(dirB);
          break;
        }
        case "peakTime": {
          const timeA = dataA?.peakTime ?? "99:99";
          const timeB = dataB?.peakTime ?? "99:99";
          comparison = timeA.localeCompare(timeB);
          break;
        }
        case "goalTime": {
          const goalA = a.goal_time ?? "99:99";
          const goalB = b.goal_time ?? "99:99";
          comparison = goalA.localeCompare(goalB);
          break;
        }
        case "moonDistance": {
          const moonA = dataA?.moonDistance ?? 999;
          const moonB = dataB?.moonDistance ?? 999;
          comparison = moonA - moonB;
          break;
        }
      }

      return sortDirection === "asc" ? comparison : -comparison;
    });

    return sorted;
  }, [filteredTodos, sortField, sortDirection, computedDataMap]);

  // Stats
  const pendingCount = todos.filter((t) => !t.completed).length;
  const flaggedCount = todos.filter((t) => t.flagged).length;
  const completedCount = todos.filter((t) => t.completed).length;

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDirection("asc");
    }
  };

  const SortHeader = ({ field, children }: { field: SortField; children: React.ReactNode }) => (
    <button
      className="flex items-center gap-1 hover:text-white transition-colors"
      onClick={() => handleSort(field)}
    >
      {children}
      {sortField === field ? (
        sortDirection === "asc" ? (
          <ChevronUp className="w-3 h-3" />
        ) : (
          <ChevronDown className="w-3 h-3" />
        )
      ) : (
        <ArrowUpDown className="w-3 h-3 opacity-50" />
      )}
    </button>
  );

  const handleAddTodo = async () => {
    if (!objectName.trim()) {
      toast.error("Please enter an object name");
      return;
    }

    setIsLookupLoading(true);

    try {
      const result = await astronomyApi.lookupObject(objectName);

      if (!result) {
        toast.error("Object not found in SIMBAD. Please check the name and try again.");
        setIsLookupLoading(false);
        return;
      }

      // Prefer the user's entered name if it matches a catalog designation
      // This allows "M17" to show as "M 17" instead of "NGC 6618"
      let displayName = result.name;
      if (displayName.startsWith("NAME ")) {
        displayName = displayName.replace("NAME ", "");
      }

      const enteredNameUpper = objectName.trim().toUpperCase().replace(/\s+/g, "");
      const catalogs = result.catalogs as Record<string, string> | undefined;

      if (catalogs) {
        // Check if user entered a Messier designation (M17, M 17, etc.)
        const messierMatch = enteredNameUpper.match(/^M(\d+)$/);
        if (messierMatch && catalogs["Messier"] === messierMatch[1]) {
          displayName = `M ${catalogs["Messier"]}`;
        }
        // Check if user entered an NGC designation
        else if (enteredNameUpper.startsWith("NGC") && catalogs["NGC"]) {
          const ngcMatch = enteredNameUpper.match(/^NGC(\d+)$/);
          if (ngcMatch && catalogs["NGC"] === ngcMatch[1]) {
            displayName = `NGC ${catalogs["NGC"]}`;
          }
        }
        // Check if user entered an IC designation
        else if (enteredNameUpper.startsWith("IC") && catalogs["IC"]) {
          const icMatch = enteredNameUpper.match(/^IC(\d+)$/);
          if (icMatch && catalogs["IC"] === icMatch[1]) {
            displayName = `IC ${catalogs["IC"]}`;
          }
        }
        // Check if user entered a Caldwell designation
        else if (enteredNameUpper.startsWith("C") && catalogs["Caldwell"]) {
          const caldwellMatch = enteredNameUpper.match(/^C(\d+)$/);
          if (caldwellMatch && catalogs["Caldwell"] === caldwellMatch[1]) {
            displayName = `C ${catalogs["Caldwell"]}`;
          }
        }
        // Check if user entered a Sharpless designation (Sh2-xxx)
        else if (enteredNameUpper.startsWith("SH") && catalogs["Sharpless"]) {
          displayName = `Sh2-${catalogs["Sharpless"]}`;
        }
        // Check if user entered a Barnard designation
        else if (enteredNameUpper.startsWith("B") && catalogs["Barnard"]) {
          const barnardMatch = enteredNameUpper.match(/^B(\d+)$/);
          if (barnardMatch && catalogs["Barnard"] === barnardMatch[1]) {
            displayName = `B ${catalogs["Barnard"]}`;
          }
        }
      }

      await createTodo.mutateAsync({
        name: displayName,
        ra: result.ra || "N/A",
        dec: result.dec || "N/A",
        magnitude: result.magnitude || "N/A",
        size: result.size || "N/A",
        object_type: result.objectType || undefined,
        notes: notes.trim() || undefined,
      });

      toast.success(`Added ${displayName} to your todo list`);
      setDialogOpen(false);
      setObjectName("");
      setNotes("");
    } catch (err) {
      toast.error("Failed to look up object. Please check the name and try again.");
      console.error(err);
    } finally {
      setIsLookupLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !isLookupLoading) {
      handleAddTodo();
    }
  };

  const handleToggleComplete = async (todo: AstronomyTodo) => {
    const newCompleted = !todo.completed;
    try {
      await updateTodo.mutateAsync({
        id: todo.id,
        completed: newCompleted,
        completed_at: newCompleted ? new Date().toISOString() : undefined,
      });
      toast.success(
        `${todo.name} marked as ${newCompleted ? "observed" : "pending"}`
      );
    } catch (err) {
      toast.error("Failed to update todo");
      console.error(err);
    }
  };

  const handleToggleFlag = async (todo: AstronomyTodo) => {
    try {
      await updateTodo.mutateAsync({
        id: todo.id,
        flagged: !todo.flagged,
      });
      toast.success(
        `${todo.name} ${!todo.flagged ? "flagged" : "unflagged"}`
      );
    } catch (err) {
      toast.error("Failed to update flag");
      console.error(err);
    }
  };

  const handleDelete = async (todo: AstronomyTodo) => {
    try {
      await deleteTodo.mutateAsync(todo.id);
      toast.success(`Removed ${todo.name}`);
    } catch (err) {
      toast.error("Failed to delete todo");
      console.error(err);
    }
  };

  const handleEditTodo = (todo: AstronomyTodo) => {
    setEditingTodo(todo);
    setEditDialogOpen(true);
  };

  const handleSaveEdit = async () => {
    if (!editingTodo) return;

    try {
      await updateTodo.mutateAsync({
        id: editingTodo.id,
        name: editingTodo.name,
        notes: editingTodo.notes || undefined,
      });
      toast.success(`Updated ${editingTodo.name}`);
      setEditDialogOpen(false);
      setEditingTodo(null);
    } catch (err) {
      toast.error("Failed to update todo");
      console.error(err);
    }
  };

  const handleOpenGoalDialog = (todo: AstronomyTodo) => {
    setGoalTodo(todo);
    setGoalTimeValue(todo.goal_time || "");
    setGoalDialogOpen(true);
  };

  const handleOpenAltitudeDialog = (todo: AstronomyTodo) => {
    setAltitudeTodo(todo);
    setAltitudeDialogOpen(true);
  };

  const handleSetGoalTimeFromAltitude = async (time: string) => {
    if (!altitudeTodo) return;

    try {
      await updateTodo.mutateAsync({
        id: altitudeTodo.id,
        goal_time: time,
      });
    } catch (err) {
      toast.error("Failed to set goal time");
      console.error(err);
    }
  };

  const handleSaveGoal = async () => {
    if (!goalTodo) return;

    try {
      await updateTodo.mutateAsync({
        id: goalTodo.id,
        goal_time: goalTimeValue.trim() || undefined,
      });
      toast.success(`Goal time updated for ${goalTodo.name}`);
      setGoalDialogOpen(false);
      setGoalTodo(null);
      setGoalTimeValue("");
    } catch (err) {
      toast.error("Failed to update goal time");
      console.error(err);
    }
  };

  const toggleTypeFilter = (type: string) => {
    setTypeFilters((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  };

  // Get altitude color based on value
  const getAltitudeColor = (altitude: number | null) => {
    if (altitude === null) return "text-muted-foreground";
    if (altitude < 0) return "text-red-500";
    if (altitude < 20) return "text-yellow-500";
    if (altitude < 40) return "text-green-400";
    return "text-green-500";
  };

  if (error) {
    return (
      <div className="text-center py-12">
        <p className="text-destructive">Error loading todos: {String(error)}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Astronomy Objects Todo List</h1>
        <p className="text-muted-foreground mt-1">
          Keep track of celestial objects you want to observe. Add objects to your list and remove them once you've completed your observation.
        </p>
      </div>

      {/* Action Bar */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Your Observation Todo List</h2>
        <div className="flex items-center gap-2">
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="w-4 h-4 mr-2" />
                Add Object
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add Astronomy Object</DialogTitle>
                <DialogDescription>
                  Enter the name of a celestial object to look up in SIMBAD.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-4 py-4">
                <div className="grid gap-2">
                  <Label htmlFor="object_name">Object Name</Label>
                  <Input
                    id="object_name"
                    placeholder="e.g., M31, NGC 7000, Orion Nebula"
                    value={objectName}
                    onChange={(e) => setObjectName(e.target.value)}
                    onKeyDown={handleKeyDown}
                  />
                  <p className="text-sm text-muted-foreground">
                    The object's coordinates and details will be looked up automatically.
                  </p>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="notes">Notes (optional)</Label>
                  <Textarea
                    id="notes"
                    placeholder="Add notes about this object"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    className="min-h-[100px]"
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDialogOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={handleAddTodo} disabled={isLookupLoading}>
                  {isLookupLoading ? "Looking up..." : "Add to List"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Tabs and Filter */}
      <div className="flex items-center justify-between">
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as TabValue)}>
          <TabsList>
            <TabsTrigger value="all">All Objects ({todos.length})</TabsTrigger>
            <TabsTrigger value="pending">Pending ({pendingCount})</TabsTrigger>
            <TabsTrigger value="flagged">Flagged ({flaggedCount})</TabsTrigger>
            <TabsTrigger value="completed">Completed ({completedCount})</TabsTrigger>
          </TabsList>
        </Tabs>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <Filter className="w-4 h-4 mr-2" />
              Filter Types
              {typeFilters.size > 0 && (
                <Badge variant="secondary" className="ml-2">
                  {typeFilters.size}
                </Badge>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>Object Types</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {uniqueTypes.map((type) => {
              const typeInfo = getObjectTypeInfo(type);
              return (
                <DropdownMenuCheckboxItem
                  key={type}
                  checked={typeFilters.has(type)}
                  onCheckedChange={() => toggleTypeFilter(type)}
                >
                  {typeInfo.label}
                </DropdownMenuCheckboxItem>
              );
            })}
            {typeFilters.size > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setTypeFilters(new Set())}>
                  Clear filters
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Todo List */}
      {isLoading ? (
        <div className="text-center py-12 border rounded-lg bg-muted/30">
          <p className="text-muted-foreground">Loading observation list...</p>
        </div>
      ) : sortedTodos.length === 0 ? (
        <div className="text-center py-12 border rounded-lg bg-muted/30">
          <p className="text-muted-foreground">
            {activeTab === "all"
              ? "No objects in your todo list. Add some to get started!"
              : activeTab === "pending"
              ? "No pending observations."
              : activeTab === "flagged"
              ? "No flagged observations."
              : "No completed observations yet."}
          </p>
        </div>
      ) : (
        <div className="border rounded-lg overflow-x-auto">
          {/* Header Row */}
          <div className="grid grid-cols-[40px_minmax(120px,1fr)_110px_85px_90px_50px_75px_65px_50px_55px_55px_60px_150px] gap-3 px-4 py-2 bg-muted/50 text-sm font-medium text-muted-foreground min-w-[1100px]">
            <div>Status</div>
            <SortHeader field="name">Name</SortHeader>
            <div>Type</div>
            <div>RA</div>
            <div>Dec</div>
            <SortHeader field="magnitude">Mag</SortHeader>
            <SortHeader field="size">Size</SortHeader>
            <SortHeader field="altitude">Alt</SortHeader>
            <SortHeader field="direction">Dir</SortHeader>
            <SortHeader field="moonDistance"><Moon className="w-3 h-3" /></SortHeader>
            <SortHeader field="peakTime">Peak</SortHeader>
            <SortHeader field="goalTime">Goal</SortHeader>
            <div className="text-right">Actions</div>
          </div>

          {/* Todo Items */}
          <div className="divide-y">
            {sortedTodos.map((todo) => {
              const typeInfo = getObjectTypeInfo(todo.object_type || "Unknown");
              const computedData = computedDataMap.get(todo.id);

              return (
                <div
                  key={todo.id}
                  className={cn(
                    "grid grid-cols-[40px_minmax(120px,1fr)_110px_85px_90px_50px_75px_65px_50px_55px_55px_60px_150px] gap-3 px-4 py-3 items-center hover:bg-muted/30 text-sm min-w-[1100px]",
                    todo.completed && "opacity-60"
                  )}
                >
                  {/* Status */}
                  <div>
                    <Checkbox
                      checked={todo.completed}
                      onCheckedChange={() => handleToggleComplete(todo)}
                    />
                  </div>

                  {/* Name */}
                  <div className="min-w-0">
                    <div className="font-medium truncate flex items-center gap-2">
                      {todo.name}
                      {todo.flagged && (
                        <Flag className="w-3 h-3 text-amber-500 fill-amber-500" />
                      )}
                    </div>
                    {computedData?.neverVisible ? (
                      <div className="text-xs text-orange-400 truncate" title={`Max altitude: ${computedData.maxAltitude?.toFixed(1)}°`}>
                        Not visible tonight (max {computedData.maxAltitude?.toFixed(0)}°)
                      </div>
                    ) : todo.notes ? (
                      <div className="text-xs text-muted-foreground truncate">
                        {todo.notes}
                      </div>
                    ) : null}
                  </div>

                  {/* Type */}
                  <div>
                    <Badge
                      variant="outline"
                      className="text-xs truncate max-w-full"
                      style={{
                        backgroundColor: typeInfo.color + "20",
                        borderColor: typeInfo.color,
                      }}
                    >
                      {typeInfo.label}
                    </Badge>
                  </div>

                  {/* RA */}
                  <div className="text-muted-foreground font-mono text-xs truncate" title={todo.ra}>
                    {todo.ra !== "N/A" ? todo.ra : "—"}
                  </div>

                  {/* Dec */}
                  <div className="text-muted-foreground font-mono text-xs truncate" title={todo.dec}>
                    {todo.dec !== "N/A" ? todo.dec : "—"}
                  </div>

                  {/* Magnitude */}
                  <div className="text-muted-foreground truncate">
                    {todo.magnitude !== "N/A" ? todo.magnitude : "—"}
                  </div>

                  {/* Size */}
                  <div className="text-muted-foreground truncate" title={todo.size}>
                    {todo.size !== "N/A" ? todo.size : "—"}
                  </div>

                  {/* Altitude */}
                  <div className={cn("font-medium truncate", getAltitudeColor(computedData?.altitude ?? null))}>
                    {computedData?.altitude !== null && computedData?.altitude !== undefined
                      ? `${computedData.altitude.toFixed(1)}°`
                      : "—"}
                  </div>

                  {/* Direction */}
                  <div className="text-muted-foreground truncate">
                    {computedData?.direction || "—"}
                  </div>

                  {/* Moon Distance */}
                  <div className="text-muted-foreground truncate" title={computedData?.moonDistance != null ? `${computedData.moonDistance.toFixed(1)}° from moon` : undefined}>
                    {computedData?.moonDistance != null
                      ? `${computedData.moonDistance.toFixed(0)}°`
                      : "—"}
                  </div>

                  {/* Peak Time */}
                  <div className="text-muted-foreground truncate">
                    {computedData?.peakTime || "—"}
                  </div>

                  {/* Goal Time */}
                  <div className="text-muted-foreground truncate">
                    {todo.goal_time || "—"}
                  </div>

                  {/* Actions */}
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => handleOpenAltitudeDialog(todo)}
                      title="View altitude chart"
                    >
                      <LineChart className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => handleToggleFlag(todo)}
                      title={todo.flagged ? "Remove flag" : "Flag"}
                    >
                      <Flag className={cn("w-4 h-4", todo.flagged && "fill-amber-500 text-amber-500")} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => handleOpenGoalDialog(todo)}
                      title="Set goal time"
                    >
                      <Clock className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => handleEditTodo(todo)}
                      title="Edit"
                    >
                      <Edit className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive hover:text-destructive"
                      onClick={() => handleDelete(todo)}
                      title="Delete"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Edit Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit {editingTodo?.name}</DialogTitle>
          </DialogHeader>
          {editingTodo && (
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="edit_notes">Notes</Label>
                <Textarea
                  id="edit_notes"
                  value={editingTodo.notes || ""}
                  onChange={(e) =>
                    setEditingTodo({ ...editingTodo, notes: e.target.value })
                  }
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveEdit} disabled={updateTodo.isPending}>
              {updateTodo.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Goal Time Dialog */}
      <Dialog open={goalDialogOpen} onOpenChange={setGoalDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Set Goal Time for {goalTodo?.name}</DialogTitle>
            <DialogDescription>
              Set a target exposure time or observation duration goal.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="goal_time">Goal Time</Label>
              <Input
                id="goal_time"
                placeholder="e.g., 2h 30m, 120 min, etc."
                value={goalTimeValue}
                onChange={(e) => setGoalTimeValue(e.target.value)}
              />
              <p className="text-sm text-muted-foreground">
                Enter your target exposure or observation time.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setGoalDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveGoal} disabled={updateTodo.isPending}>
              {updateTodo.isPending ? "Saving..." : "Save Goal"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Altitude Dialog */}
      {altitudeTodo && (
        <ObjectAltitudeDialog
          open={altitudeDialogOpen}
          onOpenChange={setAltitudeDialogOpen}
          objectName={altitudeTodo.name}
          ra={altitudeTodo.ra}
          dec={altitudeTodo.dec}
          onSetGoalTime={handleSetGoalTimeFromAltitude}
        />
      )}
    </div>
  );
}
