/**
 * Todo Page - Astronomy observation todo list
 */

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import {
  useTodos,
  useCreateTodo,
  useUpdateTodo,
  useDeleteTodo,
} from "@/hooks/use-todos";
import { astronomyApi } from "@/lib/tauri/commands";
import type { AstronomyTodo } from "@/lib/tauri/commands";
import { getObjectTypeInfo } from "@/lib/objectTypeMap";
import { cn } from "@/lib/utils";

type TabValue = "all" | "pending" | "completed";

export default function TodoPage() {
  const [activeTab, setActiveTab] = useState<TabValue>("all");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingTodo, setEditingTodo] = useState<AstronomyTodo | null>(null);

  // Form state for adding new todo - simplified to just name and notes
  const [objectName, setObjectName] = useState("");
  const [notes, setNotes] = useState("");
  const [isLookupLoading, setIsLookupLoading] = useState(false);

  // Queries and mutations
  const { data: todos = [], isLoading, error } = useTodos();
  const createTodo = useCreateTodo();
  const updateTodo = useUpdateTodo();
  const deleteTodo = useDeleteTodo();

  // Filter todos based on active tab
  const filteredTodos = todos.filter((todo) => {
    if (activeTab === "all") return true;
    if (activeTab === "pending") return !todo.completed;
    if (activeTab === "completed") return todo.completed;
    return true;
  });

  // Stats
  const pendingCount = todos.filter((t) => !t.completed).length;
  const completedCount = todos.filter((t) => t.completed).length;

  const handleAddTodo = async () => {
    if (!objectName.trim()) {
      toast.error("Please enter an object name");
      return;
    }

    setIsLookupLoading(true);

    try {
      // Look up the object in SIMBAD
      const result = await astronomyApi.lookupObject(objectName);

      if (!result) {
        toast.error("Object not found in SIMBAD. Please check the name and try again.");
        setIsLookupLoading(false);
        return;
      }

      // Clean up the name (remove "NAME " prefix if present)
      let cleanName = result.name;
      if (cleanName.startsWith("NAME ")) {
        cleanName = cleanName.replace("NAME ", "");
      }

      // Create the todo with SIMBAD data
      await createTodo.mutateAsync({
        name: cleanName,
        ra: result.ra || "N/A",
        dec: result.dec || "N/A",
        magnitude: result.magnitude || "N/A",
        size: result.size || "N/A",
        object_type: result.objectType || undefined,
        notes: notes.trim() || undefined,
      });

      toast.success(`Added ${cleanName} to your todo list`);
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

  // Handle Enter key in input
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
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold">Observation Todo List</h1>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button>Add Object</Button>
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
                  placeholder="Add notes about this object (supports markdown)"
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

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as TabValue)}>
        <TabsList>
          <TabsTrigger value="all">All ({todos.length})</TabsTrigger>
          <TabsTrigger value="pending">Pending ({pendingCount})</TabsTrigger>
          <TabsTrigger value="completed">Observed ({completedCount})</TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Todo List */}
      {isLoading ? (
        <div className="text-center py-12 border rounded-lg bg-muted/30">
          <p className="text-muted-foreground">Loading observation list...</p>
        </div>
      ) : filteredTodos.length === 0 ? (
        <div className="text-center py-12 border rounded-lg bg-muted/30">
          <p className="text-muted-foreground">
            {activeTab === "all"
              ? "No objects in your todo list. Add some to get started!"
              : activeTab === "pending"
              ? "No pending observations."
              : "No completed observations yet."}
          </p>
        </div>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          {/* Header Row */}
          <div className="grid grid-cols-12 gap-2 px-4 py-2 bg-muted/50 text-sm font-medium">
            <div className="col-span-4">Object</div>
            <div className="col-span-2">Type</div>
            <div className="col-span-2">Mag / Size</div>
            <div className="col-span-2">Status</div>
            <div className="col-span-2 text-right">Actions</div>
          </div>

          {/* Todo Items */}
          <div className="divide-y">
            {filteredTodos.map((todo) => {
              const typeInfo = getObjectTypeInfo(todo.object_type || "Unknown");
              return (
                <div
                  key={todo.id}
                  className={cn(
                    "grid grid-cols-12 gap-2 px-4 py-3 items-center hover:bg-muted/30",
                    todo.completed && "opacity-60"
                  )}
                >
                  <div className="col-span-4">
                    <div className="font-medium">{todo.name}</div>
                    {todo.notes && (
                      <div className="text-sm text-muted-foreground truncate">
                        {todo.notes}
                      </div>
                    )}
                  </div>
                  <div className="col-span-2">
                    <Badge
                      variant="outline"
                      style={{
                        backgroundColor: typeInfo.color + "20",
                        borderColor: typeInfo.color,
                      }}
                    >
                      {typeInfo.label}
                    </Badge>
                  </div>
                  <div className="col-span-2 text-sm text-muted-foreground">
                    {todo.magnitude !== "N/A" ? `${todo.magnitude}m` : ""}{" "}
                    {todo.size !== "N/A" ? todo.size : ""}
                  </div>
                  <div className="col-span-2">
                    <Badge
                      variant={todo.completed ? "secondary" : "default"}
                    >
                      {todo.completed ? "Observed" : "Pending"}
                    </Badge>
                  </div>
                  <div className="col-span-2 flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleToggleComplete(todo)}
                    >
                      {todo.completed ? "Reopen" : "Complete"}
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="sm">
                          ...
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => handleEditTodo(todo)}>
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-destructive"
                          onClick={() => handleDelete(todo)}
                        >
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
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
    </div>
  );
}
