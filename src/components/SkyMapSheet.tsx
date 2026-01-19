/**
 * Sky Map Sheet - Slide-out panel showing sky coverage with footprint overlays
 *
 * Displays an Aladin Lite sky map with polygons representing the field of view
 * of each plate-solved image. Clicking on a footprint shows image details.
 */

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Clock, Compass, ExternalLink, ImageIcon, Loader2, X } from "lucide-react";
import { plateSolveApi } from "@/lib/tauri/commands";
import type { UnsolvedImage } from "@/hooks/use-sky-map-images";
import {
  type ImageFootprint,
  calculateBoundingBox,
  calculateCorners,
  pointInPolygon,
  getCollectionColor,
  formatDuration,
} from "@/lib/sky-map-utils";

// Aladin types - use unknown and cast as needed to avoid conflicts with AladinLite.tsx
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AladinInstance = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OverlayInstance = any;

interface SkyMapSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  images: ImageFootprint[];
  title?: string;
  collectionColors?: Record<string, string>;
  unsolvedImages?: UnsolvedImage[];
  onSolveComplete?: () => void;
}

export default function SkyMapSheet({
  open,
  onOpenChange,
  images,
  title = "Sky Coverage",
  collectionColors,
  unsolvedImages = [],
  onSolveComplete,
}: SkyMapSheetProps) {
  const divRef = useRef<HTMLDivElement>(null);
  const aladinRef = useRef<AladinInstance | null>(null);
  const overlayRef = useRef<OverlayInstance | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const initAttempted = useRef(false);
  const [selectedImage, setSelectedImage] = useState<ImageFootprint | null>(null);
  const [popupPosition, setPopupPosition] = useState<{ x: number; y: number } | null>(null);

  // Batch plate solve state
  const [batchDialogOpen, setBatchDialogOpen] = useState(false);
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("astrometry_api_key") || "");
  const [maxCount, setMaxCount] = useState(50);
  const [parallelCount, setParallelCount] = useState(() => {
    const saved = localStorage.getItem("plate_solve_parallel");
    return saved ? parseInt(saved, 10) : 1;
  });
  const [isSolving, setIsSolving] = useState(false);
  const [solveProgress, setSolveProgress] = useState({ current: 0, total: 0, successCount: 0, failCount: 0, avgSolveTime: 0 });
  const cancelRef = useRef(false);

  // Precomputed corners for hit testing
  const footprintCorners = useRef<Map<string, Array<[number, number]>>>(new Map());

  // Filter out images that have previously failed plate solving
  const solvableImages = useMemo(() => {
    return unsolvedImages.filter(img => !img.hasFailed);
  }, [unsolvedImages]);

  const skippedCount = unsolvedImages.length - solvableImages.length;

  // Load Aladin Lite script when sheet opens
  useEffect(() => {
    if (!open) return;

    if (window.A) {
      setIsLoaded(true);
      return;
    }

    // Check for existing CSS
    const existingLink = document.querySelector('link[href*="aladin"]');
    if (!existingLink) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "https://aladin.cds.unistra.fr/AladinLite/api/v3/latest/aladin.min.css";
      document.head.appendChild(link);
    }

    // Check for existing script
    const existingScript = document.querySelector('script[src*="aladin"]');
    if (existingScript) {
      const checkLoaded = setInterval(() => {
        if (window.A) {
          setIsLoaded(true);
          clearInterval(checkLoaded);
        }
      }, 100);
      return () => clearInterval(checkLoaded);
    }

    const script = document.createElement("script");
    script.src = "https://aladin.cds.unistra.fr/AladinLite/api/v3/latest/aladin.js";
    script.async = true;
    script.charset = "utf-8";
    script.onload = () => {
      setTimeout(() => setIsLoaded(true), 100);
    };
    script.onerror = () => {
      setLoadError("Failed to load Aladin Lite script");
    };
    document.head.appendChild(script);

    return () => {};
  }, [open]);

  // Get color for a footprint
  const getFootprintColor = useCallback(
    (fp: ImageFootprint, index: number): string => {
      if (collectionColors && fp.collectionId) {
        return collectionColors[fp.collectionId] ?? getCollectionColor(fp.collectionId, index);
      }
      // Single color for single collection view
      return "#00ff88";
    },
    [collectionColors]
  );

  // Initialize Aladin and draw footprints
  useEffect(() => {
    if (!open || !isLoaded || !divRef.current || images.length === 0) return;

    const initAladin = async () => {
      if (!window.A) {
        setLoadError("Aladin Lite library not available");
        return;
      }

      try {
        await window.A.init;

        // Calculate initial view
        const bounds = calculateBoundingBox(images);

        // Initialize Aladin if not already done
        if (!aladinRef.current) {
          aladinRef.current = window.A.aladin(divRef.current!, {
            survey: "P/DSS2/color",
            fov: bounds.fov,
            target: `${bounds.ra} ${bounds.dec}`,
            cooFrame: "ICRS",
            showReticle: true,
            showZoomControl: true,
            showFullscreenControl: true,
            showLayersControl: false,
            showGotoControl: false,
            showShareControl: false,
            reticleColor: "#ffffff",
            reticleSize: 18,
          });

          // Add click handler
          aladinRef.current.on("click", (e: { ra?: number; dec?: number; x?: number; y?: number }) => {
            if (e?.ra != null && e?.dec != null) {
              handleMapClick(e.ra, e.dec, e.x ?? 0, e.y ?? 0);
            }
          });
        } else {
          // Update view for existing Aladin instance
          aladinRef.current.gotoRaDec(bounds.ra, bounds.dec);
          aladinRef.current.setFoV(bounds.fov);
        }

        // Draw footprints
        drawFootprints();
      } catch (error) {
        console.error("Error initializing Aladin:", error);
        setLoadError(`Failed to initialize: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    // Small delay to ensure DOM is ready
    const timer = setTimeout(initAladin, 100);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isLoaded, images]);

  // Draw footprint polygons on the map
  const drawFootprints = useCallback(() => {
    if (!aladinRef.current || !window.A) return;

    // Remove existing overlay
    if (overlayRef.current) {
      try {
        aladinRef.current.removeOverlay(overlayRef.current);
      } catch {
        // Ignore removal errors
      }
    }

    // Create new overlay
    const overlay = window.A.graphicOverlay({
      color: "#00ff88",
      lineWidth: 2,
      name: "Image Footprints",
    });

    aladinRef.current.addOverlay(overlay);
    overlayRef.current = overlay;

    // Clear corners cache
    footprintCorners.current.clear();

    // Draw each footprint
    images.forEach((fp, index) => {
      const color = getFootprintColor(fp, index);
      const corners = calculateCorners(
        fp.centerRa,
        fp.centerDec,
        fp.widthDeg,
        fp.heightDeg,
        fp.rotation
      );

      // Store corners for hit testing
      footprintCorners.current.set(fp.id, corners);

      try {
        const polygon = window.A.polygon(corners, {
          color,
          lineWidth: 2,
          fillColor: color,
          fillOpacity: 0.2,
        });

        overlay.addFootprints(polygon);
      } catch (error) {
        console.error(`Error drawing footprint for ${fp.filename}:`, error);
      }
    });
  }, [images, getFootprintColor]);

  // Handle clicks on the map
  const handleMapClick = (ra: number, dec: number, x: number, y: number) => {
    // Check which footprint was clicked (if any)
    for (const fp of images) {
      const corners = footprintCorners.current.get(fp.id);
      if (corners && pointInPolygon(ra, dec, corners)) {
        setSelectedImage(fp);
        setPopupPosition({ x, y });
        return;
      }
    }

    // Clicked outside any footprint - close popup
    setSelectedImage(null);
    setPopupPosition(null);
  };

  // Close popup
  const closePopup = () => {
    setSelectedImage(null);
    setPopupPosition(null);
  };

  // Handle batch plate solve
  const handleBatchPlateSolve = async () => {
    if (!apiKey) {
      toast.error("Please enter an Astrometry.net API key");
      return;
    }

    if (solvableImages.length === 0) {
      if (skippedCount > 0) {
        toast.info(`All images are either solved or have previously failed (${skippedCount} skipped)`);
      } else {
        toast.info("All images are already plate solved");
      }
      return;
    }

    // Save settings to localStorage
    localStorage.setItem("astrometry_api_key", apiKey);
    localStorage.setItem("plate_solve_parallel", parallelCount.toString());

    // Reset cancel flag
    cancelRef.current = false;

    setIsSolving(true);
    setBatchDialogOpen(false);

    const localApiUrl = localStorage.getItem("local_astrometry_url") || undefined;
    const imagesToSolve = solvableImages.slice(0, maxCount);
    const totalCount = imagesToSolve.length;
    let successCount = 0;
    let failCount = 0;
    let completedCount = 0;
    let queueIndex = 0; // Next image to process
    let totalSolveTime = 0; // Total time spent solving (in seconds)

    const effectiveParallel = Math.max(1, Math.min(parallelCount, 10));

    // Build a map of collection ID to solved image coordinates for fallback hints
    const collectionHints = new Map<string, { ra: number; dec: number }>();
    for (const fp of images) {
      if (fp.collectionId && !collectionHints.has(fp.collectionId)) {
        collectionHints.set(fp.collectionId, { ra: fp.centerRa, dec: fp.centerDec });
      }
    }

    // Update progress display
    const updateProgress = () => {
      const avgSolveTime = completedCount > 0 ? totalSolveTime / completedCount : 0;
      setSolveProgress({
        current: completedCount,
        total: totalCount,
        successCount,
        failCount,
        avgSolveTime,
      });
    };

    // Worker function that pulls from queue
    const worker = async (): Promise<void> => {
      while (!cancelRef.current) {
        // Get next image from queue
        const index = queueIndex++;
        if (index >= imagesToSolve.length) {
          break; // No more images
        }

        const img = imagesToSolve[index];

        // Determine coordinate hints:
        // 1. Use metadata hints if available
        // 2. Fall back to coordinates from a solved image in same collection
        let hintRa = img.hintRa;
        let hintDec = img.hintDec;

        if (hintRa === undefined || hintDec === undefined) {
          const collectionHint = collectionHints.get(img.collectionId);
          if (collectionHint) {
            hintRa = collectionHint.ra;
            hintDec = collectionHint.dec;
          }
        }

        const startTime = Date.now();
        try {
          const result = await plateSolveApi.solve({
            id: img.id,
            solver: "nova",
            apiKey,
            apiUrl: localApiUrl,
            queryCatalogs: true,
            timeout: 300,
            hintRa,
            hintDec,
            hintRadius: hintRa !== undefined ? 15 : undefined, // 15 degree search radius when using hints
          });

          if (result.success) {
            successCount++;
          } else {
            failCount++;
          }
        } catch (err) {
          console.error(`Plate solve error for ${img.filename}:`, err);
          failCount++;
        }
        const elapsedTime = (Date.now() - startTime) / 1000; // Convert to seconds
        totalSolveTime += elapsedTime;

        completedCount++;
        updateProgress();
      }
    };

    // Start worker pool - each worker pulls from queue as it completes
    const workers = Array(effectiveParallel).fill(null).map(() => worker());

    // Run workers and handle completion (don't block UI on cancel)
    Promise.all(workers).then(() => {
      // Only update UI if not already cancelled (cancel handler updates UI immediately)
      if (!cancelRef.current) {
        setIsSolving(false);
        setSolveProgress({ current: 0, total: 0, successCount: 0, failCount: 0, avgSolveTime: 0 });

        if (failCount === 0) {
          toast.success(`Plate solved ${successCount} image${successCount !== 1 ? "s" : ""}`);
        } else {
          toast.info(`Plate solved ${successCount} image${successCount !== 1 ? "s" : ""}, ${failCount} failed`);
        }
      }

      // Notify parent to refresh data (even when cancelled, to show completed solves)
      onSolveComplete?.();
    });
  };

  // Cancel batch plate solve - immediately closes UI, workers finish in background
  const handleCancelSolve = () => {
    cancelRef.current = true;
    setIsSolving(false);
    setSolveProgress({ current: 0, total: 0, successCount: 0, failCount: 0, avgSolveTime: 0 });
    // Immediately refresh data to pick up any failures that already completed
    onSolveComplete?.();
    toast.info("Cancelled. Any in-progress solves will complete in the background.");
  };

  // Reset when sheet closes
  useEffect(() => {
    if (!open) {
      setSelectedImage(null);
      setPopupPosition(null);
      initAttempted.current = false;
    }
  }, [open]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="dark w-[75vw] sm:max-w-none bg-slate-900 border-slate-700 p-0 flex flex-col"
      >
        <div className="flex-1 overflow-hidden flex flex-col">
          {/* Header */}
          <div className="p-6 pb-4 border-b border-slate-700">
            <div className="flex justify-between items-start">
              <SheetHeader className="pr-8">
                <SheetTitle className="text-white text-2xl">{title}</SheetTitle>
                <SheetDescription className="text-slate-400">
                  {images.length} plate-solved image{images.length !== 1 ? "s" : ""} shown
                  {unsolvedImages.length > 0 && ` · ${unsolvedImages.length} unsolved`}
                </SheetDescription>
              </SheetHeader>
              {unsolvedImages.length > 0 && (
                <Button
                  variant="outline"
                  onClick={() => setBatchDialogOpen(true)}
                  disabled={isSolving}
                  className="bg-transparent border-gray-600 text-white hover:bg-gray-800"
                >
                  {isSolving ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Compass className="w-4 h-4 mr-2" />
                  )}
                  {isSolving ? "Solving..." : "Batch Solve"}
                </Button>
              )}
            </div>
          </div>

          {/* Map Container */}
          <div className="flex-1 relative">
            {loadError ? (
              <div className="absolute inset-0 flex items-center justify-center bg-slate-800">
                <div className="text-center">
                  <p className="text-red-400 font-medium">Failed to load sky map</p>
                  <p className="text-sm text-slate-400 mt-1">{loadError}</p>
                </div>
              </div>
            ) : !isLoaded ? (
              <div className="absolute inset-0 flex items-center justify-center bg-slate-800">
                <div className="text-center">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-teal-500 mx-auto mb-4" />
                  <p className="text-slate-400">Loading Aladin Lite...</p>
                </div>
              </div>
            ) : images.length === 0 ? (
              <div className="absolute inset-0 flex items-center justify-center bg-slate-800">
                <div className="text-center">
                  <ImageIcon className="w-12 h-12 mx-auto mb-4 text-slate-600" />
                  <p className="text-slate-400">No plate-solved images to display</p>
                  <p className="text-sm text-slate-500 mt-1">
                    Plate solve some images to see their sky coverage
                  </p>
                </div>
              </div>
            ) : null}

            {/* Aladin container */}
            <div
              ref={divRef}
              className="w-full h-full"
              style={{ minHeight: "400px" }}
            />

            {/* Image Details Popup */}
            {selectedImage && popupPosition && (
              <ImagePopup
                image={selectedImage}
                position={popupPosition}
                onClose={closePopup}
                containerRef={divRef}
              />
            )}
          </div>

          {/* Batch Plate Solve Progress Overlay */}
          {isSolving && (
            <div className="absolute inset-0 bg-black/70 flex items-center justify-center z-50">
              <div className="bg-slate-800 border border-slate-700 rounded-lg p-6 max-w-md w-full mx-4 space-y-4">
                <div className="flex items-center gap-3">
                  <Loader2 className="w-6 h-6 text-teal-500 animate-spin" />
                  <div>
                    <h3 className="text-white font-medium">
                      {cancelRef.current ? "Cancelling..." : "Plate Solving..."}
                    </h3>
                    <p className="text-sm text-gray-400">
                      {solveProgress.current} of {solveProgress.total} completed
                    </p>
                  </div>
                </div>
                <Progress
                  value={(solveProgress.current / solveProgress.total) * 100}
                  className="h-2"
                />
                <div className="flex justify-between text-sm">
                  <span className="text-teal-400">
                    {solveProgress.successCount} solved
                  </span>
                  {solveProgress.avgSolveTime > 0 && (
                    <span className="text-gray-400">
                      Avg: {solveProgress.avgSolveTime.toFixed(1)}s
                    </span>
                  )}
                  {solveProgress.failCount > 0 && (
                    <span className="text-red-400">
                      {solveProgress.failCount} failed
                    </span>
                  )}
                </div>
                <Button
                  variant="outline"
                  onClick={handleCancelSolve}
                  disabled={cancelRef.current}
                  className="w-full bg-transparent border-gray-600 text-white hover:bg-gray-700"
                >
                  {cancelRef.current ? "Cancelling..." : "Cancel"}
                </Button>
              </div>
            </div>
          )}

        </div>
      </SheetContent>

      {/* Batch Plate Solve Dialog */}
      <Dialog open={batchDialogOpen} onOpenChange={setBatchDialogOpen}>
        <DialogContent className="bg-slate-800 border-slate-700 text-white sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Batch Plate Solve</DialogTitle>
            <DialogDescription className="text-gray-400">
              Plate solve unsolved images across all observation collections.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {/* Stats */}
            <div className="bg-slate-900 rounded-lg p-4 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Already solved:</span>
                <span className="text-teal-400 font-medium">{images.length}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Ready to solve:</span>
                <span className="text-amber-400 font-medium">{solvableImages.length}</span>
              </div>
              {skippedCount > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Previously failed (skipped):</span>
                  <span className="text-red-400 font-medium">{skippedCount}</span>
                </div>
              )}
            </div>

            {/* API Key Input */}
            <div className="space-y-2">
              <Label htmlFor="batch-api-key">Astrometry.net API Key</Label>
              <Input
                id="batch-api-key"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Enter your API key"
                className="bg-slate-700 border-slate-600"
              />
              <p className="text-xs text-gray-500">
                Get your free API key at{" "}
                <a
                  href="https://nova.astrometry.net/api_help"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-teal-400 hover:underline"
                >
                  nova.astrometry.net
                </a>
              </p>
            </div>

            {/* Max Count */}
            <div className="space-y-2">
              <Label htmlFor="batch-max-count">Maximum Images to Solve</Label>
              <Input
                id="batch-max-count"
                type="number"
                min={1}
                max={solvableImages.length || 1}
                value={maxCount}
                onChange={(e) => setMaxCount(Math.max(1, Math.min(solvableImages.length || 1, parseInt(e.target.value) || 1)))}
                className="bg-slate-700 border-slate-600 w-32"
              />
              <p className="text-xs text-gray-500">
                Limit the number of images to solve in this batch (1-{solvableImages.length}).
              </p>
            </div>

            {/* Parallel Processing */}
            <div className="space-y-2">
              <Label htmlFor="batch-parallel">Parallel Processing</Label>
              <Input
                id="batch-parallel"
                type="number"
                min={1}
                max={10}
                value={parallelCount}
                onChange={(e) => setParallelCount(Math.max(1, Math.min(10, parseInt(e.target.value) || 1)))}
                className="bg-slate-700 border-slate-600 w-24"
              />
              <p className="text-xs text-gray-500">
                Number of images to solve simultaneously (1-10).
              </p>
            </div>

            {/* Warning */}
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 text-sm text-amber-200">
              <strong>Note:</strong> This will submit up to {Math.min(maxCount, unsolvedImages.length)} image{Math.min(maxCount, unsolvedImages.length) !== 1 ? "s" : ""} to Astrometry.net for plate solving.
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setBatchDialogOpen(false)}
              className="bg-transparent border-gray-600 text-white hover:bg-gray-700"
            >
              Cancel
            </Button>
            <Button
              onClick={handleBatchPlateSolve}
              disabled={!apiKey || unsolvedImages.length === 0}
            >
              <Compass className="w-4 h-4 mr-2" />
              Solve {Math.min(maxCount, unsolvedImages.length)} Image{Math.min(maxCount, unsolvedImages.length) !== 1 ? "s" : ""}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Sheet>
  );
}

/**
 * Popup showing details for a clicked image footprint
 */
function ImagePopup({
  image,
  position,
  onClose,
  containerRef,
}: {
  image: ImageFootprint;
  position: { x: number; y: number };
  onClose: () => void;
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const popupRef = useRef<HTMLDivElement>(null);

  // Calculate popup position to stay within bounds
  const getPopupStyle = (): React.CSSProperties => {
    const container = containerRef.current;
    if (!container) return { left: position.x, top: position.y };

    const containerRect = container.getBoundingClientRect();
    const popupWidth = 280;
    const popupHeight = 200;
    const padding = 10;

    let left = position.x + padding;
    let top = position.y + padding;

    // Adjust if popup would go off right edge
    if (left + popupWidth > containerRect.width - padding) {
      left = position.x - popupWidth - padding;
    }

    // Adjust if popup would go off bottom edge
    if (top + popupHeight > containerRect.height - padding) {
      top = position.y - popupHeight - padding;
    }

    // Ensure minimum bounds
    left = Math.max(padding, left);
    top = Math.max(padding, top);

    return { left, top };
  };

  return (
    <div
      ref={popupRef}
      className="absolute z-50 bg-slate-800 border border-slate-600 rounded-lg shadow-xl p-0 w-[280px]"
      style={getPopupStyle()}
    >
      {/* Close button */}
      <button
        onClick={onClose}
        className="absolute top-2 right-2 z-10 p-1 rounded-full bg-black/50 hover:bg-black/70 transition-colors"
      >
        <X className="w-4 h-4 text-white" />
      </button>

      {/* Thumbnail */}
      <div className="aspect-video bg-slate-900 rounded-t-lg overflow-hidden">
        {image.thumbnail ? (
          <img
            src={image.thumbnail}
            alt={image.filename}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <ImageIcon className="w-10 h-10 text-slate-600" />
          </div>
        )}
      </div>

      {/* Info */}
      <div className="p-3 space-y-2">
        <p className="font-medium text-white text-sm truncate" title={image.filename}>
          {image.filename}
        </p>

        <div className="flex items-center justify-between text-xs">
          {image.collectionName && (
            <span className="text-violet-400 truncate max-w-[60%]">
              {image.collectionName}
            </span>
          )}
          {image.exposureSeconds > 0 && (
            <span className="text-teal-400 flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {formatDuration(image.exposureSeconds)}
            </span>
          )}
        </div>

        {/* View Image button */}
        <Link to={`/i/${image.id}`}>
          <Button
            variant="outline"
            size="sm"
            className="w-full mt-2 border-slate-600 text-slate-300 hover:bg-slate-700"
          >
            <ExternalLink className="w-3.5 h-3.5 mr-2" />
            View Image
          </Button>
        </Link>
      </div>
    </div>
  );
}

// Note: Window.A interface is declared in AladinLite.tsx
