// Add Object Dialog Component
import {Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger} from "@/components/ui/dialog"
import {Button} from "@/components/ui/button"
import {PlusCircle} from "lucide-react"
import {Label} from "@/components/ui/label"
import {Input} from "@/components/ui/input"
import {Textarea} from "@/components/ui/textarea"

interface AddObjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  objectName: string;
  setObjectName: (name: string) => void;
  notes: string;
  setNotes: (notes: string) => void;
  onAddObject: () => void;
  isLoading: boolean;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

export function AddObjectDialog({
                                  open,
                                  onOpenChange,
                                  objectName,
                                  setObjectName,
                                  notes,
                                  setNotes,
                                  onAddObject,
                                  isLoading,
                                  onKeyDown,
                                }: AddObjectDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button>
          <PlusCircle className="mr-2 h-4 w-4"/>
          Add Object
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Astronomy Object</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="objectName">Object Name</Label>
            <Input
              id="objectName"
              placeholder="e.g. M31, NGC 7000, Andromeda"
              value={objectName}
              onChange={(e) => setObjectName(e.target.value)}
              onKeyDown={onKeyDown}
            />
            <p className="text-sm text-muted-foreground">
              Enter the name of a celestial object to look up in Simbad
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="objectNotes">Notes (supports markdown)</Label>
            <Textarea
              id="objectNotes"
              placeholder="Add notes about this object (markdown supported)"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="min-h-[100px]"
            />
            <p className="text-sm text-muted-foreground">
              You can use markdown formatting for your notes
            </p>
          </div>
        </div>
        <div className="flex justify-end">
          <Button onClick={onAddObject} disabled={isLoading}>
            {isLoading ? "Looking up..." : "Add to List"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
