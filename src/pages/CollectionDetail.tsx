/**
 * Collection Detail Page - View and manage a collection
 */

import { useState, useMemo, useRef } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { toast } from "sonner";
import SunCalc from "suncalc";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MoonImage } from "@/components/MoonImage";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
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
import {
  CheckSquare,
  Compass,
  FolderDown,
  FolderOpen,
  ImageIcon,
  Loader2,
  Map,
  MoreHorizontal,
  Play,
  Plus,
  Square,
  Star,
  Trash2,
  X,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import CollectFilesDialog from "@/components/CollectFilesDialog";
import CatalogCollectionView from "@/components/CatalogCollectionView";
import { useCollection, useCollections, useUpdateCollection, useDeleteCollection } from "@/hooks/use-collections";
import { useCollectionImages, useImages, useUpdateImage, imageKeys } from "@/hooks/use-images";
import { imageApi, plateSolveApi, type Image } from "@/lib/tauri/commands";
import { Progress } from "@/components/ui/progress";
import { getCollectionType } from "@/lib/collection-utils";
import { useQueryClient } from "@tanstack/react-query";
import SkyMapSheet from "@/components/SkyMapSheet";
import SlideshowConfigDialog from "@/components/SlideshowConfigDialog";
import { getImageFootprint, type ImageFootprint } from "@/lib/sky-map-utils";

// Get session date from collection metadata
function getSessionDate(collection: { metadata?: string | null }): Date | null {
  if (!collection.metadata) return null;
  try {
    const meta = JSON.parse(collection.metadata);
    if (meta.session_date) {
      return new Date(meta.session_date);
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}

export default function CollectionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editTags, setEditTags] = useState("");
  const [editVisibility, setEditVisibility] = useState("private");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [addImagesDialogOpen, setAddImagesDialogOpen] = useState(false);
  const [selectedImages, setSelectedImages] = useState<string[]>([]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedForRemoval, setSelectedForRemoval] = useState<string[]>([]);
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false);
  const [isRemovingImages, setIsRemovingImages] = useState(false);

  const queryClient = useQueryClient();
  const { data: collection, isLoading, error } = useCollection(id || "");
  const { data: collectionImages = [], error: imagesError, isLoading: imagesLoading } = useCollectionImages(id || "");
  const { data: allImages = [] } = useImages();
  const { data: allCollections = [] } = useCollections();
  const updateCollection = useUpdateCollection();
  const deleteCollection = useDeleteCollection();
  const updateImage = useUpdateImage();
  const [isAddingImages, setIsAddingImages] = useState(false);
  const [collectDialogOpen, setCollectDialogOpen] = useState(false);
  const [skyMapOpen, setSkyMapOpen] = useState(false);
  const [slideshowDialogOpen, setSlideshowDialogOpen] = useState(false);
  const [batchPlateSolveDialogOpen, setBatchPlateSolveDialogOpen] = useState(false);
  const [batchPlateSolveApiKey, setBatchPlateSolveApiKey] = useState(() => {
    return localStorage.getItem("astrometry_api_key") || "";
  });
  const [batchPlateSolveParallel, setBatchPlateSolveParallel] = useState(() => {
    const saved = localStorage.getItem("plate_solve_parallel");
    return saved ? parseInt(saved, 10) : 1;
  });
  const [isBatchPlateSolving, setIsBatchPlateSolving] = useState(false);
  const [batchPlateSolveProgress, setBatchPlateSolveProgress] = useState({ current: 0, total: 0, currentFilename: "", successCount: 0, failCount: 0, avgSolveTime: 0 });
  const batchPlateSolveCancelRef = useRef(false);

  // Check if this is a catalog collection
  const isCatalogCollection = collection
    ? getCollectionType(collection.template) === "catalog"
    : false;

  // Calculate plate solve stats for batch operation
  const plateSolveStats = useMemo(() => {
    const solved = collectionImages.filter(isPlateSolved);
    const unsolved = collectionImages.filter((img) => !isPlateSolved(img));
    const solvable = unsolved.filter((img) => !hasPlateSolveFailed(img));
    const failed = unsolved.filter(hasPlateSolveFailed);
    return {
      solvedCount: solved.length,
      unsolvedCount: unsolved.length,
      solvableCount: solvable.length,
      skippedCount: failed.length,
      totalCount: collectionImages.length,
      unsolvedImages: unsolved,
      solvableImages: solvable,
    };
  }, [collectionImages]);

  // Extract footprints for sky map
  const skyMapFootprints = useMemo((): ImageFootprint[] => {
    return collectionImages
      .map((img) => getImageFootprint(img, collection ?? undefined))
      .filter((fp): fp is ImageFootprint => fp !== null);
  }, [collectionImages, collection]);

  // Calculate moon phase for the session date
  const moonData = useMemo(() => {
    if (!collection) return null;
    const sessionDate = getSessionDate(collection);
    if (!sessionDate) return null;

    const moonIllumination = SunCalc.getMoonIllumination(sessionDate);
    return {
      date: sessionDate,
      dateFormatted: format(sessionDate, "eee MMM dd yyyy"),
      fraction: moonIllumination.fraction,
      illuminationPercent: Math.round(moonIllumination.fraction * 100),
      isWaxing: moonIllumination.phase <= 0.5,
    };
  }, [collection]);

  // Extract stacked image paths for raw file collection
  const stackedPaths = useMemo(() => {
    return collectionImages
      .filter((img) => img.url)
      .map((img) => img.url as string);
  }, [collectionImages]);

  // Debug logging
  console.log("CollectionDetail debug:", {
    id,
    collectionImages,
    imagesError,
    imagesLoading,
    collectionImagesLength: collectionImages.length,
  });

  // Images not in this collection (filter out ones already in collection)
  const collectionImageIds = new Set(collectionImages.map((img) => img.id));
  const availableImages = allImages.filter(
    (img) => !collectionImageIds.has(img.id)
  );

  // Start editing mode
  const handleStartEdit = () => {
    if (collection) {
      setEditName(collection.name);
      setEditDescription(collection.description || "");
      setEditTags(collection.tags || "");
      setEditVisibility(collection.visibility);
      setIsEditing(true);
    }
  };

  // Save edits
  const handleSave = async () => {
    if (!collection) return;

    try {
      await updateCollection.mutateAsync({
        id: collection.id,
        name: editName,
        description: editDescription || undefined,
        tags: editTags || undefined,
        visibility: editVisibility,
      });
      toast.success("Collection updated");
      setIsEditing(false);
    } catch (err) {
      toast.error("Failed to update collection");
      console.error(err);
    }
  };

  // Delete collection
  const handleDelete = async () => {
    if (!collection) return;

    try {
      await deleteCollection.mutateAsync(collection.id);
      toast.success("Collection deleted");
      navigate("/collections");
    } catch (err) {
      toast.error("Failed to delete collection");
      console.error(err);
    }
  };

  // Add images to collection
  const handleAddImages = async () => {
    if (!collection || selectedImages.length === 0) return;

    setIsAddingImages(true);
    try {
      // Add each selected image to this collection via many-to-many relationship
      for (const imageId of selectedImages) {
        await imageApi.addToCollection(imageId, collection.id);
      }
      // Invalidate queries to refresh the data
      await queryClient.invalidateQueries({ queryKey: imageKeys.byCollection(collection.id) });
      toast.success(`Added ${selectedImages.length} image(s) to collection`);
      setAddImagesDialogOpen(false);
      setSelectedImages([]);
    } catch (err) {
      toast.error("Failed to add images");
      console.error(err);
    } finally {
      setIsAddingImages(false);
    }
  };

  // Remove image from collection
  const handleRemoveImage = async (imageId: string) => {
    if (!collection) return;

    try {
      await imageApi.removeFromCollection(imageId, collection.id);
      // Invalidate queries to refresh the data
      await queryClient.invalidateQueries({ queryKey: imageKeys.byCollection(collection.id) });
      toast.success("Image removed from collection");
    } catch (err) {
      toast.error("Failed to remove image");
      console.error(err);
    }
  };

  // Toggle image selection for batch removal
  const toggleImageForRemoval = (imageId: string) => {
    setSelectedForRemoval((prev) =>
      prev.includes(imageId)
        ? prev.filter((id) => id !== imageId)
        : [...prev, imageId]
    );
  };

  // Select all images for removal
  const selectAllForRemoval = () => {
    setSelectedForRemoval(collectionImages.map((img) => img.id));
  };

  // Clear selection
  const clearSelection = () => {
    setSelectedForRemoval([]);
    setSelectionMode(false);
  };

  // Remove selected images from collection
  const handleRemoveSelected = async () => {
    if (!collection || selectedForRemoval.length === 0) return;

    setIsRemovingImages(true);
    setRemoveConfirmOpen(false);

    let successCount = 0;
    let failCount = 0;

    for (const imageId of selectedForRemoval) {
      try {
        await imageApi.removeFromCollection(imageId, collection.id);
        successCount++;
      } catch (err) {
        console.error(`Failed to remove image ${imageId}:`, err);
        failCount++;
      }
    }

    // Invalidate queries to refresh the data
    await queryClient.invalidateQueries({ queryKey: imageKeys.byCollection(collection.id) });

    setIsRemovingImages(false);
    setSelectedForRemoval([]);
    setSelectionMode(false);

    if (failCount === 0) {
      toast.success(`Removed ${successCount} image${successCount !== 1 ? "s" : ""} from collection`);
    } else {
      toast.info(`Removed ${successCount} image${successCount !== 1 ? "s" : ""}, ${failCount} failed`);
    }
  };

  // Toggle image favorite status
  const handleToggleFavorite = async (image: Image) => {
    try {
      await updateImage.mutateAsync({
        id: image.id,
        favorite: !image.favorite,
      });
      // Invalidate collection images to refresh
      await queryClient.invalidateQueries({ queryKey: imageKeys.byCollection(collection?.id || "") });
      toast.success(image.favorite ? "Removed from favorites" : "Added to favorites");
    } catch (err) {
      toast.error("Failed to update image");
      console.error(err);
    }
  };

  // Handle batch plate solve
  const handleBatchPlateSolve = async () => {
    if (!batchPlateSolveApiKey) {
      toast.error("Please enter an Astrometry.net API key");
      return;
    }

    if (plateSolveStats.solvableCount === 0) {
      if (plateSolveStats.skippedCount > 0) {
        toast.info(`All images are either solved or have previously failed (${plateSolveStats.skippedCount} skipped)`);
      } else {
        toast.info("All images are already plate solved");
      }
      return;
    }

    // Save settings to localStorage
    localStorage.setItem("astrometry_api_key", batchPlateSolveApiKey);
    localStorage.setItem("plate_solve_parallel", batchPlateSolveParallel.toString());

    // Reset cancel flag
    batchPlateSolveCancelRef.current = false;

    setIsBatchPlateSolving(true);
    setBatchPlateSolveDialogOpen(false);

    const localApiUrl = localStorage.getItem("local_astrometry_url") || undefined;
    const imagesToSolve = [...plateSolveStats.solvableImages]; // Copy to use as queue (excludes failed)
    const totalCount = imagesToSolve.length;
    let successCount = 0;
    let failCount = 0;
    let completedCount = 0;
    let queueIndex = 0; // Next image to process
    let totalSolveTime = 0; // Total time spent solving (in seconds)
    const activeImages: string[] = []; // Currently processing filenames

    const parallelCount = Math.max(1, Math.min(batchPlateSolveParallel, 10)); // Clamp between 1-10

    // Update progress display
    const updateProgress = () => {
      const avgSolveTime = completedCount > 0 ? totalSolveTime / completedCount : 0;
      setBatchPlateSolveProgress({
        current: completedCount,
        total: totalCount,
        currentFilename: activeImages.length > 0
          ? (activeImages.length === 1 ? activeImages[0] : `${activeImages.length} images in parallel`)
          : "",
        successCount,
        failCount,
        avgSolveTime,
      });
    };

    // Worker function that pulls from queue
    const worker = async (): Promise<void> => {
      while (!batchPlateSolveCancelRef.current) {
        // Get next image from queue
        const index = queueIndex++;
        if (index >= imagesToSolve.length) {
          break; // No more images
        }

        const img = imagesToSolve[index];
        activeImages.push(img.filename);
        updateProgress();

        const startTime = Date.now();
        try {
          const result = await plateSolveApi.solve({
            id: img.id,
            solver: "nova",
            apiKey: batchPlateSolveApiKey,
            apiUrl: localApiUrl,
            queryCatalogs: true,
            timeout: 300,
          });

          if (result.success) {
            successCount++;
          } else {
            console.warn(`Plate solve failed for ${img.filename}: ${result.errorMessage}`);
            failCount++;
          }
        } catch (err) {
          console.error(`Plate solve error for ${img.filename}:`, err);
          failCount++;
        }
        const elapsedTime = (Date.now() - startTime) / 1000; // Convert to seconds
        totalSolveTime += elapsedTime;

        // Remove from active list and update progress
        const activeIndex = activeImages.indexOf(img.filename);
        if (activeIndex > -1) {
          activeImages.splice(activeIndex, 1);
        }
        completedCount++;
        updateProgress();
      }
    };

    // Start worker pool - each worker pulls from queue as it completes
    const workers = Array(parallelCount).fill(null).map(() => worker());

    // Run workers and handle completion (don't block UI on cancel)
    Promise.all(workers).then(async () => {
      // Only update UI if not already cancelled (cancel handler updates UI immediately)
      if (!batchPlateSolveCancelRef.current) {
        // Refresh data after batch completes
        await queryClient.invalidateQueries({ queryKey: imageKeys.byCollection(collection?.id || "") });

        setIsBatchPlateSolving(false);
        setBatchPlateSolveProgress({ current: 0, total: 0, currentFilename: "", successCount: 0, failCount: 0, avgSolveTime: 0 });

        if (failCount === 0) {
          toast.success(`Plate solved ${successCount} image${successCount !== 1 ? "s" : ""}`);
        } else {
          toast.info(`Plate solved ${successCount} image${successCount !== 1 ? "s" : ""}, ${failCount} failed`);
        }
      } else {
        // Still refresh data even when cancelled (to show any images that completed)
        await queryClient.invalidateQueries({ queryKey: imageKeys.byCollection(collection?.id || "") });
      }
    });
  };

  // Cancel batch plate solve - immediately closes UI, workers finish in background
  const handleCancelBatchPlateSolve = async () => {
    batchPlateSolveCancelRef.current = true;
    setIsBatchPlateSolving(false);
    setBatchPlateSolveProgress({ current: 0, total: 0, currentFilename: "", successCount: 0, failCount: 0, avgSolveTime: 0 });
    // Immediately refresh data to pick up any failures that already completed
    await queryClient.invalidateQueries({ queryKey: imageKeys.byCollection(collection?.id || "") });
    toast.info("Cancelled. Any in-progress solves will complete in the background.");
  };

  // Toggle image selection
  const toggleImageSelection = (imageId: string) => {
    setSelectedImages((prev) =>
      prev.includes(imageId)
        ? prev.filter((id) => id !== imageId)
        : [...prev, imageId]
    );
  };

  if (isLoading) {
    return (
      <div className="min-h-full bg-slate-900 py-6 px-4 md:px-8">
        <p className="text-gray-400">Loading collection...</p>
      </div>
    );
  }

  if (error || !collection) {
    return (
      <div className="min-h-full bg-slate-900 py-6 px-4 md:px-8">
        <div className="text-center py-12">
          <FolderOpen className="w-12 h-12 mx-auto mb-4 text-gray-500" />
          <h2 className="text-xl font-semibold mb-2 text-white">Collection not found</h2>
          <p className="text-gray-400 mb-4">
            The requested collection could not be found.
          </p>
          <Link to="/collections">
            <Button variant="outline" className="bg-transparent border-gray-600 text-white hover:bg-gray-800">
              Back to Collections
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-slate-900 py-6 px-4 md:px-8">
      {/* Breadcrumb */}
      <Breadcrumb className="mb-6">
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link to="/" className="text-gray-400 hover:text-white">
                Home
              </Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator className="text-gray-600" />
          <BreadcrumbItem>
            <span className="text-gray-400">Default User</span>
          </BreadcrumbItem>
          <BreadcrumbSeparator className="text-gray-600" />
          <BreadcrumbItem>
            <BreadcrumbPage className="text-gray-300">{collection.name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {/* Header */}
      <div className="flex justify-between items-start mb-2">
        <h1 className="text-3xl font-bold text-white">{collection.name}</h1>
        <div className="flex items-center gap-2">
          {selectionMode ? (
            <>
              {/* Selection mode buttons */}
              <Button
                variant="outline"
                className="bg-transparent border-gray-600 text-white hover:bg-gray-800"
                onClick={selectAllForRemoval}
              >
                <CheckSquare className="w-4 h-4 mr-2" />
                Select All
              </Button>
              {selectedForRemoval.length > 0 && (
                <span className="px-2 py-1 bg-slate-700 rounded text-sm text-white">
                  {selectedForRemoval.length} selected
                </span>
              )}
              <Button
                variant="outline"
                className="bg-transparent border-gray-600 text-white hover:bg-gray-800"
                onClick={clearSelection}
              >
                <X className="w-4 h-4 mr-2" />
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => setRemoveConfirmOpen(true)}
                disabled={selectedForRemoval.length === 0}
              >
                <Trash2 className="w-4 h-4 mr-2" />
                Remove {selectedForRemoval.length > 0 ? `(${selectedForRemoval.length})` : ""}
              </Button>
            </>
          ) : (
            <>
              {/* Normal mode buttons */}
              {stackedPaths.length > 0 && !isCatalogCollection && (
                <Button
                  variant="outline"
                  className="bg-transparent border-gray-600 text-white hover:bg-gray-800"
                  onClick={() => setCollectDialogOpen(true)}
                  title="Collect raw subframe files"
                >
                  <FolderDown className="w-4 h-4 mr-2" />
                  Collect Files
                </Button>
              )}
              {!isCatalogCollection && collectionImages.length > 0 && (
                <Button
                  variant="outline"
                  className="bg-transparent border-gray-600 text-white hover:bg-gray-800"
                  onClick={() => setBatchPlateSolveDialogOpen(true)}
                  disabled={isBatchPlateSolving}
                  title="Plate solve all unsolved images"
                >
                  {isBatchPlateSolving ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Compass className="w-4 h-4 mr-2" />
                  )}
                  {isBatchPlateSolving ? "Solving..." : "Batch Plate Solve"}
                </Button>
              )}
              {!isCatalogCollection && skyMapFootprints.length > 0 && (
                <Button
                  variant="outline"
                  className="bg-transparent border-gray-600 text-white hover:bg-gray-800"
                  onClick={() => setSkyMapOpen(true)}
                  title="View sky coverage map"
                >
                  <Map className="w-4 h-4 mr-2" />
                  Sky Map
                </Button>
              )}
              {!isCatalogCollection && collectionImages.length > 0 && (
                <Button
                  variant="outline"
                  className="bg-transparent border-gray-600 text-white hover:bg-gray-800"
                  onClick={() => setSlideshowDialogOpen(true)}
                  title="Present images as a slideshow"
                >
                  <Play className="w-4 h-4 mr-2" />
                  Slideshow
                </Button>
              )}
              {!isCatalogCollection && collectionImages.length > 0 && (
                <Button
                  variant="outline"
                  className="bg-transparent border-gray-600 text-white hover:bg-gray-800"
                  onClick={() => setSelectionMode(true)}
                  title="Select images to remove"
                >
                  <Square className="w-4 h-4 mr-2" />
                  Select
                </Button>
              )}
              {!isCatalogCollection && (
                <Button
                  variant="outline"
                  className="bg-transparent border-gray-600 text-white hover:bg-gray-800"
                  onClick={() => setAddImagesDialogOpen(true)}
                >
                  <Plus className="w-4 h-4 mr-2" />
                  Add Image
                </Button>
              )}
              <Button
                variant="outline"
                className="bg-transparent border-gray-600 text-white hover:bg-gray-800"
                onClick={handleStartEdit}
              >
                Edit
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Main content area with moon phase on right */}
      <div className="flex gap-6 mb-8">
        {/* Left side - Description */}
        <div className="flex-1">
          {collection.description && (
            <p className="text-gray-300">{collection.description}</p>
          )}
        </div>

        {/* Right side - Moon Phase Widget */}
        {moonData && (
          <div className="flex-shrink-0">
            <div className="bg-black rounded-lg p-4 flex flex-col items-center border border-slate-700">
              <MoonImage
                illumination={moonData.fraction}
                waxing={moonData.isWaxing}
                diameter={100}
              />
              <div className="text-white mt-3">
                Phase: {moonData.illuminationPercent}%
              </div>
              <div className="text-sm text-gray-400 mt-1">
                Phase of moon on {moonData.dateFormatted}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Edit Dialog */}
      <Dialog open={isEditing} onOpenChange={setIsEditing}>
        <DialogContent className="bg-slate-800 border-slate-700 text-white sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Edit Collection</DialogTitle>
            <DialogDescription className="text-gray-400">
              Update the collection details.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="edit-name">Name</Label>
              <Input
                id="edit-name"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="bg-slate-700 border-slate-600"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-description">Description</Label>
              <Textarea
                id="edit-description"
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                className="bg-slate-700 border-slate-600 resize-none"
                rows={3}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-tags">Tags</Label>
              <Input
                id="edit-tags"
                value={editTags}
                onChange={(e) => setEditTags(e.target.value)}
                placeholder="galaxy, nebula (comma separated)"
                className="bg-slate-700 border-slate-600"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-visibility">Visibility</Label>
              <Select value={editVisibility} onValueChange={setEditVisibility}>
                <SelectTrigger className="bg-slate-700 border-slate-600">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-slate-700 border-slate-600">
                  <SelectItem value="private">Private</SelectItem>
                  <SelectItem value="public">Public</SelectItem>
                  <SelectItem value="unlisted">Unlisted</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => setIsEditing(false)}
              className="bg-transparent border-gray-600 text-white hover:bg-gray-700"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setIsEditing(false);
                setDeleteDialogOpen(true);
              }}
            >
              <Trash2 className="w-4 h-4 mr-2" />
              Delete
            </Button>
            <Button
              onClick={handleSave}
              disabled={updateCollection.isPending}
            >
              {updateCollection.isPending ? "Saving..." : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Main Content: Catalog View or Image Grid */}
      {isCatalogCollection ? (
        <CatalogCollectionView
          collection={collection}
          allImages={allImages}
          allCollections={allCollections}
        />
      ) : collectionImages.length === 0 ? (
        <div className="text-center py-12 bg-slate-800 rounded-lg">
          <ImageIcon className="w-12 h-12 mx-auto mb-4 text-gray-500" />
          <p className="text-white">No images yet</p>
          <p className="text-gray-400 text-sm mt-1">
            Add images to this collection
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {collectionImages.map((image) => (
            <ImageCard
              key={image.id}
              image={image}
              onRemove={() => handleRemoveImage(image.id)}
              onToggleFavorite={() => handleToggleFavorite(image)}
              selectionMode={selectionMode}
              isSelected={selectedForRemoval.includes(image.id)}
              onToggleSelect={() => toggleImageForRemoval(image.id)}
            />
          ))}
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="bg-slate-800 border-slate-700 text-white">
          <DialogHeader>
            <DialogTitle>Delete Collection</DialogTitle>
          </DialogHeader>
          <p className="text-gray-400">
            Are you sure you want to delete &quot;{collection.name}&quot;? This will not
            delete the images, but they will be removed from this collection.
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteDialogOpen(false)}
              className="bg-transparent border-gray-600 text-white hover:bg-gray-700"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteCollection.isPending}
            >
              {deleteCollection.isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove Images Confirmation Dialog */}
      <Dialog open={removeConfirmOpen} onOpenChange={setRemoveConfirmOpen}>
        <DialogContent className="bg-slate-800 border-slate-700 text-white">
          <DialogHeader>
            <DialogTitle>Remove Images from Collection</DialogTitle>
            <DialogDescription className="text-gray-400">
              Are you sure you want to remove {selectedForRemoval.length} image{selectedForRemoval.length !== 1 ? "s" : ""} from this collection?
            </DialogDescription>
          </DialogHeader>
          <p className="text-gray-400">
            The images will not be deleted from your library, only removed from &quot;{collection.name}&quot;.
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRemoveConfirmOpen(false)}
              className="bg-transparent border-gray-600 text-white hover:bg-gray-700"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleRemoveSelected}
              disabled={isRemovingImages}
            >
              {isRemovingImages ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Removing...
                </>
              ) : (
                <>
                  <Trash2 className="w-4 h-4 mr-2" />
                  Remove {selectedForRemoval.length} Image{selectedForRemoval.length !== 1 ? "s" : ""}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Images Dialog */}
      <Dialog open={addImagesDialogOpen} onOpenChange={setAddImagesDialogOpen}>
        <DialogContent className="bg-slate-800 border-slate-700 text-white max-w-2xl">
          <DialogHeader>
            <DialogTitle>Add Images to Collection</DialogTitle>
            <DialogDescription className="text-gray-400">
              Select images to add to &quot;{collection.name}&quot;
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[400px] overflow-y-auto">
            {availableImages.length === 0 ? (
              <p className="text-center text-gray-400 py-8">
                No available images to add
              </p>
            ) : (
              <div className="grid grid-cols-3 gap-3">
                {availableImages.map((image) => (
                  <div
                    key={image.id}
                    className={`relative cursor-pointer rounded-lg overflow-hidden border-2 transition-colors ${
                      selectedImages.includes(image.id)
                        ? "border-teal-500"
                        : "border-transparent"
                    }`}
                    onClick={() => toggleImageSelection(image.id)}
                  >
                    <div className="aspect-video bg-slate-700">
                      {image.thumbnail ? (
                        <img
                          src={image.thumbnail}
                          alt={image.filename}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <ImageIcon className="w-8 h-8 text-gray-500" />
                        </div>
                      )}
                    </div>
                    <p className="text-xs p-1 truncate text-gray-300">{image.filename}</p>
                    {selectedImages.includes(image.id) && (
                      <div className="absolute top-1 right-1 w-5 h-5 bg-teal-500 rounded-full flex items-center justify-center">
                        <span className="text-xs text-white">✓</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAddImagesDialogOpen(false)}
              className="bg-transparent border-gray-600 text-white hover:bg-gray-700"
            >
              Cancel
            </Button>
            <Button
              onClick={handleAddImages}
              disabled={selectedImages.length === 0 || isAddingImages}
            >
              {isAddingImages
                ? "Adding..."
                : `Add ${selectedImages.length} Image${selectedImages.length !== 1 ? "s" : ""}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Batch Plate Solve Dialog */}
      <Dialog open={batchPlateSolveDialogOpen} onOpenChange={setBatchPlateSolveDialogOpen}>
        <DialogContent className="bg-slate-800 border-slate-700 text-white sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Batch Plate Solve</DialogTitle>
            <DialogDescription className="text-gray-400">
              Plate solve all images in this collection that haven't been solved yet.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {/* Stats */}
            <div className="bg-slate-900 rounded-lg p-4 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Total images:</span>
                <span className="text-white font-medium">{plateSolveStats.totalCount}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Already solved:</span>
                <span className="text-teal-400 font-medium">{plateSolveStats.solvedCount}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Ready to solve:</span>
                <span className="text-amber-400 font-medium">{plateSolveStats.solvableCount}</span>
              </div>
              {plateSolveStats.skippedCount > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Previously failed (skipped):</span>
                  <span className="text-red-400 font-medium">{plateSolveStats.skippedCount}</span>
                </div>
              )}
            </div>

            {plateSolveStats.solvableCount === 0 ? (
              <p className="text-center text-teal-400 text-sm">
                {plateSolveStats.skippedCount > 0
                  ? "All remaining images have previously failed plate solving."
                  : "All images in this collection are already plate solved!"}
              </p>
            ) : (
              <>
                {/* API Key Input */}
                <div className="space-y-2">
                  <Label htmlFor="batch-api-key">Astrometry.net API Key</Label>
                  <Input
                    id="batch-api-key"
                    type="password"
                    value={batchPlateSolveApiKey}
                    onChange={(e) => setBatchPlateSolveApiKey(e.target.value)}
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

                {/* Parallel Processing */}
                <div className="space-y-2">
                  <Label htmlFor="batch-parallel">Parallel Processing</Label>
                  <Input
                    id="batch-parallel"
                    type="number"
                    min={1}
                    max={10}
                    value={batchPlateSolveParallel}
                    onChange={(e) => setBatchPlateSolveParallel(Math.max(1, Math.min(10, parseInt(e.target.value) || 1)))}
                    className="bg-slate-700 border-slate-600 w-24"
                  />
                  <p className="text-xs text-gray-500">
                    Number of images to solve simultaneously (1-10). Higher values are faster but use more API quota.
                  </p>
                </div>

                {/* Warning */}
                <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 text-sm text-amber-200">
                  <strong>Note:</strong> This will submit {plateSolveStats.solvableCount} image{plateSolveStats.solvableCount !== 1 ? "s" : ""} to Astrometry.net for plate solving.
                  Each image may take a few minutes to process.
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setBatchPlateSolveDialogOpen(false)}
              className="bg-transparent border-gray-600 text-white hover:bg-gray-700"
            >
              Cancel
            </Button>
            {plateSolveStats.solvableCount > 0 && (
              <Button
                onClick={handleBatchPlateSolve}
                disabled={!batchPlateSolveApiKey}
              >
                <Compass className="w-4 h-4 mr-2" />
                Solve {plateSolveStats.solvableCount} Image{plateSolveStats.solvableCount !== 1 ? "s" : ""}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Batch Plate Solve Progress Overlay */}
      {isBatchPlateSolving && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="bg-slate-800 border border-slate-700 rounded-lg p-6 max-w-md w-full mx-4 space-y-4">
            <div className="flex items-center gap-3">
              <Loader2 className="w-6 h-6 text-teal-500 animate-spin" />
              <div>
                <h3 className="text-white font-medium">
                  {batchPlateSolveCancelRef.current ? "Cancelling..." : "Plate Solving..."}
                </h3>
                <p className="text-sm text-gray-400">
                  {batchPlateSolveProgress.current} of {batchPlateSolveProgress.total} completed
                </p>
              </div>
            </div>
            <Progress
              value={(batchPlateSolveProgress.current / batchPlateSolveProgress.total) * 100}
              className="h-2"
            />
            {batchPlateSolveProgress.currentFilename && (
              <p className="text-xs text-gray-500 truncate">
                Processing: {batchPlateSolveProgress.currentFilename}
              </p>
            )}
            <div className="flex justify-between text-sm">
              <span className="text-teal-400">
                {batchPlateSolveProgress.successCount} solved
              </span>
              {batchPlateSolveProgress.avgSolveTime > 0 && (
                <span className="text-gray-400">
                  Avg: {batchPlateSolveProgress.avgSolveTime.toFixed(1)}s
                </span>
              )}
              {batchPlateSolveProgress.failCount > 0 && (
                <span className="text-red-400">
                  {batchPlateSolveProgress.failCount} failed
                </span>
              )}
            </div>
            <Button
              variant="outline"
              onClick={handleCancelBatchPlateSolve}
              disabled={batchPlateSolveCancelRef.current}
              className="w-full bg-transparent border-gray-600 text-white hover:bg-gray-700"
            >
              {batchPlateSolveCancelRef.current ? "Cancelling..." : "Cancel"}
            </Button>
          </div>
        </div>
      )}

      {/* Collect Files Dialog */}
      <CollectFilesDialog
        open={collectDialogOpen}
        onOpenChange={setCollectDialogOpen}
        targetName={collection.name}
        stackedPaths={stackedPaths}
      />

      {/* Sky Map Sheet */}
      <SkyMapSheet
        open={skyMapOpen}
        onOpenChange={setSkyMapOpen}
        images={skyMapFootprints}
        title={`${collection.name} - Sky Map`}
      />

      {/* Slideshow Config Dialog */}
      <SlideshowConfigDialog
        open={slideshowDialogOpen}
        onOpenChange={setSlideshowDialogOpen}
        preselectedCollectionId={id}
      />
    </div>
  );
}

// Check if an image has been plate-solved
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

// Check if plate solving has previously failed for an image
function hasPlateSolveFailed(image: Image): boolean {
  if (!image.metadata) return false;
  try {
    const metadata =
      typeof image.metadata === "string"
        ? JSON.parse(image.metadata)
        : image.metadata;
    return !!metadata.plate_solve_failed;
  } catch {
    return false;
  }
}

function ImageCard({
  image,
  onRemove,
  onToggleFavorite,
  selectionMode = false,
  isSelected = false,
  onToggleSelect,
}: {
  image: Image;
  onRemove: () => void;
  onToggleFavorite: () => void;
  selectionMode?: boolean;
  isSelected?: boolean;
  onToggleSelect?: () => void;
}) {
  const navigate = useNavigate();
  const plateSolved = isPlateSolved(image);

  const handlePlateSolve = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Navigate to image viewer where plate solving can be done
    navigate(`/i/${image.id}?action=platesolve`);
  };

  const handleClick = (e: React.MouseEvent) => {
    if (selectionMode && onToggleSelect) {
      e.preventDefault();
      onToggleSelect();
    }
  };

  const cardContent = (
    <>
      <div className="aspect-video bg-slate-700 relative">
        {image.thumbnail ? (
          <img
            src={image.thumbnail}
            alt={image.filename}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <ImageIcon className="w-10 h-10 text-gray-500" />
          </div>
        )}
        {/* Plate-solved indicator */}
        {plateSolved && (
          <div
            className="absolute bottom-2 left-2 w-6 h-6 bg-teal-500/90 rounded-full flex items-center justify-center"
            title="Plate solved"
          >
            <Compass className="w-3.5 h-3.5 text-white" />
          </div>
        )}
        {/* Selection checkbox */}
        {selectionMode && (
          <div className="absolute top-2 left-2">
            <div
              className={`w-6 h-6 rounded flex items-center justify-center transition-colors ${
                isSelected
                  ? "bg-teal-500 text-white"
                  : "bg-black/50 text-white border border-white/50"
              }`}
            >
              {isSelected ? (
                <CheckSquare className="w-4 h-4" />
              ) : (
                <Square className="w-4 h-4" />
              )}
            </div>
          </div>
        )}
      </div>
      <div className="p-2">
        <p className="font-medium truncate text-sm text-white">{image.summary || image.filename}</p>
        {image.favorite && (
          <Star className="w-4 h-4 text-yellow-500 fill-yellow-500 inline" />
        )}
      </div>
    </>
  );

  return (
    <div
      className={`group relative rounded-lg overflow-hidden bg-slate-800 border transition-colors ${
        isSelected ? "border-teal-500 ring-2 ring-teal-500/50" : "border-slate-700"
      } ${selectionMode ? "cursor-pointer" : ""}`}
      onClick={handleClick}
    >
      {selectionMode ? (
        cardContent
      ) : (
        <Link to={`/i/${image.id}`}>{cardContent}</Link>
      )}

      {/* Dropdown Menu - hidden in selection mode */}
      {!selectionMode && (
        <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="p-1.5 rounded hover:bg-white/20 transition-colors bg-black/50"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
            >
              <MoreHorizontal className="h-4 w-4 text-white" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="bg-slate-800 border-slate-700">
            <DropdownMenuItem
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onToggleFavorite();
              }}
              className="text-white hover:bg-slate-700 cursor-pointer"
            >
              <Star className={`w-4 h-4 mr-2 ${image.favorite ? "text-yellow-500 fill-yellow-500" : ""}`} />
              {image.favorite ? "Remove from Favorites" : "Add to Favorites"}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={handlePlateSolve}
              className="text-white hover:bg-slate-700 cursor-pointer"
            >
              <Compass className={`w-4 h-4 mr-2 ${plateSolved ? "text-teal-500" : ""}`} />
              {plateSolved ? "Re-solve Plate" : "Plate Solve"}
            </DropdownMenuItem>
            <DropdownMenuSeparator className="bg-slate-700" />
            <DropdownMenuItem
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onRemove();
              }}
              className="text-red-400 hover:bg-slate-700 cursor-pointer"
            >
              <Trash2 className="w-4 h-4 mr-2" />
              Remove from Collection
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      )}
    </div>
  );
}
