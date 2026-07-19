import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { AstronomyTodo } from "@/lib/tauri/commands";

interface GoalTimeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  todo: AstronomyTodo | null;
  saving: boolean;
  onSave: (id: string, goalTime: string) => Promise<void>;
}

export function GoalTimeDialog({ open, onOpenChange, todo, saving, onSave }: GoalTimeDialogProps) {
  const [value, setValue] = useState("");

  useEffect(() => {
    if (open && todo) {
      setValue(todo.goal_time || "");
    }
  }, [open, todo]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set Goal Time for {todo?.name}</DialogTitle>
          <DialogDescription>
            Set a target start time (HH:MM shows on the timeline) or an exposure goal.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="goal_time">Goal Time</Label>
            <Input
              id="goal_time"
              placeholder="e.g., 22:30, 2h 30m, 120 min"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <p className="text-sm text-muted-foreground">
              Enter your target start time or observation duration.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => todo && onSave(todo.id, value.trim())}
            disabled={saving}
          >
            {saving ? "Saving..." : "Save Goal"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
