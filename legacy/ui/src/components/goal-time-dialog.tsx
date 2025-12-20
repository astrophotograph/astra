// Set Goal Time Dialog Component
import {AstronomyObject} from "@/components/todo-list-types"
import {Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle} from "@/components/ui/dialog"
import {Label} from "@/components/ui/label"
import {Input} from "@/components/ui/input"
import {Button} from "@/components/ui/button"

interface GoalTimeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  object: AstronomyObject | null;
  goalTime: string;
  setGoalTime: (time: string) => void;
  onSave: () => void;
  maxAltitudeCache: Record<string, string>;
}

export function GoalTimeDialog({
                                 open,
                                 onOpenChange,
                                 object,
                                 goalTime,
                                 setGoalTime,
                                 onSave,
                                 maxAltitudeCache,
                               }: GoalTimeDialogProps) {
  if (!object) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>Set Goal Observation Time</DialogTitle>
        </DialogHeader>
        <div className="py-4">
          <p className="mb-4">
            Set your target time to observe {object.name}:
          </p>
          <div className="space-y-2">
            <Label htmlFor="goalTime">Time</Label>
            <Input
              id="goalTime"
              type="time"
              value={goalTime}
              onChange={(e) => setGoalTime(e.target.value)}
              placeholder="HH:MM"
            />
            {maxAltitudeCache[object.id] && (
              <p className="text-sm text-muted-foreground">
                Recommended time (peak altitude): {maxAltitudeCache[object.id]}
              </p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onSave}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
