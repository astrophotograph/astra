/**
 * Add-object dialog: SIMBAD lookup on desktop, manual coordinates on web
 * (the lookup is Python-backed and desktop-only).
 */

import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { astronomyApi, isTauri, type CreateTodoInput } from "@/lib/tauri/commands";

interface AddTodoDialogProps {
  onCreate: (input: CreateTodoInput) => Promise<void>;
}

export function AddTodoDialog({ onCreate }: AddTodoDialogProps) {
  const [open, setOpen] = useState(false);
  const [objectName, setObjectName] = useState("");
  const [notes, setNotes] = useState("");
  const [newTags, setNewTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [isLookupLoading, setIsLookupLoading] = useState(false);
  const [manualRa, setManualRa] = useState("");
  const [manualDec, setManualDec] = useState("");
  const [manualMagnitude, setManualMagnitude] = useState("");
  const [manualSize, setManualSize] = useState("");

  const reset = () => {
    setOpen(false);
    setObjectName("");
    setNotes("");
    setNewTags([]);
    setTagInput("");
    setManualRa("");
    setManualDec("");
    setManualMagnitude("");
    setManualSize("");
  };

  const handleAddTag = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && tagInput.trim()) {
      e.preventDefault();
      const tag = tagInput.trim().toLowerCase();
      if (!newTags.includes(tag)) {
        setNewTags([...newTags, tag]);
      }
      setTagInput("");
    }
  };

  const handleAdd = async () => {
    if (!objectName.trim()) {
      toast.error("Please enter an object name");
      return;
    }

    // Web: no SIMBAD lookup — the typed-in coordinates are the record.
    if (!isTauri()) {
      if (!manualRa.trim() || !manualDec.trim()) {
        toast.error("Please enter RA and Dec (SIMBAD lookup needs the desktop app)");
        return;
      }
      try {
        await onCreate({
          name: objectName.trim(),
          ra: manualRa.trim(),
          dec: manualDec.trim(),
          magnitude: manualMagnitude.trim() || "N/A",
          size: manualSize.trim() || "N/A",
          notes: notes.trim() || undefined,
          tags: newTags.length > 0 ? newTags : undefined,
        });
        toast.success(`Added ${objectName.trim()} to your todo list`);
        reset();
      } catch (err) {
        toast.error("Failed to add object");
        console.error(err);
      }
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
        const messierMatch = enteredNameUpper.match(/^M(\d+)$/);
        if (messierMatch && catalogs["Messier"] === messierMatch[1]) {
          displayName = `M ${catalogs["Messier"]}`;
        } else if (enteredNameUpper.startsWith("NGC") && catalogs["NGC"]) {
          const ngcMatch = enteredNameUpper.match(/^NGC(\d+)$/);
          if (ngcMatch && catalogs["NGC"] === ngcMatch[1]) {
            displayName = `NGC ${catalogs["NGC"]}`;
          }
        } else if (enteredNameUpper.startsWith("IC") && catalogs["IC"]) {
          const icMatch = enteredNameUpper.match(/^IC(\d+)$/);
          if (icMatch && catalogs["IC"] === icMatch[1]) {
            displayName = `IC ${catalogs["IC"]}`;
          }
        } else if (enteredNameUpper.startsWith("C") && catalogs["Caldwell"]) {
          const caldwellMatch = enteredNameUpper.match(/^C(\d+)$/);
          if (caldwellMatch && catalogs["Caldwell"] === caldwellMatch[1]) {
            displayName = `C ${catalogs["Caldwell"]}`;
          }
        } else if (enteredNameUpper.startsWith("SH") && catalogs["Sharpless"]) {
          displayName = `Sh2-${catalogs["Sharpless"]}`;
        } else if (enteredNameUpper.startsWith("B") && catalogs["Barnard"]) {
          const barnardMatch = enteredNameUpper.match(/^B(\d+)$/);
          if (barnardMatch && catalogs["Barnard"] === barnardMatch[1]) {
            displayName = `B ${catalogs["Barnard"]}`;
          }
        }
      }

      await onCreate({
        name: displayName,
        ra: result.ra || "N/A",
        dec: result.dec || "N/A",
        magnitude: result.magnitude || "N/A",
        size: result.size || "N/A",
        object_type: result.objectType || undefined,
        notes: notes.trim() || undefined,
        tags: newTags.length > 0 ? newTags : undefined,
      });

      toast.success(`Added ${displayName} to your todo list`);
      reset();
    } catch (err) {
      toast.error("Failed to look up object. Please check the name and try again.");
      console.error(err);
    } finally {
      setIsLookupLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
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
            {isTauri()
              ? "Enter the name of a celestial object to look up in SIMBAD."
              : "Enter the object's name and coordinates."}
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
              onKeyDown={(e) => {
                if (e.key === "Enter" && !isLookupLoading) handleAdd();
              }}
            />
            <p className="text-sm text-muted-foreground">
              {isTauri()
                ? "The object's coordinates and details will be looked up automatically."
                : "SIMBAD lookup is available in the desktop app — enter coordinates below."}
            </p>
          </div>
          {!isTauri() && (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="manual_ra">RA</Label>
                  <Input
                    id="manual_ra"
                    placeholder="e.g., 05h 35m 17s"
                    value={manualRa}
                    onChange={(e) => setManualRa(e.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="manual_dec">Dec</Label>
                  <Input
                    id="manual_dec"
                    placeholder="e.g., -05° 23′ 28″"
                    value={manualDec}
                    onChange={(e) => setManualDec(e.target.value)}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="manual_magnitude">Magnitude (optional)</Label>
                  <Input
                    id="manual_magnitude"
                    placeholder="e.g., 4.0"
                    value={manualMagnitude}
                    onChange={(e) => setManualMagnitude(e.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="manual_size">Size (optional)</Label>
                  <Input
                    id="manual_size"
                    placeholder="e.g., 85′ × 60′"
                    value={manualSize}
                    onChange={(e) => setManualSize(e.target.value)}
                  />
                </div>
              </div>
            </>
          )}
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
          <div className="grid gap-2">
            <Label htmlFor="tags">Tags (optional)</Label>
            <div className="flex flex-wrap gap-1 mb-2">
              {newTags.map((tag) => (
                <Badge
                  key={tag}
                  variant="secondary"
                  className="text-xs cursor-pointer"
                  onClick={() => setNewTags(newTags.filter((t) => t !== tag))}
                >
                  {tag}
                  <X className="w-3 h-3 ml-1" />
                </Badge>
              ))}
            </div>
            <Input
              id="tags"
              placeholder="Type a tag and press Enter (e.g., backyard, seestar, dark-sky)"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={handleAddTag}
            />
            <p className="text-sm text-muted-foreground">
              Add tags like location, equipment, or conditions.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleAdd} disabled={isLookupLoading}>
            {isLookupLoading ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Looking up...
              </>
            ) : (
              "Add to List"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
