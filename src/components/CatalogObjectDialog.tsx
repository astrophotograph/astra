/**
 * Catalog Object Dialog - Shows details for a specific catalog object
 *
 * Displays all images taken of this object, exposure time, equipment used, etc.
 */

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Camera,
  Clock,
  Compass,
  ExternalLink,
  FolderDown,
  ImageIcon,
  Telescope,
} from "lucide-react";
import type { CatalogEntry } from "@/lib/catalogs";
import type { Image, Collection } from "@/lib/tauri/commands";
import CollectFilesDialog from "./CollectFilesDialog";

interface CatalogObjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  object: CatalogEntry | null;
  images: ImageWithMeta[];
}

export interface ImageWithMeta {
  image: Image;
  exposureSeconds: number;
  equipment: {
    telescope?: string;
    camera?: string;
    mount?: string;
  };
  collection?: Collection;
}

/**
 * Extract equipment info from image metadata
 */
export function extractEquipment(image: Image): {
  telescope?: string;
  camera?: string;
  mount?: string;
} {
  if (!image.metadata) return {};

  try {
    const metadata =
      typeof image.metadata === "string"
        ? JSON.parse(image.metadata)
        : image.metadata;

    return {
      telescope:
        metadata.telescope ||
        metadata.instrument ||
        metadata.fits?.TELESCOP ||
        metadata.fits?.INSTRUME,
      camera:
        metadata.camera ||
        metadata.sensor ||
        metadata.fits?.CAMERA ||
        metadata.fits?.SENSOR,
      mount:
        metadata.mount || metadata.fits?.MOUNT,
    };
  } catch {
    return {};
  }
}

/**
 * Extract exposure time in seconds from image
 */
export function extractExposureSeconds(image: Image): number {
  if (image.metadata) {
    try {
      const metadata =
        typeof image.metadata === "string"
          ? JSON.parse(image.metadata)
          : image.metadata;

      // Priority 1: Total integration time
      if (
        typeof metadata.total_integration_time === "number" &&
        metadata.total_integration_time > 0
      ) {
        return metadata.total_integration_time;
      }

      // Priority 2: Calculate from stacked frames × per-frame exposure
      const frames =
        metadata.stacked_frames ||
        metadata.stackedFrames ||
        metadata.frames ||
        metadata.STACKCNT;
      const perFrame =
        metadata.exposure ||
        metadata.exposure_time ||
        metadata.exptime ||
        (metadata.fits?.EXPTIME ? parseFloat(metadata.fits.EXPTIME) : null) ||
        (metadata.fits?.EXPOSURE ? parseFloat(metadata.fits.EXPOSURE) : null);

      if (
        typeof frames === "number" &&
        frames > 0 &&
        typeof perFrame === "number" &&
        perFrame > 0
      ) {
        return frames * perFrame;
      }

      // Priority 3: Single exposure value
      if (typeof metadata.exposure === "number" && metadata.exposure > 0)
        return metadata.exposure;
      if (
        typeof metadata.exposure_time === "number" &&
        metadata.exposure_time > 0
      )
        return metadata.exposure_time;
      if (typeof metadata.exptime === "number" && metadata.exptime > 0)
        return metadata.exptime;

      // Check FITS nested structure
      if (metadata.fits?.EXPTIME) return parseFloat(metadata.fits.EXPTIME) || 0;
      if (metadata.fits?.EXPOSURE)
        return parseFloat(metadata.fits.EXPOSURE) || 0;
    } catch {
      // Continue to filename parsing
    }
  }

  // Try to extract from Seestar-style filename
  if (image.filename) {
    const stackedMatch = image.filename.match(
      /Stacked_(\d+)_.*?_(\d+(?:\.\d+)?)s_/i
    );
    if (stackedMatch) {
      const frameCount = parseInt(stackedMatch[1], 10) || 0;
      const perFrameSeconds = parseFloat(stackedMatch[2]) || 0;
      return frameCount * perFrameSeconds;
    }

    const simpleMatch = image.filename.match(
      /(\d+(?:\.\d+)?)\s*(?:s|sec)(?:\b|_|\.)/i
    );
    if (simpleMatch) {
      return parseFloat(simpleMatch[1]) || 0;
    }
  }

  return 0;
}

/**
 * Format seconds as human-readable duration
 */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

/**
 * Check if an image has been plate-solved
 */
function isPlateSolved(image: Image): boolean {
  if (!image.metadata) return false;
  try {
    const metadata =
      typeof image.metadata === "string"
        ? JSON.parse(image.metadata)
        : image.metadata;
    return !!metadata.plate_solve;
  } catch {
    return false;
  }
}

/**
 * Format coordinates for display
 */
function formatCoords(ra: number, dec: number): string {
  const raHours = ra / 15; // Convert degrees to hours
  const raH = Math.floor(raHours);
  const raM = Math.floor((raHours - raH) * 60);
  const raS = ((raHours - raH) * 60 - raM) * 60;

  const decSign = dec >= 0 ? "+" : "-";
  const decAbs = Math.abs(dec);
  const decD = Math.floor(decAbs);
  const decM = Math.floor((decAbs - decD) * 60);
  const decS = ((decAbs - decD) * 60 - decM) * 60;

  return `${raH}h ${raM}m ${raS.toFixed(1)}s, ${decSign}${decD}° ${decM}' ${decS.toFixed(0)}"`;
}

export default function CatalogObjectDialog({
  open,
  onOpenChange,
  object,
  images,
}: CatalogObjectDialogProps) {
  const [collectDialogOpen, setCollectDialogOpen] = useState(false);

  // Compute totals
  const stats = useMemo(() => {
    const totalExposure = images.reduce(
      (sum, img) => sum + img.exposureSeconds,
      0
    );
    const telescopes = new Set<string>();
    const cameras = new Set<string>();

    for (const img of images) {
      if (img.equipment.telescope) telescopes.add(img.equipment.telescope);
      if (img.equipment.camera) cameras.add(img.equipment.camera);
    }

    return {
      totalExposure,
      telescopes: Array.from(telescopes),
      cameras: Array.from(cameras),
      imageCount: images.length,
    };
  }, [images]);

  // Get stacked paths for file collection
  const stackedPaths = useMemo(() => {
    return images
      .filter((img) => img.image.url)
      .map((img) => img.image.url as string);
  }, [images]);

  if (!object) return null;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="dark max-w-2xl max-h-[85vh] overflow-hidden flex flex-col bg-slate-900 border-slate-700">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-3 text-white">
              <span className="text-2xl font-bold">{object.name}</span>
              {object.commonName && (
                <span className="text-lg text-slate-400 font-normal">
                  {object.commonName}
                </span>
              )}
            </DialogTitle>
            <DialogDescription className="text-slate-400">
              {object.type} in {object.constellation}
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-hidden flex flex-col gap-4">
            {/* Object Info */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="bg-slate-800 rounded-lg p-3">
                <div className="text-xs text-slate-400 mb-1">Magnitude</div>
                <div className="text-lg font-semibold text-white">
                  {object.magnitude ?? "—"}
                </div>
              </div>
              <div className="bg-slate-800 rounded-lg p-3">
                <div className="text-xs text-slate-400 mb-1">Size</div>
                <div className="text-lg font-semibold text-white">
                  {object.size ? `${object.size}'` : "—"}
                </div>
              </div>
              <div className="bg-slate-800 rounded-lg p-3 col-span-2">
                <div className="text-xs text-slate-400 mb-1">Coordinates</div>
                <div className="text-sm font-mono text-white">
                  {formatCoords(object.ra, object.dec)}
                </div>
              </div>
            </div>

            {/* Stats Summary */}
            {images.length > 0 && (
              <div className="bg-slate-800/50 rounded-lg p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-white">Your Images</h3>
                  {stackedPaths.length > 0 && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setCollectDialogOpen(true)}
                      className="border-slate-600 text-slate-300 hover:bg-slate-700"
                    >
                      <FolderDown className="w-4 h-4 mr-2" />
                      Collect Files
                    </Button>
                  )}
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                  <div className="flex items-center gap-2 text-slate-300">
                    <ImageIcon className="w-4 h-4 text-teal-400" />
                    <span>
                      {stats.imageCount} image
                      {stats.imageCount !== 1 ? "s" : ""}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-slate-300">
                    <Clock className="w-4 h-4 text-teal-400" />
                    <span>{formatDuration(stats.totalExposure)} total</span>
                  </div>
                  {stats.telescopes.length > 0 && (
                    <div className="flex items-center gap-2 text-slate-300">
                      <Telescope className="w-4 h-4 text-teal-400" />
                      <span className="truncate" title={stats.telescopes.join(", ")}>
                        {stats.telescopes.length === 1
                          ? stats.telescopes[0]
                          : `${stats.telescopes.length} scopes`}
                      </span>
                    </div>
                  )}
                  {stats.cameras.length > 0 && (
                    <div className="flex items-center gap-2 text-slate-300">
                      <Camera className="w-4 h-4 text-teal-400" />
                      <span className="truncate" title={stats.cameras.join(", ")}>
                        {stats.cameras.length === 1
                          ? stats.cameras[0]
                          : `${stats.cameras.length} cameras`}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Image Grid */}
            <ScrollArea className="flex-1">
              {images.length === 0 ? (
                <div className="text-center py-8 text-slate-400">
                  <ImageIcon className="w-12 h-12 mx-auto mb-3 opacity-50" />
                  <p>No images of this object yet</p>
                  <p className="text-sm mt-1">
                    Import images to see them here
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3 pr-4">
                  {images.map((imgData) => (
                    <Link
                      key={imgData.image.id}
                      to={`/i/${imgData.image.id}`}
                      className="group"
                    >
                      <div className="relative rounded-lg overflow-hidden bg-slate-800 border border-slate-700 hover:border-teal-500 transition-colors">
                        <div className="aspect-video bg-slate-700 relative">
                          {imgData.image.thumbnail ? (
                            <img
                              src={imgData.image.thumbnail}
                              alt={imgData.image.filename}
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <ImageIcon className="w-8 h-8 text-slate-500" />
                            </div>
                          )}
                          {/* Plate-solved indicator */}
                          {isPlateSolved(imgData.image) && (
                            <div
                              className="absolute bottom-2 left-2 w-6 h-6 bg-teal-500/90 rounded-full flex items-center justify-center"
                              title="Plate solved"
                            >
                              <Compass className="w-3.5 h-3.5 text-white" />
                            </div>
                          )}
                        </div>
                        <div className="p-2 space-y-1">
                          <div className="flex items-center justify-between">
                            <span className="text-xs text-teal-400 font-medium">
                              {formatDuration(imgData.exposureSeconds)}
                            </span>
                            {imgData.equipment.telescope && (
                              <span
                                className="text-xs text-slate-400 truncate max-w-[60%]"
                                title={imgData.equipment.telescope}
                              >
                                {imgData.equipment.telescope}
                              </span>
                            )}
                          </div>
                          {imgData.collection && (
                            <Badge
                              variant="outline"
                              className="text-xs bg-violet-500/10 text-violet-300 border-violet-500/30"
                            >
                              {imgData.collection.name}
                            </Badge>
                          )}
                        </div>
                        <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
                          <ExternalLink className="w-4 h-4 text-white drop-shadow" />
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </ScrollArea>

            {/* Aliases / Additional Names */}
            {object.aliases && object.aliases.length > 0 && (
              <div className="text-sm text-slate-400">
                <span className="text-slate-500">Also known as: </span>
                {object.aliases.join(", ")}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Collect Files Dialog */}
      <CollectFilesDialog
        open={collectDialogOpen}
        onOpenChange={setCollectDialogOpen}
        targetName={object.commonName || object.name}
        stackedPaths={stackedPaths}
      />
    </>
  );
}
