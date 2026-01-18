/**
 * Catalog Collection View - Displays a catalog collection (Messier, Caldwell, etc.)
 *
 * Shows a grid of all catalog objects with indicators for which ones have images.
 */

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Check, Clock, ImageIcon, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getCatalog,
  matchesCatalogEntry,
  type CatalogEntry,
} from "@/lib/catalogs";
import { NGC_TO_MESSIER } from "@/lib/models";
import type { Collection, Image, CatalogObject } from "@/lib/tauri/commands";
import CatalogObjectDialog, {
  type ImageWithMeta,
  extractEquipment,
  extractExposureSeconds,
} from "./CatalogObjectDialog";

interface CatalogCollectionViewProps {
  collection: Collection;
  allImages: Image[];
  allCollections: Collection[];
}

type SortField = "number" | "exposure" | "type" | "constellation";
type FilterMode = "all" | "captured" | "missing";

/**
 * Normalize a name to match catalog entries
 */
function normalizeObjectName(name: string): string {
  // Check NGC to Messier mapping
  const messierName = NGC_TO_MESSIER[name as keyof typeof NGC_TO_MESSIER];
  if (messierName) return messierName;
  return name;
}

/**
 * Format seconds as human-readable duration
 */
function formatDuration(seconds: number): string {
  if (seconds === 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

export default function CatalogCollectionView({
  collection,
  allImages,
  allCollections,
}: CatalogCollectionViewProps) {
  const [selectedObject, setSelectedObject] = useState<CatalogEntry | null>(
    null
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortField>("number");
  const [filterMode, setFilterMode] = useState<FilterMode>("all");

  // Get catalog definition
  const catalog = useMemo(() => {
    return getCatalog(collection.template || "");
  }, [collection.template]);

  // Build a map of catalog objects to their images
  const objectImageMap = useMemo(() => {
    if (!catalog) return new Map<string, ImageWithMeta[]>();

    const map = new Map<string, ImageWithMeta[]>();

    // Initialize all catalog entries with empty arrays
    for (const entry of catalog.objects) {
      map.set(entry.id, []);
    }

    // Go through all images and match them to catalog entries
    for (const image of allImages) {
      if (!image.annotations) continue;

      let annotations: CatalogObject[] = [];
      try {
        annotations =
          typeof image.annotations === "string"
            ? JSON.parse(image.annotations)
            : image.annotations;
      } catch {
        continue;
      }

      const exposureSeconds = extractExposureSeconds(image);
      const equipment = extractEquipment(image);

      // Find the collection this image belongs to
      const imageCollection = allCollections.find(
        (c) => c.id === image.collection_id
      );

      for (const annotation of annotations) {
        if (!annotation.name) continue;

        const normalizedName = normalizeObjectName(annotation.name);

        // Find matching catalog entry
        for (const entry of catalog.objects) {
          if (
            matchesCatalogEntry(annotation.name, entry) ||
            matchesCatalogEntry(normalizedName, entry)
          ) {
            const existing = map.get(entry.id) || [];
            // Avoid duplicates
            if (!existing.find((e) => e.image.id === image.id)) {
              existing.push({
                image,
                exposureSeconds,
                equipment,
                collection: imageCollection,
              });
              map.set(entry.id, existing);
            }
            break;
          }
        }
      }
    }

    return map;
  }, [catalog, allImages, allCollections]);

  // Compute statistics
  const stats = useMemo(() => {
    if (!catalog) return { total: 0, captured: 0, totalExposure: 0 };

    let captured = 0;
    let totalExposure = 0;

    for (const [, images] of objectImageMap) {
      if (images.length > 0) {
        captured++;
        totalExposure += images.reduce(
          (sum, img) => sum + img.exposureSeconds,
          0
        );
      }
    }

    return {
      total: catalog.objects.length,
      captured,
      totalExposure,
    };
  }, [catalog, objectImageMap]);

  // Filter and sort objects
  const filteredObjects = useMemo(() => {
    if (!catalog) return [];

    let filtered = catalog.objects;

    // Apply search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (obj) =>
          obj.name.toLowerCase().includes(query) ||
          obj.id.toLowerCase().includes(query) ||
          obj.commonName?.toLowerCase().includes(query) ||
          obj.constellation.toLowerCase().includes(query) ||
          obj.type.toLowerCase().includes(query) ||
          obj.aliases?.some((a) => a.toLowerCase().includes(query))
      );
    }

    // Apply capture filter
    if (filterMode === "captured") {
      filtered = filtered.filter(
        (obj) => (objectImageMap.get(obj.id) || []).length > 0
      );
    } else if (filterMode === "missing") {
      filtered = filtered.filter(
        (obj) => (objectImageMap.get(obj.id) || []).length === 0
      );
    }

    // Sort
    return [...filtered].sort((a, b) => {
      if (sortBy === "number") {
        // Extract number from ID (e.g., "M31" -> 31)
        const numA = parseInt(a.id.replace(/\D/g, ""), 10) || 0;
        const numB = parseInt(b.id.replace(/\D/g, ""), 10) || 0;
        return numA - numB;
      }
      if (sortBy === "exposure") {
        const expA = (objectImageMap.get(a.id) || []).reduce(
          (sum, img) => sum + img.exposureSeconds,
          0
        );
        const expB = (objectImageMap.get(b.id) || []).reduce(
          (sum, img) => sum + img.exposureSeconds,
          0
        );
        return expB - expA;
      }
      if (sortBy === "type") {
        return a.type.localeCompare(b.type);
      }
      if (sortBy === "constellation") {
        return a.constellation.localeCompare(b.constellation);
      }
      return 0;
    });
  }, [catalog, searchQuery, filterMode, sortBy, objectImageMap]);

  // Handle object click
  const handleObjectClick = (object: CatalogEntry) => {
    setSelectedObject(object);
    setDialogOpen(true);
  };

  // Get images for selected object
  const selectedObjectImages = useMemo(() => {
    if (!selectedObject) return [];
    return objectImageMap.get(selectedObject.id) || [];
  }, [selectedObject, objectImageMap]);

  if (!catalog) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        Unknown catalog type: {collection.template}
      </div>
    );
  }

  const completionPercent = Math.round((stats.captured / stats.total) * 100);

  return (
    <div className="space-y-6">
      {/* Header with Stats */}
      <div className="bg-slate-800/50 rounded-lg p-4 space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold text-white">{catalog.name}</h2>
            <p className="text-sm text-slate-400 mt-1">{catalog.description}</p>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <div className="text-2xl font-bold text-white">
                {stats.captured}/{stats.total}
              </div>
              <div className="text-xs text-slate-400">objects captured</div>
            </div>
            <div className="text-right">
              <div className="text-2xl font-bold text-teal-400">
                {formatDuration(stats.totalExposure)}
              </div>
              <div className="text-xs text-slate-400">total exposure</div>
            </div>
          </div>
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between text-sm">
            <span className="text-slate-400">Completion</span>
            <span className="text-white font-medium">{completionPercent}%</span>
          </div>
          <Progress value={completionPercent} className="h-2" />
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input
            placeholder="Search objects..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 bg-slate-800 border-slate-600 text-white placeholder:text-slate-400"
          />
        </div>
        <Select value={filterMode} onValueChange={(v) => setFilterMode(v as FilterMode)}>
          <SelectTrigger className="w-36 bg-slate-800 border-slate-600 text-white">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="dark bg-slate-800 border-slate-600">
            <SelectItem value="all" className="text-white focus:bg-slate-700 focus:text-white">
              All Objects
            </SelectItem>
            <SelectItem value="captured" className="text-white focus:bg-slate-700 focus:text-white">
              Captured
            </SelectItem>
            <SelectItem value="missing" className="text-white focus:bg-slate-700 focus:text-white">
              Not Captured
            </SelectItem>
          </SelectContent>
        </Select>
        <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortField)}>
          <SelectTrigger className="w-40 bg-slate-800 border-slate-600 text-white">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="dark bg-slate-800 border-slate-600">
            <SelectItem value="number" className="text-white focus:bg-slate-700 focus:text-white">
              Catalog Number
            </SelectItem>
            <SelectItem value="exposure" className="text-white focus:bg-slate-700 focus:text-white">
              Total Exposure
            </SelectItem>
            <SelectItem value="type" className="text-white focus:bg-slate-700 focus:text-white">
              Object Type
            </SelectItem>
            <SelectItem value="constellation" className="text-white focus:bg-slate-700 focus:text-white">
              Constellation
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Results count */}
      <div className="text-sm text-slate-400">
        Showing {filteredObjects.length} of {catalog.objects.length} objects
      </div>

      {/* Object Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
        {filteredObjects.map((object) => {
          const images = objectImageMap.get(object.id) || [];
          const hasCaptured = images.length > 0;
          const totalExposure = images.reduce(
            (sum, img) => sum + img.exposureSeconds,
            0
          );
          const previewImage = images[0]?.image;

          return (
            <button
              key={object.id}
              onClick={() => handleObjectClick(object)}
              className={cn(
                "relative rounded-lg overflow-hidden text-left transition-all",
                "border hover:scale-[1.02] hover:shadow-lg",
                hasCaptured
                  ? "border-teal-500/50 bg-slate-800/80"
                  : "border-slate-700 bg-slate-800/30 hover:border-slate-600"
              )}
            >
              {/* Preview Image or Placeholder */}
              <div className="aspect-square bg-slate-700/50 relative">
                {previewImage?.thumbnail ? (
                  <img
                    src={previewImage.thumbnail}
                    alt={object.name}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <span className="text-3xl font-bold text-slate-600">
                      {object.id}
                    </span>
                  </div>
                )}

                {/* Captured indicator */}
                {hasCaptured && (
                  <div className="absolute top-2 right-2 w-6 h-6 rounded-full bg-teal-500 flex items-center justify-center">
                    <Check className="w-4 h-4 text-white" />
                  </div>
                )}

                {/* Exposure time badge */}
                {totalExposure > 0 && (
                  <div className="absolute bottom-2 left-2 bg-black/70 rounded px-1.5 py-0.5 flex items-center gap-1">
                    <Clock className="w-3 h-3 text-teal-400" />
                    <span className="text-xs text-white">
                      {formatDuration(totalExposure)}
                    </span>
                  </div>
                )}

                {/* Image count */}
                {images.length > 1 && (
                  <div className="absolute bottom-2 right-2 bg-black/70 rounded px-1.5 py-0.5 flex items-center gap-1">
                    <ImageIcon className="w-3 h-3 text-slate-400" />
                    <span className="text-xs text-white">{images.length}</span>
                  </div>
                )}
              </div>

              {/* Object Info */}
              <div className="p-2 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-white text-sm">
                    {object.id}
                  </span>
                  {object.magnitude && (
                    <span className="text-xs text-slate-400">
                      mag {object.magnitude}
                    </span>
                  )}
                </div>
                {object.commonName && (
                  <div className="text-xs text-slate-400 truncate">
                    {object.commonName}
                  </div>
                )}
                <div className="flex items-center gap-1 flex-wrap">
                  <Badge
                    variant="outline"
                    className="text-[10px] px-1.5 py-0 h-4 bg-slate-700/50 text-slate-300 border-slate-600"
                  >
                    {object.type.split(" ")[0]}
                  </Badge>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Empty state */}
      {filteredObjects.length === 0 && (
        <div className="text-center py-12 text-slate-400">
          <Search className="w-12 h-12 mx-auto mb-3 opacity-50" />
          <p>No objects match your search</p>
          <Button
            variant="ghost"
            onClick={() => {
              setSearchQuery("");
              setFilterMode("all");
            }}
            className="mt-2"
          >
            Clear filters
          </Button>
        </div>
      )}

      {/* Object Detail Dialog */}
      <CatalogObjectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        object={selectedObject}
        images={selectedObjectImages}
      />
    </div>
  );
}
