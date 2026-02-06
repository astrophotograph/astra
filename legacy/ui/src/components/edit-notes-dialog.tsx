// Edit Notes Dialog Component
import {Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle} from "@/components/ui/dialog"
import {Label} from "@/components/ui/label"
import {Textarea} from "@/components/ui/textarea"
import {marked} from "marked"
import {Button} from "@/components/ui/button"

import {AstronomyObject} from "@/components/todo-list-types"

interface EditNotesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  object: AstronomyObject | null;
  notes: string;
  setNotes: (notes: string) => void;
  onSave: () => void;
}

export function EditNotesDialog({
                                  open,
                                  onOpenChange,
                                  object,
                                  notes,
                                  setNotes,
                                  onSave,
                                }: EditNotesDialogProps) {
  if (!object) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Edit Notes for {object.name}</DialogTitle>
        </DialogHeader>
        <div className="py-4">
          <div className="space-y-2">
            <Label htmlFor="editNotes">Notes (supports markdown)</Label>
            <Textarea
              id="editNotes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Add notes about this object (markdown supported)"
              className="min-h-[200px]"
            />
          </div>
          {notes && (
            <div className="mt-4 p-4 border rounded-md">
              <Label className="block mb-2">Preview:</Label>
              <div
                className="prose prose-sm dark:prose-invert"
                dangerouslySetInnerHTML={{__html: marked(notes)}}
              />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onSave}>Save Notes</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
