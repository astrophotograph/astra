/**
 * Top Targets Dialog - Shows aggregated target statistics across all images
 */

import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FolderDown } from "lucide-react";
import { useImages } from "@/hooks/use-images";
import { NGC_TO_MESSIER } from "@/lib/models";
import type { Collection, CatalogObject, Image } from "@/lib/tauri/commands";
import { getCollectionType } from "@/lib/collection-utils";
import { cn } from "@/lib/utils";
import CollectFilesDialog from "./CollectFilesDialog";

interface TopTargetsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  collections: Collection[];
}

interface TargetStats {
  name: string;
  aliases: string[];
  catalog: string;
  objectType: string;
  imageCount: number;
  totalExposureSeconds: number;
  inCollections: Collection[];
  ra: number;
  dec: number;
  stackedPaths: string[];
}

type SortField = "exposure" | "images" | "name";
type CatalogFilter = "all" | "messier" | "ngc" | "ic" | "other";

/**
 * Normalize a target name using NGC_TO_MESSIER mapping
 */
function normalizeTargetName(name: string): string {
  // Check if it's an NGC that maps to Messier
  const messierName = NGC_TO_MESSIER[name as keyof typeof NGC_TO_MESSIER];
  if (messierName) {
    return messierName;
  }
  return name;
}

/**
 * Get catalog type from target name
 */
function getCatalogFromName(name: string): string {
  if (name.startsWith("M ") || name.startsWith("M")) return "Messier";
  if (name.startsWith("NGC ")) return "NGC";
  if (name.startsWith("IC ")) return "IC";
  if (name.startsWith("Sh2-")) return "Sharpless";
  if (name.startsWith("LDN ")) return "LDN";
  if (name.startsWith("Abell ")) return "Abell";
  return "Other";
}

/**
 * Format seconds as human-readable duration
 */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.round((seconds % 3600) / 60);

  if (days > 0) {
    if (hours > 0) return `${days}d ${hours}h`;
    if (minutes > 0) return `${days}d ${minutes}m`;
    return `${days}d`;
  }
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

/**
 * Extract total exposure/integration time in seconds from image metadata or filename
 * Prioritizes total integration time over per-frame exposure
 */
function extractExposureSeconds(image: Image): number {
  // First try metadata
  if (image.metadata) {
    try {
      const metadata = typeof image.metadata === "string"
        ? JSON.parse(image.metadata)
        : image.metadata;

      // Priority 1: Check for explicit total integration time
      if (typeof metadata.total_integration_time === "number" && metadata.total_integration_time > 0) {
        return metadata.total_integration_time;
      }

      // Priority 2: Calculate from stacked frames × per-frame exposure
      const frames = metadata.stacked_frames || metadata.stackedFrames || metadata.frames || metadata.STACKCNT;
      const perFrame = metadata.exposure || metadata.exposure_time || metadata.exptime ||
                       (metadata.fits?.EXPTIME ? parseFloat(metadata.fits.EXPTIME) : null) ||
                       (metadata.fits?.EXPOSURE ? parseFloat(metadata.fits.EXPOSURE) : null);

      if (typeof frames === "number" && frames > 0 && typeof perFrame === "number" && perFrame > 0) {
        return frames * perFrame;
      }

      // Priority 3: Fall back to single exposure value (might be total for non-stacked)
      if (typeof metadata.exposure === "number" && metadata.exposure > 0) return metadata.exposure;
      if (typeof metadata.exposure_time === "number" && metadata.exposure_time > 0) return metadata.exposure_time;
      if (typeof metadata.exptime === "number" && metadata.exptime > 0) return metadata.exptime;

      // Check FITS-style nested structure
      if (metadata.fits?.EXPTIME) return parseFloat(metadata.fits.EXPTIME) || 0;
      if (metadata.fits?.EXPOSURE) return parseFloat(metadata.fits.EXPOSURE) || 0;
    } catch {
      // Continue to filename parsing
    }
  }

  // Try to extract from Seestar-style filename
  // Example: "Stacked_272_NGC 3718_10.0s_IRCUT_20250528-224821.jpg"
  // Format: Stacked_<frameCount>_<target>_<exposurePerFrame>s_...
  if (image.filename) {
    // Try Seestar stacked format: Stacked_<count>_..._<seconds>s_...
    const stackedMatch = image.filename.match(/Stacked_(\d+)_.*?_(\d+(?:\.\d+)?)s_/i);
    if (stackedMatch) {
      const frameCount = parseInt(stackedMatch[1], 10) || 0;
      const perFrameSeconds = parseFloat(stackedMatch[2]) || 0;
      return frameCount * perFrameSeconds;
    }

    // Fallback: just look for a simple exposure time pattern like "600s", "120sec"
    const simpleMatch = image.filename.match(/(\d+(?:\.\d+)?)\s*(?:s|sec)(?:\b|_|\.)/i);
    if (simpleMatch) {
      return parseFloat(simpleMatch[1]) || 0;
    }
  }

  return 0;
}

export default function TopTargetsDialog({
  open,
  onOpenChange,
  collections,
}: TopTargetsDialogProps) {
  const { data: images = [], isLoading } = useImages();
  const [sortBy, setSortBy] = useState<SortField>("exposure");
  const [catalogFilter, setCatalogFilter] = useState<CatalogFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");

  // Collect files dialog state
  const [collectDialogOpen, setCollectDialogOpen] = useState(false);
  const [selectedTarget, setSelectedTarget] = useState<TargetStats | null>(null);

  const handleCollectFiles = (target: TargetStats) => {
    setSelectedTarget(target);
    setCollectDialogOpen(true);
  };

  // Build a map of image IDs to their collections (non-observation only)
  const imageCollectionMap = useMemo(() => {
    const map = new Map<string, Collection[]>();
    // This would require knowing which images belong to which collections
    // For now, we'll use the collection_id on images
    for (const image of images) {
      if (image.collection_id) {
        const collection = collections.find((c) => c.id === image.collection_id);
        if (collection && getCollectionType(collection.template) !== "observation") {
          const existing = map.get(image.id) || [];
          existing.push(collection);
          map.set(image.id, existing);
        }
      }
    }
    return map;
  }, [images, collections]);

  // Aggregate targets from all images
  const targetStats = useMemo(() => {
    const statsMap = new Map<string, TargetStats>();

    for (const image of images) {
      // Parse annotations
      let annotations: CatalogObject[] = [];
      if (image.annotations) {
        try {
          annotations =
            typeof image.annotations === "string"
              ? JSON.parse(image.annotations)
              : image.annotations;
        } catch {
          // Skip malformed annotations
          continue;
        }
      }

      // Extract exposure time from metadata or filename
      const exposureSeconds = extractExposureSeconds(image);

      // Get collections this image belongs to (non-observation)
      const imageCollections = imageCollectionMap.get(image.id) || [];

      // Get the stacked image path from image.url
      const stackedPath = image.url || "";

      // Process each annotation
      for (const annotation of annotations) {
        if (!annotation.name) continue;

        const normalizedName = normalizeTargetName(annotation.name);
        const existing = statsMap.get(normalizedName);

        if (existing) {
          existing.imageCount++;
          existing.totalExposureSeconds += exposureSeconds;
          // Add unique collections
          for (const col of imageCollections) {
            if (!existing.inCollections.find((c) => c.id === col.id)) {
              existing.inCollections.push(col);
            }
          }
          // Track aliases
          if (
            annotation.name !== normalizedName &&
            !existing.aliases.includes(annotation.name)
          ) {
            existing.aliases.push(annotation.name);
          }
          // Add stacked path if not already present
          if (stackedPath && !existing.stackedPaths.includes(stackedPath)) {
            existing.stackedPaths.push(stackedPath);
          }
        } else {
          statsMap.set(normalizedName, {
            name: normalizedName,
            aliases:
              annotation.name !== normalizedName ? [annotation.name] : [],
            catalog: getCatalogFromName(normalizedName),
            objectType: annotation.objectType || "Unknown",
            imageCount: 1,
            totalExposureSeconds: exposureSeconds,
            inCollections: [...imageCollections],
            ra: annotation.ra || 0,
            dec: annotation.dec || 0,
            stackedPaths: stackedPath ? [stackedPath] : [],
          });
        }
      }
    }

    return Array.from(statsMap.values());
  }, [images, imageCollectionMap]);

  // Filter and sort targets
  const filteredTargets = useMemo(() => {
    let filtered = targetStats;

    // Apply catalog filter
    if (catalogFilter !== "all") {
      filtered = filtered.filter((t) => {
        const catalog = t.catalog.toLowerCase();
        if (catalogFilter === "messier") return catalog === "messier";
        if (catalogFilter === "ngc") return catalog === "ngc";
        if (catalogFilter === "ic") return catalog === "ic";
        if (catalogFilter === "other")
          return !["messier", "ngc", "ic"].includes(catalog);
        return true;
      });
    }

    // Apply search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (t) =>
          t.name.toLowerCase().includes(query) ||
          t.aliases.some((a) => a.toLowerCase().includes(query)) ||
          t.objectType.toLowerCase().includes(query)
      );
    }

    // Sort
    return filtered.sort((a, b) => {
      if (sortBy === "exposure")
        return b.totalExposureSeconds - a.totalExposureSeconds;
      if (sortBy === "images") return b.imageCount - a.imageCount;
      return a.name.localeCompare(b.name);
    });
  }, [targetStats, catalogFilter, searchQuery, sortBy]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="dark max-w-3xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Top Targets</DialogTitle>
          <DialogDescription>
            Aggregated statistics for astronomical targets across all your images
          </DialogDescription>
        </DialogHeader>

        {/* Controls */}
        <div className="flex gap-4 flex-wrap">
          <Input
            placeholder="Search targets..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-48 bg-slate-800 border-slate-600 text-white placeholder:text-slate-400"
          />
          <Select
            value={catalogFilter}
            onValueChange={(v) => setCatalogFilter(v as CatalogFilter)}
          >
            <SelectTrigger className="w-36 bg-slate-800 border-slate-600 text-white">
              <SelectValue placeholder="Filter catalog" />
            </SelectTrigger>
            <SelectContent className="dark bg-slate-800 border-slate-600">
              <SelectItem value="all" className="text-white focus:bg-slate-700 focus:text-white">All Catalogs</SelectItem>
              <SelectItem value="messier" className="text-white focus:bg-slate-700 focus:text-white">Messier</SelectItem>
              <SelectItem value="ngc" className="text-white focus:bg-slate-700 focus:text-white">NGC</SelectItem>
              <SelectItem value="ic" className="text-white focus:bg-slate-700 focus:text-white">IC</SelectItem>
              <SelectItem value="other" className="text-white focus:bg-slate-700 focus:text-white">Other</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={sortBy}
            onValueChange={(v) => setSortBy(v as SortField)}
          >
            <SelectTrigger className="w-40 bg-slate-800 border-slate-600 text-white">
              <SelectValue placeholder="Sort by" />
            </SelectTrigger>
            <SelectContent className="dark bg-slate-800 border-slate-600">
              <SelectItem value="exposure" className="text-white focus:bg-slate-700 focus:text-white">Total Exposure</SelectItem>
              <SelectItem value="images" className="text-white focus:bg-slate-700 focus:text-white">Image Count</SelectItem>
              <SelectItem value="name" className="text-white focus:bg-slate-700 focus:text-white">Name</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Results */}
        <div className="flex-1 overflow-auto mt-4">
          {isLoading ? (
            <p className="text-muted-foreground text-center py-8">
              Loading images...
            </p>
          ) : filteredTargets.length === 0 ? (
            <p className="text-muted-foreground text-center py-8">
              No targets found. Plate solve some images to see target statistics.
            </p>
          ) : (
            <div className="space-y-2">
              {filteredTargets.slice(0, 50).map((target, idx) => (
                <div
                  key={target.name}
                  className={cn(
                    "flex items-center gap-4 p-3 rounded-lg",
                    "bg-slate-800/50 hover:bg-slate-700/50 transition-colors"
                  )}
                >
                  <div className="text-2xl font-bold text-slate-400 w-8 text-center">
                    {idx + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-white">{target.name}</span>
                      <Badge variant="outline" className="text-xs text-slate-300 border-slate-500">
                        {target.catalog}
                      </Badge>
                      <Badge
                        variant="secondary"
                        className="text-xs text-slate-300 bg-slate-700"
                      >
                        {target.objectType}
                      </Badge>
                    </div>
                    {target.aliases.length > 0 && (
                      <div className="text-xs text-slate-400 mt-0.5">
                        Also: {target.aliases.join(", ")}
                      </div>
                    )}
                    {target.inCollections.length > 0 && (
                      <div className="flex gap-1 mt-1 flex-wrap">
                        {target.inCollections.slice(0, 3).map((col) => (
                          <Badge
                            key={col.id}
                            variant="outline"
                            className="text-xs bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
                          >
                            {col.name}
                          </Badge>
                        ))}
                        {target.inCollections.length > 3 && (
                          <Badge variant="outline" className="text-xs text-slate-300">
                            +{target.inCollections.length - 3}
                          </Badge>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="text-right flex items-center gap-3">
                    <div>
                      <div className="font-semibold text-white">
                        {formatDuration(target.totalExposureSeconds)}
                      </div>
                      <div className="text-xs text-slate-400">
                        {target.imageCount} image{target.imageCount !== 1 ? "s" : ""}
                      </div>
                    </div>
                    {target.stackedPaths.length > 0 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleCollectFiles(target)}
                        className="text-slate-400 hover:text-white hover:bg-slate-700"
                        title="Collect raw subframe files"
                      >
                        <FolderDown className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
              {filteredTargets.length > 50 && (
                <p className="text-center text-muted-foreground text-sm py-4">
                  Showing top 50 of {filteredTargets.length} targets
                </p>
              )}
            </div>
          )}
        </div>
      </DialogContent>

      {/* Collect Files Dialog */}
      {selectedTarget && (
        <CollectFilesDialog
          open={collectDialogOpen}
          onOpenChange={setCollectDialogOpen}
          targetName={selectedTarget.name}
          stackedPaths={selectedTarget.stackedPaths}
        />
      )}
    </Dialog>
  );
}
