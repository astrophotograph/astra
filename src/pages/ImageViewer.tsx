/**
 * Image Viewer Page - View and manage individual images
 */

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useParams, useNavigate, useSearchParams, Link } from "react-router-dom";
import { toast } from "sonner";
import { marked } from "marked";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { imageApi, plateSolveApi, skymapApi, type CatalogObject, type ProcessImageResponse } from "@/lib/tauri/commands";
import { ProcessingDialog } from "@/components/ProcessingDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  ArrowLeft,
  Calendar,
  ChevronDown,
  Compass,
  Edit,
  Eye,
  EyeOff,
  ImageIcon,
  Loader2,
  Map,
  MapPin,
  MoreHorizontal,
  RefreshCw,
  Save,
  Sparkles,
  Star,
  Tag,
  Trash2,
  Wand2,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { useQueryClient } from "@tanstack/react-query";
import { useImage, useUpdateImage, useDeleteImage, imageKeys } from "@/hooks/use-images";
import { useEquipment } from "@/contexts/EquipmentContext";

// Calculate focal length from pixel size and pixel scale
// Formula: focal_length_mm = 206.265 * pixel_size_microns / pixel_scale_arcsec
function calculateFocalLength(pixelSizeMicrons: number, pixelScaleArcsec: number): number {
  return (206.265 * pixelSizeMicrons) / pixelScaleArcsec;
}

// Convert decimal degrees RA to HMS (hours, minutes, seconds) string
function raToHMS(raDeg: number): string {
  // RA: 360 degrees = 24 hours
  const totalHours = raDeg / 15;
  const hours = Math.floor(totalHours);
  const minutesDecimal = (totalHours - hours) * 60;
  const minutes = Math.floor(minutesDecimal);
  const seconds = (minutesDecimal - minutes) * 60;
  return `${hours}h ${minutes}m ${seconds.toFixed(1)}s`;
}

// Convert decimal degrees Dec to DMS (degrees, arcminutes, arcseconds) string
function decToDMS(decDeg: number): string {
  const sign = decDeg >= 0 ? "+" : "-";
  const absDec = Math.abs(decDeg);
  const degrees = Math.floor(absDec);
  const arcminutesDecimal = (absDec - degrees) * 60;
  const arcminutes = Math.floor(arcminutesDecimal);
  const arcseconds = (arcminutesDecimal - arcminutes) * 60;
  return `${sign}${degrees}° ${arcminutes}′ ${arcseconds.toFixed(1)}″`;
}

export default function ImageViewerPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [isEditing, setIsEditing] = useState(false);
  const [editSummary, setEditSummary] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editTags, setEditTags] = useState("");
  const [editLocation, setEditLocation] = useState("");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [imageVersion, setImageVersion] = useState(0);
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [isLoadingImage, setIsLoadingImage] = useState(false);
  const [plateSolveDialogOpen, setPlateSolveDialogOpen] = useState(false);
  const [isPlateSolving, setIsPlateSolving] = useState(false);
  const [plateSolveApiKey, setPlateSolveApiKey] = useState(() => {
    return localStorage.getItem("astrometry_api_key") || "";
  });
  const [plateSolveSolver] = useState(() => {
    return localStorage.getItem("plate_solve_solver") || "nova";
  });
  const [localAstrometryUrl] = useState(() => {
    return localStorage.getItem("local_astrometry_url") || "";
  });
  const [catalogObjects, setCatalogObjects] = useState<CatalogObject[]>([]);
  const [objectsExpanded, setObjectsExpanded] = useState(false);
  const [showObjectOverlay, setShowObjectOverlay] = useState(false);
  const [magLimit, setMagLimit] = useState(15);
  const [imageDisplaySize, setImageDisplaySize] = useState({ width: 0, height: 0 });
  const imageContainerRef = useRef<HTMLDivElement>(null);
  const [skymapImage, setSkymapImage] = useState<string | null>(null);
  const [isLoadingSkymap, setIsLoadingSkymap] = useState(false);
  const [skymapExpanded, setSkymapExpanded] = useState(false);
  const [processingDialogOpen, setProcessingDialogOpen] = useState(false);

  const queryClient = useQueryClient();
  const { data: image, isLoading, error, refetch } = useImage(id || "");
  const updateImage = useUpdateImage();
  const deleteImage = useDeleteImage();
  const { equipmentSets } = useEquipment();

  // Check for action query param (e.g., ?action=platesolve)
  useEffect(() => {
    const action = searchParams.get("action");
    if (action === "platesolve" && image?.id) {
      setPlateSolveDialogOpen(true);
      // Clear the query param so it doesn't re-trigger
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, image?.id, setSearchParams]);

  // Fetch full image data from backend
  useEffect(() => {
    if (image?.id) {
      setIsLoadingImage(true);
      imageApi.getData(image.id)
        .then((dataUrl) => {
          setImageDataUrl(dataUrl);
        })
        .catch((err) => {
          console.error("Failed to load image:", err);
          // Fallback to thumbnail if available
          if (image.thumbnail) {
            setImageDataUrl(image.thumbnail);
          }
        })
        .finally(() => {
          setIsLoadingImage(false);
        });
    }
  }, [image?.id, image?.thumbnail, imageVersion]);

  // Parse markdown description - must be before any early returns
  const descriptionHtml = useMemo(() => {
    if (!image?.description) return "";
    return marked.parse(image.description, { async: false }) as string;
  }, [image?.description]);

  // Parse existing annotations when image loads
  useEffect(() => {
    if (image?.annotations) {
      try {
        const parsed = JSON.parse(image.annotations) as CatalogObject[];
        setCatalogObjects(parsed);
      } catch {
        setCatalogObjects([]);
      }
    } else {
      setCatalogObjects([]);
    }
  }, [image?.annotations]);

  // Parse plate solve metadata
  const plateSolveInfo = useMemo(() => {
    if (!image?.metadata) return null;
    try {
      const metadata = JSON.parse(image.metadata);
      return metadata.plate_solve || null;
    } catch {
      return null;
    }
  }, [image?.metadata]);

  // Calculate focal length from plate solve pixel scale and camera pixel size
  const calculatedFocalLength = useMemo(() => {
    if (!plateSolveInfo?.pixel_scale) return null;

    // Try to find a camera with pixel size from equipment sets
    for (const eqSet of equipmentSets) {
      if (eqSet.camera?.pixelSize) {
        return calculateFocalLength(eqSet.camera.pixelSize, plateSolveInfo.pixel_scale);
      }
    }
    return null;
  }, [plateSolveInfo, equipmentSets]);

  // Track displayed image size for overlay (updates on resize)
  const imgRef = useRef<HTMLImageElement | null>(null);
  useEffect(() => {
    const img = imageContainerRef.current?.querySelector("img");
    if (!img) return;
    imgRef.current = img;

    const observer = new ResizeObserver(() => {
      setImageDisplaySize({ width: img.clientWidth, height: img.clientHeight });
    });
    observer.observe(img);
    return () => observer.disconnect();
  }, [imageDataUrl]);

  // Calculate pixel position for a celestial object
  // Uses precomputed WCS pixel positions when available, falls back to projection math
  const calculateObjectPosition = useCallback(
    (objRa: number, objDec: number, pixelX?: number, pixelY?: number) => {
      if (!plateSolveInfo || !imageDisplaySize.width || !imageDisplaySize.height) {
        return null;
      }

      // Use precomputed WCS pixel positions if available
      if (pixelX != null && pixelY != null) {
        // pixelX/pixelY are in FITS pixel coords (origin at bottom-left per FITS convention)
        // We need the FITS image dimensions from the plate solve metadata
        // NAXIS1 and NAXIS2 may be in the image metadata
        let fitsW = 0, fitsH = 0;
        if (image?.metadata) {
          try {
            const meta = JSON.parse(image.metadata);
            const parseIntVal = (v: unknown): number => {
              if (v == null) return 0;
              const s = String(v);
              const m = s.match(/IntegerNumber\((\d+)\)/);
              return m ? parseInt(m[1]) : (parseInt(s) || 0);
            };
            fitsW = parseIntVal(meta.NAXIS1);
            fitsH = parseIntVal(meta.NAXIS2);
          } catch { /* ignore */ }
        }
        if (fitsW <= 0 || fitsH <= 0) {
          // Fallback: estimate from pixel_scale and FOV
          const pixScale = plateSolveInfo.pixel_scale / 3600;
          fitsW = Math.round(plateSolveInfo.width_deg / pixScale);
          fitsH = Math.round(plateSolveInfo.height_deg / pixScale);
        }

        // The preview JPEG is generated by processinator which reads the FITS
        // and saves it — the preview's pixel layout matches the FITS layout
        // FITS Y increases upward, but the preview flips it (standard image convention)
        const vbH = 1000 * imageDisplaySize.height / imageDisplaySize.width;
        // astropy's world_to_pixel returns numpy array coords (0,0 = top-left)
        // which matches the preview image orientation — no flip needed
        const vbX = (pixelX / fitsW) * 1000;
        const vbY = (pixelY / fitsH) * vbH;

        if (vbX < -50 || vbX > 1050 || vbY < -50 || vbY > vbH + 50) return null;
        return { x: vbX, y: vbY };
      }

      const { center_ra, center_dec, width_deg, height_deg, rotation } = plateSolveInfo;
      const deg2rad = Math.PI / 180;

      // Gnomonic (TAN) projection — proper tangent plane projection
      const ra0 = center_ra * deg2rad;
      const dec0 = center_dec * deg2rad;
      const ra = objRa * deg2rad;
      const dec = objDec * deg2rad;

      const cosDec = Math.cos(dec);
      const sinDec = Math.sin(dec);
      const cosDec0 = Math.cos(dec0);
      const sinDec0 = Math.sin(dec0);
      const cosDeltaRa = Math.cos(ra - ra0);
      const sinDeltaRa = Math.sin(ra - ra0);

      // Distance from tangent point
      const sinD = sinDec0 * sinDec + cosDec0 * cosDec * cosDeltaRa;
      if (sinD <= 0) return null;

      // Standard coordinates (xi, eta) in radians
      const xi = (cosDec * sinDeltaRa) / sinD;
      const eta = (cosDec0 * sinDec - sinDec0 * cosDec * cosDeltaRa) / sinD;

      // Convert to degrees
      const xiDeg = xi / deg2rad;
      const etaDeg = eta / deg2rad;

      // The displayed image may have different orientation from the FITS
      // (e.g., portrait FITS displayed as landscape JPEG preview).
      // Use the displayed image aspect ratio to determine the mapping.
      const displayW = imageDisplaySize.width;
      const displayH = imageDisplaySize.height;
      const displayAspect = displayW / displayH;
      const fitsAspect = width_deg / height_deg;

      // Determine if the preview was transposed relative to FITS
      // If FITS is portrait (height > width) but display is landscape (width > height),
      // the axes are swapped
      const isTransposed = (fitsAspect < 1) !== (displayAspect < 1);

      // Apply rotation (PA = position angle of +Y from N through E)
      const rotRad = ((rotation || 0) * Math.PI) / 180;
      const cosR = Math.cos(rotRad);
      const sinR = Math.sin(rotRad);

      // Standard tangent plane to FITS pixel mapping:
      // dx_fits = -xi*sin(PA) + eta*cos(PA)
      // dy_fits = xi*cos(PA) + eta*sin(PA)
      const dxFits = -xiDeg * sinR + etaDeg * cosR;
      const dyFits = xiDeg * cosR + etaDeg * sinR;

      let fracX: number, fracY: number;
      if (isTransposed) {
        // FITS is portrait but displayed landscape — axes swapped and flipped
        fracX = 0.5 - dyFits / height_deg;
        fracY = 0.5 - dxFits / width_deg;
      } else {
        fracX = 0.5 + dxFits / width_deg;
        fracY = 0.5 - dyFits / height_deg;
      }

      // Check if within image bounds (with some margin)
      if (fracX < -0.1 || fracX > 1.1 || fracY < -0.1 || fracY > 1.1) {
        return null;
      }

      // Convert to viewBox coordinates (1000-wide, proportional height)
      const vbHeight = 1000 * imageDisplaySize.height / imageDisplaySize.width;
      return {
        x: fracX * 1000,
        y: fracY * vbHeight,
      };
    },
    [plateSolveInfo, imageDisplaySize, image]
  );

  // Load skymap when plate solve info is available and expanded
  const loadSkymap = useCallback(async () => {
    if (!plateSolveInfo || isLoadingSkymap) return;

    setIsLoadingSkymap(true);
    try {
      // Generate a skymap centered on the image
      // Let Python auto-calculate FOV based on image dimensions (~2.5x)
      const result = await skymapApi.generate({
        centerRa: plateSolveInfo.center_ra,
        centerDec: plateSolveInfo.center_dec,
        imageWidth: plateSolveInfo.width_deg,
        imageHeight: plateSolveInfo.height_deg,
      });

      if (result.success && result.image) {
        setSkymapImage(result.image);
      } else {
        toast.error(result.error || "Failed to generate skymap");
      }
    } catch (err) {
      toast.error("Failed to generate skymap: " + (err as Error).message);
      console.error(err);
    } finally {
      setIsLoadingSkymap(false);
    }
  }, [plateSolveInfo, isLoadingSkymap]);

  // Handle plate solve
  const handlePlateSolve = async () => {
    if (!image) return;

    if (plateSolveSolver === "nova" && !plateSolveApiKey) {
      toast.error("Please enter an Astrometry.net API key");
      return;
    }

    // Save API key to localStorage
    if (plateSolveApiKey) {
      localStorage.setItem("astrometry_api_key", plateSolveApiKey);
    }

    setIsPlateSolving(true);
    setPlateSolveDialogOpen(false);

    try {
      const result = await plateSolveApi.solve({
        id: image.id,
        solver: plateSolveSolver,
        apiKey: plateSolveApiKey || undefined,
        apiUrl: localAstrometryUrl || undefined,
        queryCatalogs: true,
        timeout: 300,
      });

      if (result.success) {
        toast.success(`Plate solved in ${result.solveTime.toFixed(1)}s - found ${result.objects.length} objects`);
        setCatalogObjects(result.objects);
        // Refresh the image data to get updated metadata
        await refetch();
        // Clear any cached skymap so it regenerates with new data
        setSkymapImage(null);
      } else {
        toast.error(result.errorMessage || "Plate solve failed");
      }
    } catch (err: unknown) {
      // Handle different error formats from Tauri
      let errorMsg = "Unknown error";
      if (err instanceof Error) {
        errorMsg = err.message;
      } else if (typeof err === "string") {
        errorMsg = err;
      } else if (err && typeof err === "object" && "message" in err) {
        errorMsg = String((err as { message: unknown }).message);
      }
      toast.error("Plate solve failed: " + errorMsg);
      console.error("Plate solve error:", err);
    } finally {
      setIsPlateSolving(false);
    }
  };

  // Start editing mode
  const handleStartEdit = () => {
    if (image) {
      setEditSummary(image.summary || "");
      setEditDescription(image.description || "");
      setEditTags(image.tags || "");
      setEditLocation(image.location || "");
      setIsEditing(true);
    }
  };

  // Save edits
  const handleSave = async () => {
    if (!image) return;

    try {
      await updateImage.mutateAsync({
        id: image.id,
        summary: editSummary || undefined,
        description: editDescription || undefined,
        tags: editTags || undefined,
        location: editLocation || undefined,
      });
      toast.success("Image updated");
      setIsEditing(false);
    } catch (err) {
      toast.error("Failed to update image");
      console.error(err);
    }
  };

  // Toggle favorite
  const handleToggleFavorite = async () => {
    if (!image) return;

    try {
      await updateImage.mutateAsync({
        id: image.id,
        favorite: !image.favorite,
      });
      toast.success(image.favorite ? "Removed from favorites" : "Added to favorites");
    } catch (err) {
      toast.error("Failed to update favorite status");
      console.error(err);
    }
  };

  // Read default stretch from auto-import config in localStorage
  const defaultStretch = useMemo(() => {
    try {
      const saved = localStorage.getItem("auto_import_config");
      if (saved) {
        const cfg = JSON.parse(saved);
        return { bgPercent: cfg.stretchBgPercent ?? 0.15, sigma: cfg.stretchSigma ?? 3.0 };
      }
    } catch { /* ignore */ }
    return { bgPercent: 0.15, sigma: 3.0 };
  }, []);

  const STRETCH_PRESETS = [
    { label: "10% Bg, 3 sigma", bgPercent: 0.10, sigma: 3.0 },
    { label: "15% Bg, 3 sigma", bgPercent: 0.15, sigma: 3.0 },
    { label: "20% Bg, 3 sigma", bgPercent: 0.20, sigma: 3.0 },
    { label: "30% Bg, 2 sigma", bgPercent: 0.30, sigma: 2.0 },
  ];

  // Delete image
  const handleRegeneratePreview = async (bgPercent?: number, sigma?: number) => {
    if (!image) return;
    setIsRegenerating(true);
    toast.info("Regenerating preview...");
    try {
      await imageApi.regeneratePreview(image.id, bgPercent, sigma);
      toast.success("Preview regenerated");
      // Refetch image record and force reload of image data
      await refetch();
      setImageVersion((v) => v + 1);
      // Invalidate the images list so thumbnails update in grid views
      queryClient.invalidateQueries({ queryKey: imageKeys.lists() });
    } catch (e) {
      toast.error("Failed to regenerate preview: " + e);
    } finally {
      setIsRegenerating(false);
    }
  };

  const handleDelete = async () => {
    if (!image) return;

    try {
      await deleteImage.mutateAsync(image.id);
      toast.success("Image deleted");
      navigate("/observations");
    } catch (err) {
      toast.error("Failed to delete image");
      console.error(err);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <p className="text-muted-foreground">Loading image...</p>
      </div>
    );
  }

  if (error || !image) {
    return (
      <div className="text-center py-12">
        <ImageIcon className="w-12 h-12 mx-auto mb-4 opacity-50" />
        <h2 className="text-xl font-semibold mb-2">Image not found</h2>
        <p className="text-muted-foreground mb-4">
          The requested image could not be found.
        </p>
        <Link to="/observations">
          <Button>
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Observations
          </Button>
        </Link>
      </div>
    );
  }

  const tags = image.tags ? image.tags.split(",").map((t) => t.trim()).filter(Boolean) : [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back
          </Button>
          <h1 className="text-2xl font-bold">{image.summary || image.filename}</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleToggleFavorite}
            disabled={updateImage.isPending}
          >
            <Star
              className={`w-5 h-5 ${
                image.favorite ? "text-yellow-500 fill-yellow-500" : ""
              }`}
            />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              // Skip dialog if we already have what we need
              if (plateSolveSolver !== "nova" || plateSolveApiKey) {
                handlePlateSolve();
              } else {
                setPlateSolveDialogOpen(true);
              }
            }}
            disabled={isPlateSolving}
          >
            {isPlateSolving ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Solving...
              </>
            ) : (
              <>
                <Compass className="w-4 h-4 mr-2" />
                Plate Solve
              </>
            )}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setProcessingDialogOpen(true)}
            disabled={!image?.fits_url && !image?.url?.toLowerCase().endsWith('.fit') && !image?.url?.toLowerCase().endsWith('.fits')}
            title={
              !image?.fits_url && !image?.url?.toLowerCase().endsWith('.fit') && !image?.url?.toLowerCase().endsWith('.fits')
                ? "No FITS file available for processing"
                : "Process image with stretch and enhancements"
            }
          >
            <Wand2 className="w-4 h-4 mr-2" />
            Process
          </Button>
          {!isEditing && (
            <Button variant="outline" size="sm" onClick={handleStartEdit}>
              <Edit className="w-4 h-4 mr-2" />
              Edit
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <MoreHorizontal className="w-4 h-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {(image?.fits_url || image?.url?.toLowerCase().endsWith('.fit') || image?.url?.toLowerCase().endsWith('.fits')) && (
                <>
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger disabled={isRegenerating}>
                      {isRegenerating ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <RefreshCw className="w-4 h-4 mr-2" />
                      )}
                      Regenerate Preview
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      {STRETCH_PRESETS.map((preset) => {
                        const isDefault = preset.bgPercent === defaultStretch.bgPercent && preset.sigma === defaultStretch.sigma;
                        return (
                          <DropdownMenuItem
                            key={preset.label}
                            onClick={() => handleRegeneratePreview(preset.bgPercent, preset.sigma)}
                            disabled={isRegenerating}
                          >
                            {preset.label}{isDefault ? " *" : ""}
                          </DropdownMenuItem>
                        );
                      })}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem
                className="text-destructive"
                onClick={() => setDeleteDialogOpen(true)}
              >
                <Trash2 className="w-4 h-4 mr-2" />
                Delete Image
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Image Display */}
        <div className="lg:col-span-2 space-y-2">
          <div ref={imageContainerRef} className="rounded-lg overflow-hidden bg-muted relative">
            {isRegenerating && (
              <div className="absolute inset-0 z-20 bg-black/60 flex flex-col items-center justify-center gap-3">
                <Loader2 className="w-8 h-8 animate-spin text-indigo-400" />
                <p className="text-sm text-white">Regenerating preview...</p>
              </div>
            )}
            {isLoadingImage ? (
              <div className="aspect-video flex items-center justify-center">
                <p className="text-muted-foreground">Loading image...</p>
              </div>
            ) : imageDataUrl ? (
              <>
                <div className="relative inline-block w-full">
                  <img
                    src={imageDataUrl}
                    alt={image.filename}
                    className="w-full h-auto block"
                    onLoad={(e) => {
                      const img = e.currentTarget;
                      setImageDisplaySize({ width: img.clientWidth, height: img.clientHeight });
                    }}
                  />
                  {/* Object overlay — positioned directly over the img, scales with it */}
                  {showObjectOverlay && plateSolveInfo && imageDisplaySize.width > 0 && (
                    <svg
                      className="absolute inset-0 w-full h-full pointer-events-none"
                      viewBox={`0 0 1000 ${1000 * imageDisplaySize.height / imageDisplaySize.width}`}
                      preserveAspectRatio="none"
                    >
                    {catalogObjects.filter((obj) => (obj.magnitude ?? 99) <= magLimit + 2).map((obj, idx) => {
                      const pos = calculateObjectPosition(obj.ra, obj.dec, obj.pixelX, obj.pixelY);
                      if (!pos) return null;

                      // Calculate circle radius based on object size if available
                      let radius = 20; // Default radius in viewBox units
                      if (obj.radiusPx != null && plateSolveInfo.pixel_scale) {
                        // Use precomputed pixel radius, scaled to viewBox
                        const pixScale = plateSolveInfo.pixel_scale / 3600;
                        const fitsW = plateSolveInfo.width_deg / pixScale;
                        radius = Math.max(10, Math.min(400, (obj.radiusPx / fitsW) * 1000));
                      } else if (obj.sizeArcmin && plateSolveInfo.width_deg) {
                        const vbUnitsPerDegree = 1000 / plateSolveInfo.width_deg;
                        const vbUnitsPerArcmin = vbUnitsPerDegree / 60;
                        radius = Math.max(10, Math.min(400, (obj.sizeArcmin * vbUnitsPerArcmin) / 2));
                      }

                      // Calculate opacity: full at magLimit, fade to 0 over next 2 magnitudes
                      // Fill in missing magnitudes for known Messier objects
                      let mag = obj.magnitude ?? null;
                      if (mag == null) {
                        const mMatch = obj.name.replace(/\s+/g, '').toUpperCase().match(/^M(\d+)$/);
                        if (mMatch) {
                          const MESSIER_MAGS: Record<string, number> = {M1:8.4,M2:6.5,M3:6.2,M4:5.6,M5:5.6,M6:4.2,M7:3.3,M8:6.0,M9:7.7,M10:6.6,M11:6.3,M12:6.7,M13:5.8,M14:7.6,M15:6.2,M16:6.0,M17:6.0,M18:7.5,M19:6.8,M20:6.3,M21:6.5,M22:5.1,M23:6.9,M24:4.6,M25:6.5,M26:8.0,M27:7.4,M28:6.8,M29:7.1,M30:7.2,M31:3.4,M32:8.1,M33:5.7,M34:5.5,M35:5.3,M36:6.3,M37:6.2,M38:7.4,M39:4.6,M40:8.4,M41:4.5,M42:4.0,M43:9.0,M44:3.7,M45:1.6,M46:6.1,M47:4.4,M48:5.5,M49:8.4,M50:5.9,M51:8.4,M52:7.3,M53:7.6,M54:7.6,M55:6.3,M56:8.3,M57:8.8,M58:9.7,M59:9.6,M60:8.8,M61:9.7,M62:6.5,M63:8.6,M64:8.5,M65:9.3,M66:8.9,M67:6.1,M68:7.8,M69:7.6,M70:7.9,M71:8.2,M72:9.3,M73:9.0,M74:9.4,M75:8.5,M76:10.1,M77:8.9,M78:8.3,M79:7.7,M80:7.3,M81:6.9,M82:8.4,M83:7.6,M84:9.1,M85:9.1,M86:8.9,M87:8.6,M88:9.6,M89:9.8,M90:9.5,M91:10.2,M92:6.4,M93:6.0,M94:8.2,M95:9.7,M96:9.2,M97:9.9,M98:10.1,M99:9.9,M100:9.3,M101:7.9,M102:9.9,M103:7.4,M104:8.0,M105:9.3,M106:8.4,M107:7.9,M108:10.0,M109:9.8,M110:8.5};
                          mag = MESSIER_MAGS[`M${mMatch[1]}`] ?? 99;
                        } else {
                          mag = 99;
                        }
                      }
                      const fadeStart = magLimit;
                      const fadeEnd = magLimit + 2;
                      const opacity = mag <= fadeStart
                        ? 0.85
                        : Math.max(0.05, 0.85 * (1 - (mag - fadeStart) / (fadeEnd - fadeStart)));
                      const showLabel = mag <= fadeStart;

                      return (
                        <g key={`${obj.name}-${idx}`} opacity={opacity}>
                          {/* Circle marker */}
                          <circle
                            cx={pos.x}
                            cy={pos.y}
                            r={radius}
                            fill="none"
                            stroke="#6366f1"
                            strokeWidth="1.5"
                          />
                          {/* Small dots at cardinal points on circle */}
                          {[0, 90, 180, 270].map((angle) => {
                            const rad = (angle * Math.PI) / 180;
                            return (
                              <circle
                                key={angle}
                                cx={pos.x + radius * Math.cos(rad)}
                                cy={pos.y + radius * Math.sin(rad)}
                                r={2}
                                fill="#6366f1"
                              />
                            );
                          })}
                          {/* Object name label - only shown above magnitude limit */}
                          {showLabel && (
                            <text
                              x={pos.x}
                              y={pos.y + radius + 16}
                              textAnchor="middle"
                              fill="#6366f1"
                              fontSize="14"
                              fontWeight="500"
                              style={{
                                textShadow: "0 1px 3px rgba(0,0,0,0.9), 0 0 6px rgba(0,0,0,0.9)",
                              }}
                            >
                              {obj.commonName || obj.name}
                            </text>
                          )}
                        </g>
                      );
                    })}
                    </svg>
                  )}
                </div>
              </>
            ) : (
              <div className="aspect-video flex items-center justify-center">
                <ImageIcon className="w-24 h-24 text-muted-foreground/30" />
              </div>
            )}
          </div>
        </div>

        {/* Metadata Panel */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {isEditing ? (
                <>
                  <div>
                    <Label>Summary</Label>
                    <Input
                      value={editSummary}
                      onChange={(e) => setEditSummary(e.target.value)}
                      placeholder="Brief description"
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label>Description</Label>
                    <Textarea
                      value={editDescription}
                      onChange={(e) => setEditDescription(e.target.value)}
                      placeholder="Detailed description"
                      className="mt-1"
                      rows={3}
                    />
                  </div>
                  <div>
                    <Label>Tags</Label>
                    <Input
                      value={editTags}
                      onChange={(e) => setEditTags(e.target.value)}
                      placeholder="galaxy, nebula, cluster (comma separated)"
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label>Location</Label>
                    <Input
                      value={editLocation}
                      onChange={(e) => setEditLocation(e.target.value)}
                      placeholder="Observation location"
                      className="mt-1"
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button
                      onClick={handleSave}
                      disabled={updateImage.isPending}
                      className="flex-1"
                    >
                      <Save className="w-4 h-4 mr-2" />
                      {updateImage.isPending ? "Saving..." : "Save"}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => setIsEditing(false)}
                      className="flex-1"
                    >
                      Cancel
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  {/* === TOP: Capture Info === */}
                  {image.metadata && (() => {
                    try {
                      const meta = JSON.parse(image.metadata);
                      const parseFitsVal = (v: unknown): string | null => {
                        if (v == null) return null;
                        const s = String(v);
                        let m = s.match(/CharacterString\("([^"]*)"\)/);
                        if (m) return m[1].trim();
                        m = s.match(/RealFloatingNumber\(([\d.eE+-]+)\)/);
                        if (m) return m[1];
                        m = s.match(/IntegerNumber\((\d+)\)/);
                        if (m) return m[1];
                        if (s !== "None" && !s.startsWith("Some(")) return s;
                        return null;
                      };
                      const instrument = parseFitsVal(meta.INSTRUME || meta.instrume);
                      const telescope = parseFitsVal(meta.TELESCOP || meta.telescop);
                      const filter = parseFitsVal(meta.FILTER || meta.filter);
                      const exposure = parseFitsVal(meta.EXPTIME || meta.EXPOSURE || meta.exptime || meta.exposure);
                      const gain = parseFitsVal(meta.GAIN || meta.gain);
                      const stackCount = parseFitsVal(meta.STACKCNT || meta.NCOMBINE || meta.stackcnt || meta.ncombine);
                      const hasInfo = instrument || telescope || filter || exposure || gain || stackCount;
                      if (!hasInfo) return null;

                      // Calculate total integration time
                      const expNum = exposure ? Number(exposure) : 0;
                      const frames = stackCount ? Number(stackCount) : 0;
                      const totalSecs = expNum * frames;
                      const formatIntegration = (secs: number) => {
                        if (secs <= 0) return null;
                        if (secs < 60) return `${secs.toFixed(0)} sec`;
                        if (secs < 3600) return `${(secs / 60).toFixed(1)} min`;
                        const h = Math.floor(secs / 3600);
                        const m = Math.round((secs % 3600) / 60);
                        return m > 0 ? `${h} hr ${m} min` : `${h} hr`;
                      };

                      return (
                        <div>
                          <div className="flex items-center gap-2 mb-2">
                            <ImageIcon className="w-4 h-4 text-muted-foreground" />
                            <Label className="text-muted-foreground">Capture Info</Label>
                          </div>
                          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                            {instrument && (<><span className="text-muted-foreground">Camera</span><span>{instrument}</span></>)}
                            {telescope && (<><span className="text-muted-foreground">Telescope</span><span>{telescope}</span></>)}
                            {filter && (<><span className="text-muted-foreground">Filter</span><span>{filter}</span></>)}
                            {(exposure || stackCount) && (
                              <>
                                <span className="text-muted-foreground">Exposure</span>
                                <span>
                                  {exposure ? `${Number(exposure).toFixed(1)}s` : ""}
                                  {exposure && stackCount ? " \u00d7 " : ""}
                                  {stackCount ? `${stackCount} frames` : ""}
                                </span>
                              </>
                            )}
                            {gain && (<><span className="text-muted-foreground">Gain</span><span>{gain}</span></>)}
                            {totalSecs > 0 && (
                              <>
                                <span className="text-muted-foreground">Integration</span>
                                <span>{formatIntegration(totalSecs)}</span>
                              </>
                            )}
                          </div>
                        </div>
                      );
                    } catch { return null; }
                  })()}

                  {/* === Object Overlay Controls === */}
                  {plateSolveInfo && catalogObjects.length > 0 && (
                    <div className="pt-4 border-t space-y-3">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="object-overlay" className="flex items-center gap-2 cursor-pointer text-sm">
                          {showObjectOverlay ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                          Object Markers
                        </Label>
                        <Switch id="object-overlay" checked={showObjectOverlay} onCheckedChange={setShowObjectOverlay} />
                      </div>
                      {showObjectOverlay && (
                        <div className="space-y-1">
                          <div className="flex items-center justify-between text-xs text-muted-foreground">
                            <span>Magnitude limit</span>
                            <span>&#8804; {magLimit} ({catalogObjects.filter((o) => (o.magnitude ?? 99) <= magLimit).length} labeled, {catalogObjects.filter((o) => (o.magnitude ?? 99) <= magLimit + 2).length} visible)</span>
                          </div>
                          <input type="range" min={3} max={20} step={0.5} value={magLimit} onChange={(e) => setMagLimit(Number(e.target.value))} className="w-full accent-indigo-500" />
                        </div>
                      )}
                    </div>
                  )}

                  {/* === Sky Map === */}
                  {plateSolveInfo && (
                    <div className="pt-4 border-t">
                      <Button
                        variant="ghost"
                        className="w-full justify-between p-0 h-auto hover:bg-transparent"
                        onClick={() => {
                          setSkymapExpanded(!skymapExpanded);
                          if (!skymapExpanded && !skymapImage && !isLoadingSkymap) {
                            loadSkymap();
                          }
                        }}
                      >
                        <div className="flex items-center gap-2">
                          <Map className="w-4 h-4 text-muted-foreground" />
                          <Label className="text-muted-foreground cursor-pointer">Sky Map</Label>
                        </div>
                        <ChevronDown className={`w-4 h-4 transition-transform ${skymapExpanded ? "rotate-180" : ""}`} />
                      </Button>
                      {skymapExpanded && (
                        <div className="mt-2">
                          {isLoadingSkymap ? (
                            <div className="flex items-center justify-center py-8">
                              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                              <span className="ml-2 text-sm text-muted-foreground">Generating skymap...</span>
                            </div>
                          ) : skymapImage ? (
                            <div className="rounded-lg overflow-hidden border border-border">
                              <img src={skymapImage} alt="Sky map showing image location" className="w-full h-auto" />
                              <div className="p-2 bg-muted/30 text-xs text-muted-foreground flex items-center justify-between">
                                <span>Teal marker shows image center</span>
                                <Button variant="ghost" size="sm" onClick={() => { setSkymapImage(null); loadSkymap(); }} className="h-6 px-2">
                                  <RefreshCw className="w-3 h-3 mr-1" />
                                  Regenerate
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex flex-col items-center gap-2 py-4">
                              <p className="text-sm text-muted-foreground">Click to generate sky map</p>
                              <Button variant="outline" size="sm" onClick={loadSkymap} disabled={isLoadingSkymap}>
                                <Map className="w-4 h-4 mr-2" />
                                Generate
                              </Button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* === Details === */}
                  <div className="pt-4 border-t">
                    <div>
                      <Label className="text-muted-foreground">Filename</Label>
                      <p className="font-mono text-sm break-all">{image.filename}</p>
                    </div>
                  </div>

                  {image.summary && (
                    <div>
                      <Label className="text-muted-foreground">Summary</Label>
                      <p>{image.summary}</p>
                    </div>
                  )}

                  {image.description && (
                    <div>
                      <Label className="text-muted-foreground">Description</Label>
                      <div
                        className="text-sm prose prose-sm prose-invert max-w-none"
                        dangerouslySetInnerHTML={{ __html: descriptionHtml }}
                      />
                    </div>
                  )}

                  <div className="flex items-center gap-2">
                    <Calendar className="w-4 h-4 text-muted-foreground" />
                    <div className="text-sm">
                      {(() => {
                        // Try to get DATE-OBS from FITS metadata
                        if (image.metadata) {
                          try {
                            const meta = JSON.parse(image.metadata);
                            const raw = meta["DATE-OBS"] || meta["date-obs"];
                            if (raw) {
                              const m = String(raw).match(/CharacterString\("([^"]*)"\)/);
                              const dateStr = m ? m[1] : (String(raw) !== "None" ? String(raw) : null);
                              if (dateStr) {
                                const d = new Date(dateStr);
                                if (!isNaN(d.getTime())) {
                                  return (
                                    <>
                                      <div>{d.toLocaleString()}</div>
                                      <div className="text-xs text-muted-foreground">Observed</div>
                                    </>
                                  );
                                }
                              }
                            }
                          } catch { /* ignore */ }
                        }
                        return (
                          <>
                            <div>{new Date(image.created_at).toLocaleString()}</div>
                            <div className="text-xs text-muted-foreground">Imported</div>
                          </>
                        );
                      })()}
                    </div>
                  </div>

                  {image.location && (
                    <div className="flex items-center gap-2">
                      <MapPin className="w-4 h-4 text-muted-foreground" />
                      <span className="text-sm">{image.location}</span>
                    </div>
                  )}

                  {tags.length > 0 && (
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <Tag className="w-4 h-4 text-muted-foreground" />
                        <Label className="text-muted-foreground">Tags</Label>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {tags.map((tag) => (
                          <Badge key={tag} variant="secondary">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}

                  {image.collection_id && (
                    <div>
                      <Label className="text-muted-foreground">Collection</Label>
                      <Link
                        to={`/collections/${image.collection_id}`}
                        className="block text-sm text-primary hover:underline"
                      >
                        View Collection
                      </Link>
                    </div>
                  )}

                  {/* === Plate Solve Results === */}
                  {plateSolveInfo && (
                    <div className="pt-4 border-t">
                      <div className="flex items-center gap-2 mb-3">
                        <Sparkles className="w-4 h-4 text-teal-500" />
                        <Label className="text-teal-500">Plate Solve Results</Label>
                      </div>
                      <div className="space-y-3 text-sm">
                        {/* RA in HMS and decimal */}
                        <div>
                          <span className="text-muted-foreground">RA:</span>
                          <div className="ml-4">
                            <div className="font-mono">{raToHMS(plateSolveInfo.center_ra)}</div>
                            <div className="text-xs text-muted-foreground">
                              ({plateSolveInfo.center_ra?.toFixed(4)}°)
                            </div>
                          </div>
                        </div>
                        {/* Dec in DMS and decimal */}
                        <div>
                          <span className="text-muted-foreground">Dec:</span>
                          <div className="ml-4">
                            <div className="font-mono">{decToDMS(plateSolveInfo.center_dec)}</div>
                            <div className="text-xs text-muted-foreground">
                              ({plateSolveInfo.center_dec?.toFixed(4)}°)
                            </div>
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <span className="text-muted-foreground">Scale:</span>
                            <span className="ml-2">{plateSolveInfo.pixel_scale?.toFixed(2)}″/px</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">Rotation:</span>
                            <span className="ml-2">{plateSolveInfo.rotation?.toFixed(1)}°</span>
                          </div>
                        </div>
                        <div>
                          <span className="text-muted-foreground">FOV:</span>
                          <span className="ml-2">
                            {(plateSolveInfo.width_deg * 60)?.toFixed(1)}′ × {(plateSolveInfo.height_deg * 60)?.toFixed(1)}′
                          </span>
                        </div>
                        {calculatedFocalLength && (
                          <div>
                            <span className="text-muted-foreground">Est. Focal Length:</span>
                            <span className="ml-2">{calculatedFocalLength.toFixed(0)}mm</span>
                            <span className="text-xs text-muted-foreground ml-1">(from pixel scale)</span>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* === Catalog Objects === */}
                  {catalogObjects.length > 0 && (
                    <div className="pt-4 border-t">
                      <Button
                        variant="ghost"
                        className="w-full justify-between p-0 h-auto hover:bg-transparent"
                        onClick={() => setObjectsExpanded(!objectsExpanded)}
                      >
                        <div className="flex items-center gap-2">
                          <Tag className="w-4 h-4 text-muted-foreground" />
                          <Label className="text-muted-foreground cursor-pointer">
                            Objects in Field ({catalogObjects.length})
                          </Label>
                        </div>
                        <ChevronDown className={`w-4 h-4 transition-transform ${objectsExpanded ? "rotate-180" : ""}`} />
                      </Button>
                      {objectsExpanded && (
                        <div className="space-y-1 max-h-48 overflow-y-auto mt-2">
                          {catalogObjects.map((obj, idx) => (
                            <div
                              key={`${obj.name}-${idx}`}
                              className="flex items-center justify-between text-sm py-1 px-2 rounded hover:bg-muted/50"
                            >
                              <div className="flex items-center gap-2">
                                <Badge variant="outline" className="text-xs">
                                  {obj.catalog}
                                </Badge>
                                <span>{obj.name}</span>
                              </div>
                              {obj.magnitude && (
                                <span className="text-muted-foreground text-xs">
                                  mag {obj.magnitude.toFixed(1)}
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>

        </div>
      </div>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Image</DialogTitle>
          </DialogHeader>
          <p className="text-muted-foreground">
            Are you sure you want to delete &quot;{image.filename}&quot;? This action
            cannot be undone.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteImage.isPending}
            >
              {deleteImage.isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Plate Solve Dialog */}
      <Dialog open={plateSolveDialogOpen} onOpenChange={setPlateSolveDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Plate Solve Image</DialogTitle>
            <DialogDescription>
              Determine the sky coordinates and identify objects in this image using
              nova.astrometry.net. You'll need an API key from{" "}
              <a
                href="https://nova.astrometry.net/api_help"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                astrometry.net
              </a>.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="api-key">Astrometry.net API Key</Label>
              <Input
                id="api-key"
                type="password"
                value={plateSolveApiKey}
                onChange={(e) => setPlateSolveApiKey(e.target.value)}
                placeholder="Enter your API key"
              />
              <p className="text-xs text-muted-foreground">
                Your API key is stored locally and never sent to our servers.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPlateSolveDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handlePlateSolve} disabled={plateSolveSolver === "nova" && !plateSolveApiKey}>
              <Compass className="w-4 h-4 mr-2" />
              Start Plate Solve
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Processing Dialog */}
      <ProcessingDialog
        open={processingDialogOpen}
        onOpenChange={setProcessingDialogOpen}
        imageId={image?.id || ""}
        objectName={image?.summary || undefined}
        onProcess={(_result: ProcessImageResponse) => {
          // Refresh the image data to get updated metadata
          refetch();
        }}
      />
    </div>
  );
}
