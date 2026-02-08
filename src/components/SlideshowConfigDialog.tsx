import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Play } from "lucide-react";
import { useCollections } from "@/hooks/use-collections";
import { useCollectionImages } from "@/hooks/use-images";
import { getCollectionType } from "@/lib/collection-utils";

interface SlideshowConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preselectedCollectionId?: string;
}

export default function SlideshowConfigDialog({
  open,
  onOpenChange,
  preselectedCollectionId,
}: SlideshowConfigDialogProps) {
  const navigate = useNavigate();
  const { data: collections = [] } = useCollections();

  const [selectedCollectionIds, setSelectedCollectionIds] = useState<string[]>([]);
  const [transition, setTransition] = useState("fade");
  const [theme, setTheme] = useState("nameOnly");
  const [interval, setInterval] = useState("10");
  const [shuffle, setShuffle] = useState(false);

  // Non-archived, non-catalog collections
  const eligibleCollections = collections.filter(
    (c) => !c.archived && getCollectionType(c.template) !== "catalog"
  );

  // Pre-select collection when dialog opens
  useEffect(() => {
    if (open && preselectedCollectionId) {
      setSelectedCollectionIds([preselectedCollectionId]);
    } else if (open && !preselectedCollectionId) {
      setSelectedCollectionIds([]);
    }
  }, [open, preselectedCollectionId]);

  const toggleCollection = (id: string) => {
    setSelectedCollectionIds((prev) =>
      prev.includes(id) ? prev.filter((cid) => cid !== id) : [...prev, id]
    );
  };

  const handleStart = () => {
    if (selectedCollectionIds.length === 0) return;
    const params = new URLSearchParams({
      collections: selectedCollectionIds.join(","),
      transition,
      theme,
      interval,
      shuffle: shuffle ? "1" : "0",
    });
    onOpenChange(false);
    navigate(`/slideshow?${params.toString()}`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-slate-800 border-slate-700 text-white sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Slideshow Settings</DialogTitle>
          <DialogDescription className="text-gray-400">
            Choose collections and configure your slideshow.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-4">
          {/* Collections */}
          <div className="space-y-2">
            <Label>Collections</Label>
            <div className="max-h-[200px] overflow-y-auto space-y-1 rounded-md border border-slate-600 p-2 bg-slate-900">
              {eligibleCollections.length === 0 ? (
                <p className="text-sm text-gray-500 py-2 text-center">
                  No collections with images available
                </p>
              ) : (
                eligibleCollections.map((c) => (
                  <CollectionRow
                    key={c.id}
                    collectionId={c.id}
                    name={c.name}
                    checked={selectedCollectionIds.includes(c.id)}
                    onToggle={() => toggleCollection(c.id)}
                  />
                ))
              )}
            </div>
          </div>

          {/* Transition */}
          <div className="space-y-2">
            <Label>Transition</Label>
            <Select value={transition} onValueChange={setTransition}>
              <SelectTrigger className="bg-slate-700 border-slate-600">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-slate-700 border-slate-600">
                <SelectItem value="fade">Fade</SelectItem>
                <SelectItem value="slide">Slide</SelectItem>
                <SelectItem value="zoom">Zoom</SelectItem>
                <SelectItem value="none">None</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Info Overlay */}
          <div className="space-y-2">
            <Label>Info Overlay</Label>
            <Select value={theme} onValueChange={setTheme}>
              <SelectTrigger className="bg-slate-700 border-slate-600">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-slate-700 border-slate-600">
                <SelectItem value="nameOnly">Object Name</SelectItem>
                <SelectItem value="nameDetails">Name & Details</SelectItem>
                <SelectItem value="nothing">Nothing</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Interval */}
          <div className="space-y-2">
            <Label>Auto-advance Interval</Label>
            <Select value={interval} onValueChange={setInterval}>
              <SelectTrigger className="bg-slate-700 border-slate-600">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-slate-700 border-slate-600">
                <SelectItem value="5">5 seconds</SelectItem>
                <SelectItem value="10">10 seconds</SelectItem>
                <SelectItem value="15">15 seconds</SelectItem>
                <SelectItem value="20">20 seconds</SelectItem>
                <SelectItem value="30">30 seconds</SelectItem>
                <SelectItem value="0">Manual</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Shuffle */}
          <div className="flex items-center gap-2">
            <Checkbox
              id="shuffle"
              checked={shuffle}
              onCheckedChange={(v) => setShuffle(v === true)}
              className="border-slate-500"
            />
            <Label htmlFor="shuffle" className="cursor-pointer">
              Shuffle order
            </Label>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="bg-transparent border-gray-600 text-white hover:bg-gray-700"
          >
            Cancel
          </Button>
          <Button
            onClick={handleStart}
            disabled={selectedCollectionIds.length === 0}
          >
            <Play className="w-4 h-4 mr-2" />
            Start Slideshow
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Individual collection row with image count */
function CollectionRow({
  collectionId,
  name,
  checked,
  onToggle,
}: {
  collectionId: string;
  name: string;
  checked: boolean;
  onToggle: () => void;
}) {
  const { data: images = [] } = useCollectionImages(collectionId);

  return (
    <label className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-slate-800 cursor-pointer">
      <Checkbox
        checked={checked}
        onCheckedChange={onToggle}
        className="border-slate-500"
      />
      <span className="flex-1 text-sm text-white truncate">{name}</span>
      <span className="text-xs text-gray-500">{images.length} images</span>
    </label>
  );
}
