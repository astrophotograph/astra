/**
 * Images Page - Browse all images, most recent first, paginated
 * Supports multi-select for batch operations (regenerate preview, plate solve)
 */

import { useState, useMemo, useCallback, useEffect } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { listen } from "@tauri-apps/api/event";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  Compass,
  ImageIcon,
  Loader2,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useImages, imageKeys } from "@/hooks/use-images";
import { imageApi, plateSolveApi, type Image } from "@/lib/tauri/commands";

const PAGE_SIZE = 60;

const STRETCH_PRESETS = [
  { label: "10% Bg, 3 sigma", bgPercent: 0.10, sigma: 3.0 },
  { label: "15% Bg, 3 sigma", bgPercent: 0.15, sigma: 3.0 },
  { label: "20% Bg, 3 sigma", bgPercent: 0.20, sigma: 3.0 },
  { label: "30% Bg, 2 sigma", bgPercent: 0.30, sigma: 2.0 },
];

function getDefaultStretch(): { bgPercent: number; sigma: number } {
  try {
    const saved = localStorage.getItem("auto_import_config");
    if (saved) {
      const cfg = JSON.parse(saved);
      return { bgPercent: cfg.stretchBgPercent ?? 0.15, sigma: cfg.stretchSigma ?? 3.0 };
    }
  } catch { /* ignore */ }
  return { bgPercent: 0.15, sigma: 3.0 };
}

export default function Images() {
  const queryClient = useQueryClient();
  const { data: allImages = [], isLoading } = useImages();
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set());
  const [selectMode, setSelectMode] = useState(false);

  // Refresh when auto-import adds new images
  useEffect(() => {
    let cancelled = false;
    const unlisten = listen("auto-import-status", (event: any) => {
      if (!cancelled && event.payload?.lastImportCount > 0) {
        queryClient.invalidateQueries({ queryKey: imageKeys.lists() });
      }
    });

    // Also poll periodically as fallback (every 10s)
    const interval = setInterval(() => {
      if (!cancelled) {
        queryClient.invalidateQueries({ queryKey: imageKeys.lists() });
      }
    }, 10000);

    return () => {
      cancelled = true;
      clearInterval(interval);
      unlisten.then((fn) => fn());
    };
  }, [queryClient]);

  // Sort by created_at descending, filter by search
  const filtered = useMemo(() => {
    let images = [...allImages].sort(
      (a, b) => b.created_at.localeCompare(a.created_at)
    );

    if (search) {
      const q = search.toLowerCase();
      images = images.filter(
        (img) =>
          img.filename.toLowerCase().includes(q) ||
          img.summary?.toLowerCase().includes(q) ||
          img.description?.toLowerCase().includes(q)
      );
    }

    return images;
  }, [allImages, search]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const pageImages = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const handleSearch = (value: string) => {
    setSearch(value);
    setPage(0);
  };

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const selectAllOnPage = useCallback(() => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      pageImages.forEach((img) => next.add(img.id));
      return next;
    });
  }, [pageImages]);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setSelectMode(false);
  }, []);

  const hasFits = (img: Image) =>
    !!img.fits_url ||
    img.url?.toLowerCase().endsWith(".fit") ||
    img.url?.toLowerCase().endsWith(".fits");

  // Batch regenerate previews
  const handleBatchRegenerate = useCallback(
    async (bgPercent: number, sigma: number) => {
      const ids = [...selectedIds].filter((id) => {
        const img = allImages.find((i) => i.id === id);
        return img && hasFits(img);
      });

      if (ids.length === 0) {
        toast.error("No selected images have FITS files");
        return;
      }

      toast.info(`Regenerating ${ids.length} preview${ids.length !== 1 ? "s" : ""}...`);

      let success = 0;
      let failed = 0;

      for (const id of ids) {
        setProcessingIds((prev) => new Set(prev).add(id));
        try {
          await imageApi.regeneratePreview(id, bgPercent, sigma);
          success++;
          queryClient.invalidateQueries({ queryKey: imageKeys.lists() });
        } catch (e) {
          failed++;
          console.error(`Failed to regenerate ${id}:`, e);
        } finally {
          setProcessingIds((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        }
      }

      if (failed > 0) {
        toast.warning(`Regenerated ${success}, failed ${failed}`);
      } else {
        toast.success(`Regenerated ${success} preview${success !== 1 ? "s" : ""}`);
      }
    },
    [selectedIds, allImages, queryClient]
  );

  // Batch plate solve
  const handleBatchPlateSolve = useCallback(async () => {
    const solver = localStorage.getItem("plate_solve_solver") || "nova";
    const apiKey = localStorage.getItem("astrometry_api_key") || "";
    const apiUrl = localStorage.getItem("local_astrometry_url") || "";

    if (solver === "nova" && !apiKey) {
      toast.error("No API key configured for plate solving. Set it in Settings.");
      return;
    }

    const ids = [...selectedIds].filter((id) => {
      const img = allImages.find((i) => i.id === id);
      return img && hasFits(img);
    });

    if (ids.length === 0) {
      toast.error("No selected images have FITS files");
      return;
    }

    toast.info(`Plate solving ${ids.length} image${ids.length !== 1 ? "s" : ""}...`);

    let success = 0;
    let failed = 0;

    for (const id of ids) {
      setProcessingIds((prev) => new Set(prev).add(id));
      try {
        const result = await plateSolveApi.solve({
          id,
          solver,
          apiKey: apiKey || undefined,
          apiUrl: apiUrl || undefined,
          queryCatalogs: true,
          timeout: 300,
        });
        if (result.success) {
          success++;
          queryClient.invalidateQueries({ queryKey: imageKeys.lists() });
        } else {
          failed++;
        }
      } catch (e) {
        failed++;
        console.error(`Failed to plate solve ${id}:`, e);
      } finally {
        setProcessingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    }

    if (failed > 0) {
      toast.warning(`Solved ${success}, failed ${failed}`);
    } else {
      toast.success(`Plate solved ${success} image${success !== 1 ? "s" : ""}`);
    }
  }, [selectedIds, allImages, queryClient]);

  const selectedCount = selectedIds.size;
  const defaultStretch = getDefaultStretch();
  const isProcessing = processingIds.size > 0;

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 to-slate-950 p-6 space-y-6">
      {/* Breadcrumb */}
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link to="/">Home</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Images</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">All Images</h1>
          <p className="text-sm text-gray-400 mt-1">
            {allImages.length} total image{allImages.length !== 1 ? "s" : ""}
            {search && ` — ${filtered.length} matching`}
          </p>
        </div>
        <Button
          variant={selectMode ? "default" : "outline"}
          size="sm"
          onClick={() => {
            if (selectMode) {
              clearSelection();
            } else {
              setSelectMode(true);
            }
          }}
        >
          <CheckSquare className="w-4 h-4 mr-2" />
          {selectMode ? "Done" : "Select"}
        </Button>
      </div>

      {/* Selection toolbar */}
      {selectMode && (
        <div className="flex items-center gap-3 bg-slate-800/95 backdrop-blur rounded-lg px-4 py-2.5 sticky top-2 z-30">
          <span className="text-sm text-slate-300">
            {selectedCount} selected
          </span>
          <Button variant="ghost" size="sm" onClick={selectAllOnPage}>
            Select page
          </Button>
          {selectedCount > 0 && (
            <>
              <Button variant="ghost" size="sm" onClick={clearSelection}>
                <X className="w-3 h-3 mr-1" />
                Clear
              </Button>
              <div className="h-4 w-px bg-slate-600" />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" disabled={isProcessing}>
                    <RefreshCw className={`w-3 h-3 mr-1 ${isProcessing ? "animate-spin" : ""}`} />
                    Regenerate Preview
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  {STRETCH_PRESETS.map((preset) => {
                    const isDefault =
                      preset.bgPercent === defaultStretch.bgPercent &&
                      preset.sigma === defaultStretch.sigma;
                    return (
                      <DropdownMenuItem
                        key={preset.label}
                        onClick={() =>
                          handleBatchRegenerate(preset.bgPercent, preset.sigma)
                        }
                      >
                        {preset.label}
                        {isDefault ? " *" : ""}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                variant="outline"
                size="sm"
                onClick={handleBatchPlateSolve}
                disabled={isProcessing}
              >
                <Compass className={`w-3 h-3 mr-1 ${isProcessing ? "animate-spin" : ""}`} />
                Plate Solve
              </Button>
            </>
          )}
        </div>
      )}

      {/* Search + Pagination controls */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-[400px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input
            placeholder="Search images..."
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            className="pl-9 bg-slate-800 border-slate-600 text-white placeholder:text-slate-400"
          />
        </div>

        {totalPages > 1 && (
          <div className="flex items-center gap-2 ml-auto">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <span className="text-sm text-slate-400">
              Page {page + 1} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        )}
      </div>

      {/* Image Grid */}
      {isLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
          {Array.from({ length: 24 }).map((_, i) => (
            <Skeleton key={i} className="aspect-square rounded-lg" />
          ))}
        </div>
      ) : pageImages.length === 0 ? (
        <div className="text-center py-12 bg-slate-800/50 rounded-lg">
          <ImageIcon className="w-12 h-12 mx-auto mb-4 text-gray-500" />
          <p className="text-white">
            {search ? "No images match your search" : "No images yet"}
          </p>
          <p className="text-gray-400 text-sm mt-1">
            {search
              ? "Try a different search term"
              : "Import images via bulk scan or auto-import"}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
          {pageImages.map((image) => (
            <ImageCard
              key={image.id}
              image={image}
              selectMode={selectMode}
              selected={selectedIds.has(image.id)}
              processing={processingIds.has(image.id)}
              onToggleSelect={() => toggleSelect(image.id)}
            />
          ))}
        </div>
      )}

      {/* Bottom pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
          >
            <ChevronLeft className="w-4 h-4 mr-1" />
            Previous
          </Button>
          <span className="text-sm text-slate-400 px-4">
            {page * PAGE_SIZE + 1}–
            {Math.min((page + 1) * PAGE_SIZE, filtered.length)} of{" "}
            {filtered.length}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
          >
            Next
            <ChevronRight className="w-4 h-4 ml-1" />
          </Button>
        </div>
      )}
    </div>
  );
}

function ImageCard({
  image,
  selectMode,
  selected,
  processing,
  onToggleSelect,
}: {
  image: Image;
  selectMode: boolean;
  selected: boolean;
  processing: boolean;
  onToggleSelect: () => void;
}) {
  const thumbnailSrc = image.thumbnail || undefined;
  const title = image.summary || image.filename;

  // Count catalog objects from annotations
  const objectCount = useMemo(() => {
    if (!image.annotations) return 0;
    try {
      const parsed =
        typeof image.annotations === "string"
          ? JSON.parse(image.annotations)
          : image.annotations;
      return Array.isArray(parsed) ? parsed.length : 0;
    } catch {
      return 0;
    }
  }, [image.annotations]);

  const handleClick = (e: React.MouseEvent) => {
    if (selectMode) {
      e.preventDefault();
      onToggleSelect();
    }
  };

  return (
    <Link
      to={selectMode ? "#" : `/i/${image.id}`}
      onClick={handleClick}
      className={`group relative aspect-square rounded-lg overflow-hidden bg-slate-800 transition-all ${
        selected
          ? "ring-2 ring-indigo-500"
          : "hover:ring-2 hover:ring-indigo-500/50"
      }`}
    >
      {/* Thumbnail */}
      {thumbnailSrc ? (
        <img
          src={thumbnailSrc}
          alt={title}
          className={`w-full h-full object-cover transition-opacity ${
            selected ? "opacity-75" : ""
          }`}
          loading="lazy"
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center">
          <ImageIcon className="w-8 h-8 text-slate-600" />
        </div>
      )}

      {/* Processing spinner overlay */}
      {processing && (
        <div className="absolute inset-0 z-20 bg-black/60 flex items-center justify-center">
          <Loader2 className="w-6 h-6 animate-spin text-indigo-400" />
        </div>
      )}

      {/* Selection checkbox */}
      {selectMode && (
        <div className="absolute top-1.5 left-1.5 z-10">
          <Checkbox
            checked={selected}
            onCheckedChange={() => onToggleSelect()}
            className="border-white/60 data-[state=checked]:bg-indigo-500 data-[state=checked]:border-indigo-500"
          />
        </div>
      )}

      {/* Object count badge */}
      {objectCount > 0 && (
        <div className="absolute top-1.5 right-1.5 bg-indigo-600/90 text-white text-[10px] font-medium px-1.5 py-0.5 rounded-full leading-none">
          {objectCount}
        </div>
      )}

      {/* Hover info */}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <p className="text-xs text-white truncate">{title}</p>
        <p className="text-xs text-slate-400">
          {(() => {
            if (image.metadata) {
              try {
                const meta = JSON.parse(image.metadata);
                const raw = meta["DATE-OBS"] || meta["date-obs"];
                if (raw) {
                  const m = String(raw).match(/CharacterString\("([^"]*)"\)/);
                  const dateStr = m ? m[1] : (String(raw) !== "None" ? String(raw) : null);
                  if (dateStr) {
                    const d = new Date(dateStr);
                    if (!isNaN(d.getTime())) return d.toLocaleDateString();
                  }
                }
              } catch { /* ignore */ }
            }
            return new Date(image.created_at).toLocaleDateString();
          })()}
        </p>
      </div>
    </Link>
  );
}
