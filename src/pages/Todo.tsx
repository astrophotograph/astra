/**
 * Todo Page — astronomy observation list with tonight's imaging order.
 *
 * Orchestrates data + dialogs; rendering lives in components/todo/*.
 * Astronomy computation lives in useTodoVisibility / lib/imaging-order.
 */

import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { format } from "date-fns";
import {
  useTodos,
  useCreateTodo,
  useUpdateTodo,
  useDeleteTodo,
} from "@/hooks/use-todos";
import {
  useActiveSchedule,
  useAddScheduleItem,
  useCreateSchedule,
} from "@/hooks/use-schedules";
import { useLocations } from "@/contexts/LocationContext";
import { useMoonData } from "@/hooks/use-moon-data";
import { useTodoVisibility } from "@/hooks/use-todo-visibility";
import { computeImagingOrder, type ImagingSlot } from "@/lib/imaging-order";
import { defaultCoordinates } from "@/lib/astronomy-utils";
import type { AstronomyTodo, ScheduleItem } from "@/lib/tauri/commands";
import { ObjectAltitudeDialog } from "@/components/ObjectAltitudeDialog";
import type { SkyDomeObject } from "@/components/SkyDome";
import { TonightPanel } from "@/components/todo/TonightPanel";
import { TodoFilterBar, type TabValue } from "@/components/todo/TodoFilterBar";
import { TodoList, type SortField, type SortDirection } from "@/components/todo/TodoList";
import { AddTodoDialog } from "@/components/todo/AddTodoDialog";
import { EditTodoDialog } from "@/components/todo/EditTodoDialog";
import { GoalTimeDialog } from "@/components/todo/GoalTimeDialog";
import { parseTags } from "@/components/todo/tags";

export default function TodoPage() {
  const [activeTab, setActiveTab] = useState<TabValue>("all");
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [goalDialogOpen, setGoalDialogOpen] = useState(false);
  const [editingTodo, setEditingTodo] = useState<AstronomyTodo | null>(null);
  const [goalTodo, setGoalTodo] = useState<AstronomyTodo | null>(null);
  const [altitudeDialogOpen, setAltitudeDialogOpen] = useState(false);
  const [altitudeTodo, setAltitudeTodo] = useState<AstronomyTodo | null>(null);
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [typeFilters, setTypeFilters] = useState<Set<string>>(new Set());
  const [tagFilters, setTagFilters] = useState<Set<string>>(new Set());
  const [hideNotVisible, setHideNotVisible] = useState(false);
  const [expandedTodoId, setExpandedTodoId] = useState<string | null>(null);
  const [highlightedTodoId, setHighlightedTodoId] = useState<string | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Observer location from the shared context (same source as the altitude
  // dialog), not the legacy localStorage key.
  const { activeLocation } = useLocations();
  const location = useMemo(
    () =>
      activeLocation
        ? { latitude: activeLocation.latitude, longitude: activeLocation.longitude }
        : defaultCoordinates,
    [activeLocation],
  );
  const horizon = activeLocation?.horizon ?? null;

  // Queries and mutations
  const { data: todos = [], isLoading, error } = useTodos();
  const createTodo = useCreateTodo();
  const updateTodo = useUpdateTodo();
  const deleteTodo = useDeleteTodo();

  // Schedule hooks
  const { data: activeSchedule } = useActiveSchedule();
  const addScheduleItem = useAddScheduleItem();
  const createSchedule = useCreateSchedule();

  // Astronomy state
  const moon = useMoonData();
  const { map: visibilityMap } = useTodoVisibility(todos, location, horizon);
  const order = useMemo(
    () => computeImagingOrder(todos, visibilityMap, location, moon),
    [todos, visibilityMap, location, moon],
  );
  const slotByTodoId = useMemo(() => {
    const map = new Map<string, ImagingSlot>();
    order.slots.forEach((slot) => map.set(slot.todo.id, slot));
    return map;
  }, [order]);

  const skyObjects = useMemo<SkyDomeObject[]>(() => {
    const objects: SkyDomeObject[] = [];
    for (const todo of todos) {
      if (todo.completed) continue;
      const v = visibilityMap.get(todo.id);
      if (v?.altitude == null || v.azimuth == null) continue;
      objects.push({
        id: todo.id,
        name: todo.name,
        altitude: v.altitude,
        azimuth: v.azimuth,
        state: todo.flagged ? "flagged" : "pending",
        order: slotByTodoId.get(todo.id)?.order ?? null,
      });
    }
    return objects;
  }, [todos, visibilityMap, slotByTodoId]);

  // Unique object types / tags for the filter dropdowns
  const uniqueTypes = useMemo(() => {
    const types = new Set<string>();
    todos.forEach((todo) => {
      if (todo.object_type) types.add(todo.object_type);
    });
    return Array.from(types).sort();
  }, [todos]);

  const uniqueTags = useMemo(() => {
    const tags = new Set<string>();
    todos.forEach((todo) => parseTags(todo.tags).forEach((tag) => tags.add(tag)));
    return Array.from(tags).sort();
  }, [todos]);

  // Filter todos based on active tab, type filters, and tag filters
  const filteredTodos = useMemo(() => {
    let filtered = todos.filter((todo) => {
      if (activeTab === "pending") return !todo.completed;
      if (activeTab === "flagged") return todo.flagged;
      if (activeTab === "completed") return todo.completed;
      return true;
    });

    if (typeFilters.size > 0) {
      filtered = filtered.filter(
        (todo) => todo.object_type && typeFilters.has(todo.object_type),
      );
    }

    if (tagFilters.size > 0) {
      filtered = filtered.filter((todo) => {
        const todoTags = parseTags(todo.tags);
        return Array.from(tagFilters).some((tag) => todoTags.includes(tag));
      });
    }

    if (hideNotVisible) {
      filtered = filtered.filter((todo) => {
        const v = visibilityMap.get(todo.id);
        if (!v) return true;
        return !v.neverVisible && !v.notVisibleRestOfNight;
      });
    }

    return filtered;
  }, [todos, activeTab, typeFilters, tagFilters, hideNotVisible, visibilityMap]);

  // Sort filtered todos
  const sortedTodos = useMemo(() => {
    const sorted = [...filteredTodos];

    sorted.sort((a, b) => {
      let comparison = 0;
      const dataA = visibilityMap.get(a.id);
      const dataB = visibilityMap.get(b.id);

      switch (sortField) {
        case "name":
          comparison = a.name.localeCompare(b.name);
          break;
        case "altitude": {
          comparison = (dataA?.altitude ?? -999) - (dataB?.altitude ?? -999);
          break;
        }
        case "direction": {
          comparison = (dataA?.direction ?? "ZZZ").localeCompare(dataB?.direction ?? "ZZZ");
          break;
        }
        case "moonDistance": {
          comparison = (dataA?.moonDistance ?? 999) - (dataB?.moonDistance ?? 999);
          break;
        }
        case "window": {
          const startA = dataA?.window?.start.getTime() ?? Infinity;
          const startB = dataB?.window?.start.getTime() ?? Infinity;
          comparison = startA === startB ? 0 : startA - startB;
          break;
        }
        case "goalTime": {
          comparison = (a.goal_time ?? "99:99").localeCompare(b.goal_time ?? "99:99");
          break;
        }
      }

      return sortDirection === "asc" ? comparison : -comparison;
    });

    return sorted;
  }, [filteredTodos, sortField, sortDirection, visibilityMap]);

  const counts = {
    all: todos.length,
    pending: todos.filter((t) => !t.completed).length,
    flagged: todos.filter((t) => t.flagged).length,
    completed: todos.filter((t) => t.completed).length,
  };

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDirection("asc");
    }
  };

  // Dome/timeline → list linking: expand, retab if needed, scroll, highlight.
  const handleSelectObject = (id: string) => {
    const todo = todos.find((t) => t.id === id);
    if (!todo) return;
    const tabShowsTodo =
      activeTab === "all" ||
      (activeTab === "pending" && !todo.completed) ||
      (activeTab === "flagged" && todo.flagged) ||
      (activeTab === "completed" && todo.completed);
    if (!tabShowsTodo) setActiveTab("all");
    setExpandedTodoId(id);
    setHighlightedTodoId(id);
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlightedTodoId(null), 2000);
    // Let the row render (tab switch / expansion) before scrolling.
    requestAnimationFrame(() => {
      document
        .getElementById(`todo-row-${id}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  const handleToggleComplete = async (todo: AstronomyTodo) => {
    const newCompleted = !todo.completed;
    try {
      await updateTodo.mutateAsync({
        id: todo.id,
        completed: newCompleted,
        completed_at: newCompleted ? new Date().toISOString() : undefined,
      });
      toast.success(`${todo.name} marked as ${newCompleted ? "observed" : "pending"}`);
    } catch (err) {
      toast.error("Failed to update todo");
      console.error(err);
    }
  };

  const handleToggleFlag = async (todo: AstronomyTodo) => {
    try {
      await updateTodo.mutateAsync({ id: todo.id, flagged: !todo.flagged });
      toast.success(`${todo.name} ${!todo.flagged ? "flagged" : "unflagged"}`);
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

  const handleSaveEdit = async (
    id: string,
    updates: { name: string; notes?: string; tags?: string[] },
  ) => {
    try {
      await updateTodo.mutateAsync({ id, ...updates });
      toast.success(`Updated ${updates.name}`);
      setEditDialogOpen(false);
      setEditingTodo(null);
    } catch (err) {
      toast.error("Failed to update todo");
      console.error(err);
    }
  };

  const handleOpenGoalDialog = (todo: AstronomyTodo) => {
    setGoalTodo(todo);
    setGoalDialogOpen(true);
  };

  const handleSaveGoal = async (id: string, goalTime: string) => {
    try {
      await updateTodo.mutateAsync({ id, goal_time: goalTime || undefined });
      toast.success("Goal time updated");
      setGoalDialogOpen(false);
      setGoalTodo(null);
    } catch (err) {
      toast.error("Failed to update goal time");
      console.error(err);
    }
  };

  const handleOpenAltitudeDialog = (todo: AstronomyTodo) => {
    setAltitudeTodo(todo);
    setAltitudeDialogOpen(true);
  };

  const handleSetGoalTimeFromAltitude = async (time: string) => {
    if (!altitudeTodo) return;
    try {
      await updateTodo.mutateAsync({ id: altitudeTodo.id, goal_time: time });
    } catch (err) {
      toast.error("Failed to set goal time");
      console.error(err);
    }
  };

  // Handler for adding to schedule from the altitude dialog
  const handleAddToScheduleFromAltitude = async (startTime: string, duration: number) => {
    if (!altitudeTodo) return;

    // Convert HH:mm to full datetime-local format for today
    const now = new Date();
    const [hours, minutes] = startTime.split(":").map(Number);
    const startDate = new Date(now);
    startDate.setHours(hours, minutes, 0, 0);
    // If time has passed, assume tomorrow
    if (startDate < now) {
      startDate.setDate(startDate.getDate() + 1);
    }
    const fullStartTime = format(startDate, "yyyy-MM-dd'T'HH:mm");
    const endDate = new Date(startDate.getTime() + duration * 60 * 1000);
    const endTime = format(endDate, "yyyy-MM-dd'T'HH:mm");

    const newItem: ScheduleItem = {
      id: crypto.randomUUID(),
      todo_id: altitudeTodo.id,
      object_name: altitudeTodo.name,
      start_time: fullStartTime,
      end_time: endTime,
      priority: 1,
      notes: `${altitudeTodo.object_type || ""} - Mag: ${altitudeTodo.magnitude}`,
      completed: false,
    };

    if (!activeSchedule) {
      try {
        const newSchedule = await createSchedule.mutateAsync({
          name: "Tonight's Observations",
          description: `Created from todo list`,
          is_active: true,
        });
        await addScheduleItem.mutateAsync({ scheduleId: newSchedule.id, item: newItem });
        toast.success(`Created schedule and added ${altitudeTodo.name}`);
      } catch (err) {
        toast.error("Failed to create schedule");
        console.error(err);
      }
    } else {
      try {
        await addScheduleItem.mutateAsync({ scheduleId: activeSchedule.id, item: newItem });
        toast.success(`Added ${altitudeTodo.name} to ${activeSchedule.name}`);
      } catch (err) {
        toast.error("Failed to add to schedule");
        console.error(err);
      }
    }
  };

  // Check if current altitude todo is already scheduled
  const isAltitudeTodoScheduled = useMemo(() => {
    if (!altitudeTodo || !activeSchedule) return false;
    try {
      const items: ScheduleItem[] = JSON.parse(activeSchedule.items || "[]");
      return items.some((item) => item.object_name === altitudeTodo.name);
    } catch {
      return false;
    }
  }, [altitudeTodo, activeSchedule]);

  // Get schedule items for altitude chart display
  const scheduleItemsForChart = useMemo(() => {
    if (!activeSchedule) return [];
    try {
      const items: ScheduleItem[] = JSON.parse(activeSchedule.items || "[]");
      return items.map((item) => ({
        object_name: item.object_name,
        start_time: item.start_time,
        end_time: item.end_time,
      }));
    } catch {
      return [];
    }
  }, [activeSchedule]);

  const toggleTypeFilter = (type: string) => {
    setTypeFilters((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  const toggleTagFilter = (tag: string) => {
    setTagFilters((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  };

  const emptyMessage =
    activeTab === "all"
      ? "No objects in your todo list. Add some to get started!"
      : activeTab === "pending"
        ? "No pending observations."
        : activeTab === "flagged"
          ? "No flagged observations."
          : "No completed observations yet.";

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
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[11px] uppercase tracking-[0.2em] text-slate-400">
            Observation list
          </p>
          <h1 className="font-serif text-3xl font-light tracking-wide text-slate-100">
            Targets to Image
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Flag the objects you want tonight — Astra suggests the order to shoot them.
          </p>
        </div>
        <AddTodoDialog onCreate={async (input) => void (await createTodo.mutateAsync(input))} />
      </div>

      {/* Tonight panel */}
      {!isLoading && todos.length > 0 && (
        <TonightPanel
          order={order}
          moon={moon}
          objects={skyObjects}
          horizon={horizon}
          selectedId={highlightedTodoId ?? expandedTodoId}
          onSelectObject={handleSelectObject}
        />
      )}

      {/* Tabs and filters */}
      <TodoFilterBar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        counts={counts}
        uniqueTypes={uniqueTypes}
        typeFilters={typeFilters}
        onToggleType={toggleTypeFilter}
        onClearTypes={() => setTypeFilters(new Set())}
        uniqueTags={uniqueTags}
        tagFilters={tagFilters}
        onToggleTag={toggleTagFilter}
        onClearTags={() => setTagFilters(new Set())}
        hideNotVisible={hideNotVisible}
        onToggleHideNotVisible={() => setHideNotVisible(!hideNotVisible)}
      />

      {/* Todo list */}
      <TodoList
        todos={sortedTodos}
        visibility={visibilityMap}
        slotByTodoId={slotByTodoId}
        expandedId={expandedTodoId}
        highlightedId={highlightedTodoId}
        sortField={sortField}
        sortDirection={sortDirection}
        onSort={handleSort}
        onToggleExpand={(id) => setExpandedTodoId(expandedTodoId === id ? null : id)}
        onToggleComplete={handleToggleComplete}
        onToggleFlag={handleToggleFlag}
        onDelete={handleDelete}
        onEdit={handleEditTodo}
        onSetGoal={handleOpenGoalDialog}
        onShowAltitude={handleOpenAltitudeDialog}
        onTagClick={toggleTagFilter}
        emptyMessage={emptyMessage}
        loading={isLoading}
      />

      {/* Dialogs */}
      <EditTodoDialog
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        todo={editingTodo}
        saving={updateTodo.isPending}
        onSave={handleSaveEdit}
      />
      <GoalTimeDialog
        open={goalDialogOpen}
        onOpenChange={setGoalDialogOpen}
        todo={goalTodo}
        saving={updateTodo.isPending}
        onSave={handleSaveGoal}
      />
      {altitudeTodo && (
        <ObjectAltitudeDialog
          open={altitudeDialogOpen}
          onOpenChange={setAltitudeDialogOpen}
          objectName={altitudeTodo.name}
          ra={altitudeTodo.ra}
          dec={altitudeTodo.dec}
          onSetGoalTime={handleSetGoalTimeFromAltitude}
          onAddToSchedule={handleAddToScheduleFromAltitude}
          isScheduled={isAltitudeTodoScheduled}
          activeScheduleName={activeSchedule?.name}
          scheduleItems={scheduleItemsForChart}
        />
      )}
    </div>
  );
}
