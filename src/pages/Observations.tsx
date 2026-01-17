/**
 * Observations Page - View and manage observation collections
 */

import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Button } from "@/components/ui/button";
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
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, FolderOpen, FolderSearch, Loader2, MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useUpdateCollection, useDeleteCollection } from "@/hooks/use-collections";
import { toast } from "sonner";
import { useCollections, useCreateCollection } from "@/hooks/use-collections";
import { useImages } from "@/hooks/use-images";
import type { Collection, BulkScanPreview, Image } from "@/lib/tauri/commands";
import { parseTags, scanApi, collectionImageApi, imageApi } from "@/lib/tauri/commands";

export default function ObservationsPage() {
  const { data: collections = [], isLoading, refetch } = useCollections();
  const { refetch: refetchImages } = useImages();
  const createCollection = useCreateCollection();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState("");
  const [newCollectionDescription, setNewCollectionDescription] = useState("");
  const [newCollectionTags, setNewCollectionTags] = useState("");
  const [newCollectionSessionDate, setNewCollectionSessionDate] = useState(
    new Date().toISOString().split("T")[0]
  );
  const [newCollectionTemplate, setNewCollectionTemplate] = useState("astrolog");
  const [newCollectionVisibility, setNewCollectionVisibility] = useState("private");

  // Bulk scan state
  const [isScanDialogOpen, setIsScanDialogOpen] = useState(false);
  const [scanDirectory, setScanDirectory] = useState("");
  const [scanTags, setScanTags] = useState("");
  const [scanStackedOnly, setScanStackedOnly] = useState(true);
  const [scanMaxFiles, setScanMaxFiles] = useState<number | undefined>(undefined);
  const [scanPreview, setScanPreview] = useState<BulkScanPreview | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [scanResult, setScanResult] = useState<{
    images_imported: number;
    collections_created: number;
    images_skipped: number;
    errors: string[];
  } | null>(null);

  // Scan progress state
  const [scanProgress, setScanProgress] = useState<{
    current: number;
    total: number;
    currentFile: string;
    percent: number;
  } | null>(null);

  // Image counts and preview thumbnails for collections
  const [imageCounts, setImageCounts] = useState<Record<string, number>>({});
  const [previewImages, setPreviewImages] = useState<Record<string, Image | null>>({});
  const [showArchived, setShowArchived] = useState(false);

  // Fetch image counts and preview images for all collections
  useEffect(() => {
    const fetchCollectionData = async () => {
      const counts: Record<string, number> = {};
      const previews: Record<string, Image | null> = {};

      for (const collection of collections) {
        try {
          // Fetch count
          const count = await collectionImageApi.getCount(collection.id);
          counts[collection.id] = count;

          // Fetch images to get preview (first image or favorite)
          if (count > 0) {
            const images = await imageApi.getByCollection(collection.id);
            // Prefer favorite image, otherwise use first image
            const favorite = images.find((img) => img.favorite);
            previews[collection.id] = favorite || images[0] || null;
          } else {
            previews[collection.id] = null;
          }
        } catch (err) {
          console.error(`Error fetching data for ${collection.id}:`, err);
          counts[collection.id] = 0;
          previews[collection.id] = null;
        }
      }

      setImageCounts(counts);
      setPreviewImages(previews);
    };

    if (collections.length > 0) {
      fetchCollectionData();
    }
  }, [collections]);

  // Get image count for each collection
  const getImageCount = (collectionId: string) => {
    return imageCounts[collectionId] ?? 0;
  };

  // Get preview image for each collection
  const getPreviewImage = (collectionId: string) => {
    return previewImages[collectionId] || null;
  };

  // Filter and group collections by month
  const filteredCollections = showArchived
    ? collections.filter((c) => c.archived)
    : collections.filter((c) => !c.archived);
  const archivedCount = collections.filter((c) => c.archived).length;
  const groupedCollections = groupCollectionsByMonth(filteredCollections);

  const handleCreateCollection = async () => {
    if (!newCollectionName.trim()) return;

    await createCollection.mutateAsync({
      name: newCollectionName,
      description: newCollectionDescription || undefined,
      tags: newCollectionTags || undefined,
      template: newCollectionTemplate || undefined,
      visibility: newCollectionVisibility || "private",
    });

    // Reset form
    setNewCollectionName("");
    setNewCollectionDescription("");
    setNewCollectionTags("");
    setNewCollectionSessionDate(new Date().toISOString().split("T")[0]);
    setNewCollectionTemplate("astrolog");
    setNewCollectionVisibility("private");
    setIsDialogOpen(false);
  };

  // Bulk scan handlers
  const handleSelectDirectory = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Select Directory to Scan",
      });
      if (selected && typeof selected === "string") {
        setScanDirectory(selected);
        setScanPreview(null);
        setScanResult(null);
      }
    } catch (error) {
      console.error("Failed to open directory picker:", error);
    }
  };

  const handlePreviewScan = async () => {
    if (!scanDirectory) return;
    setIsPreviewing(true);
    setScanPreview(null);
    try {
      const preview = await scanApi.preview({
        directory: scanDirectory,
        tags: scanTags || undefined,
        stacked_only: scanStackedOnly,
        max_files: scanMaxFiles,
      });
      setScanPreview(preview);
    } catch (error) {
      console.error("Preview failed:", error);
    } finally {
      setIsPreviewing(false);
    }
  };

  const handleBulkScan = async () => {
    if (!scanDirectory) return;

    // Close the dialog first so the overlay is visible
    setIsScanDialogOpen(false);
    setIsScanning(true);
    setScanProgress(null);

    // Set up progress event listener
    let unlisten: UnlistenFn | null = null;
    try {
      unlisten = await listen<{
        current: number;
        total: number;
        current_file: string;
        percent: number;
      }>("scan-progress", (event) => {
        setScanProgress({
          current: event.payload.current,
          total: event.payload.total,
          currentFile: event.payload.current_file,
          percent: event.payload.percent,
        });
      });
    } catch (err) {
      console.error("Failed to set up progress listener:", err);
    }

    // Wait for next frame to ensure the overlay renders before starting scan
    await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 50)));

    try {
      const result = await scanApi.scan({
        directory: scanDirectory,
        tags: scanTags || undefined,
        stacked_only: scanStackedOnly,
        max_files: scanMaxFiles,
      });

      // Refresh collections and images
      refetch();
      refetchImages();

      // Re-open dialog to show results
      setScanResult(result);
      setIsScanDialogOpen(true);
    } catch (error) {
      console.error("Scan failed:", error);
      setScanResult({
        images_imported: 0,
        collections_created: 0,
        images_skipped: 0,
        errors: [String(error)],
      });
      // Re-open dialog to show error
      setIsScanDialogOpen(true);
    } finally {
      // Clean up listener
      if (unlisten) {
        unlisten();
      }
      setIsScanning(false);
      setScanProgress(null);
    }
  };

  const resetScanDialog = () => {
    setScanDirectory("");
    setScanTags("");
    setScanStackedOnly(true);
    setScanMaxFiles(undefined);
    setScanPreview(null);
    setScanResult(null);
  };

  return (
    <div className="min-h-full bg-slate-900 py-6 px-4 md:px-8">
      {/* Full-screen Scanning Overlay - z-[100] to appear above Dialog (z-50) */}
      {isScanning && (
        <div className="fixed inset-0 bg-black/90 z-[100] flex items-center justify-center">
          <div className="bg-slate-800 rounded-lg p-8 max-w-md w-full mx-4 shadow-2xl border border-slate-700">
            <h2 className="text-xl font-semibold text-white mb-4 text-center">Importing Images...</h2>

            {/* Progress bar */}
            <div className="mb-4">
              <div className="flex justify-between text-sm text-gray-400 mb-2">
                <span>
                  {scanProgress
                    ? `${scanProgress.current} of ${scanProgress.total}`
                    : "Preparing..."}
                </span>
                <span>{scanProgress ? `${scanProgress.percent}%` : "0%"}</span>
              </div>
              <div className="w-full bg-slate-700 rounded-full h-3 overflow-hidden">
                <div
                  className="bg-teal-500 h-full rounded-full transition-all duration-300 ease-out"
                  style={{ width: `${scanProgress?.percent ?? 0}%` }}
                />
              </div>
            </div>

            {/* Current file */}
            {scanProgress && (
              <p className="text-gray-400 text-sm text-center truncate">
                Processing: {scanProgress.currentFile}
              </p>
            )}

            {!scanProgress && (
              <p className="text-gray-400 text-sm text-center">
                Scanning directory and generating thumbnails...
              </p>
            )}
          </div>
        </div>
      )}

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
            <BreadcrumbPage className="text-gray-300">Astro Log</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {/* Header */}
      <div className="flex justify-between items-start mb-4">
        <h1 className="text-3xl font-bold text-white">
          {showArchived ? "Archived Observations" : "Observation Log"}
        </h1>
        <div className="flex gap-2">
          {/* Archive Toggle */}
          {archivedCount > 0 && (
            <Button
              variant={showArchived ? "default" : "outline"}
              onClick={() => setShowArchived(!showArchived)}
              className={showArchived ? "" : "bg-transparent border-gray-600 text-white hover:bg-gray-800"}
            >
              {showArchived ? "Show Active" : `Archived (${archivedCount})`}
            </Button>
          )}
          {/* Bulk Scan Dialog */}
          <Dialog
            open={isScanDialogOpen}
            onOpenChange={(open) => {
              setIsScanDialogOpen(open);
              if (!open) resetScanDialog();
            }}
          >
            <DialogTrigger asChild>
              <Button variant="outline" className="bg-transparent border-gray-600 text-white hover:bg-gray-800">
                <FolderSearch className="w-4 h-4 mr-2" />
                Scan Directory
              </Button>
            </DialogTrigger>
            <DialogContent className="bg-slate-800 border-slate-700 text-white sm:max-w-[525px]">
              <DialogHeader>
                <DialogTitle>Bulk Scan Directory</DialogTitle>
                <DialogDescription className="text-gray-400">
                  Scan a directory for stacked astronomy images and import them into collections.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                {/* Directory Selection */}
                <div className="space-y-2">
                  <Label htmlFor="scan-directory">Directory</Label>
                  <div className="flex gap-2">
                    <Input
                      id="scan-directory"
                      value={scanDirectory}
                      readOnly
                      placeholder="Select a directory to scan..."
                      className="bg-slate-700 border-slate-600 flex-1"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleSelectDirectory}
                      className="bg-slate-700 border-slate-600 hover:bg-slate-600"
                    >
                      <FolderOpen className="w-4 h-4" />
                    </Button>
                  </div>
                </div>

                {/* Tags */}
                <div className="space-y-2">
                  <Label htmlFor="scan-tags">Tags</Label>
                  <Input
                    id="scan-tags"
                    value={scanTags}
                    onChange={(e) => setScanTags(e.target.value)}
                    placeholder="galaxy, deep-sky, widefield"
                    className="bg-slate-700 border-slate-600"
                  />
                  <p className="text-xs text-gray-500">
                    Optional. Tags will be applied to all imported images.
                  </p>
                </div>

                {/* Stacked Only Checkbox */}
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="stacked-only"
                    checked={scanStackedOnly}
                    onCheckedChange={(checked) => setScanStackedOnly(checked === true)}
                  />
                  <Label htmlFor="stacked-only" className="text-sm font-normal cursor-pointer">
                    Only import stacked images (skip raw subframes)
                  </Label>
                </div>

                {/* Max Files Limit */}
                <div className="space-y-2">
                  <Label htmlFor="max-files" className="text-sm text-gray-300">
                    Maximum Files (optional)
                  </Label>
                  <Input
                    id="max-files"
                    type="number"
                    min="1"
                    value={scanMaxFiles || ""}
                    onChange={(e) => {
                      const val = e.target.value;
                      setScanMaxFiles(val ? parseInt(val, 10) : undefined);
                    }}
                    placeholder="No limit"
                    className="bg-slate-700 border-slate-600 w-32"
                  />
                  <p className="text-xs text-gray-500">
                    Limit imports for large directories (e.g., 100 images at a time)
                  </p>
                </div>

                {/* Scanning Progress */}
                {isScanning && (
                  <div className="bg-slate-900 rounded-lg p-6 text-center">
                    <Loader2 className="w-10 h-10 mx-auto mb-3 animate-spin text-teal-400" />
                    <h4 className="font-medium text-white mb-2">Importing Images...</h4>
                    <p className="text-gray-400 text-sm">
                      This may take a while depending on the number of images.
                      <br />
                      Generating thumbnails and extracting FITS metadata.
                    </p>
                  </div>
                )}

                {/* Preview Results */}
                {scanPreview && !scanResult && !isScanning && (
                  <div className="bg-slate-900 rounded-lg p-4 space-y-2">
                    <h4 className="font-medium text-white">Preview Results</h4>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <span className="text-gray-400">Total images found:</span>
                      <span className="text-white">{scanPreview.total_images}</span>
                      <span className="text-gray-400">Stacked images:</span>
                      <span className="text-white">{scanPreview.stacked_images}</span>
                      <span className="text-gray-400">Raw subframes:</span>
                      <span className="text-white">{scanPreview.raw_subframes}</span>
                      <span className="text-gray-400">With FITS data:</span>
                      <span className="text-white">{scanPreview.with_fits}</span>
                      <span className="text-gray-400">With JPEG:</span>
                      <span className="text-white">{scanPreview.with_jpeg}</span>
                    </div>
                    {scanPreview.sample_files.length > 0 && (
                      <div className="mt-3">
                        <p className="text-gray-400 text-xs mb-1">Sample files:</p>
                        <div className="max-h-24 overflow-y-auto">
                          {scanPreview.sample_files.slice(0, 5).map((file, idx) => (
                            <p key={idx} className="text-xs text-gray-300 truncate">
                              {file.name}
                              {file.is_stacked && (
                                <span className="text-teal-400 ml-1">(stacked)</span>
                              )}
                            </p>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Scan Results */}
                {scanResult && (
                  <div className="bg-slate-900 rounded-lg p-4 space-y-2">
                    <h4 className="font-medium text-white">Import Complete</h4>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <span className="text-gray-400">Images imported:</span>
                      <span className="text-green-400">{scanResult.images_imported}</span>
                      <span className="text-gray-400">Collections created:</span>
                      <span className="text-green-400">{scanResult.collections_created}</span>
                      <span className="text-gray-400">Images skipped:</span>
                      <span className="text-yellow-400">{scanResult.images_skipped}</span>
                    </div>
                    {scanResult.errors.length > 0 && (
                      <div className="mt-3">
                        <p className="text-red-400 text-xs mb-1">
                          Errors ({scanResult.errors.length}):
                        </p>
                        <div className="max-h-24 overflow-y-auto">
                          {scanResult.errors.slice(0, 5).map((error, idx) => (
                            <p key={idx} className="text-xs text-red-300">
                              {error}
                            </p>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
              <DialogFooter className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => setIsScanDialogOpen(false)}
                  className="bg-transparent border-gray-600 text-white hover:bg-gray-700"
                >
                  {scanResult ? "Close" : "Cancel"}
                </Button>
                {!scanResult && (
                  <>
                    <Button
                      variant="outline"
                      onClick={handlePreviewScan}
                      disabled={!scanDirectory || isPreviewing}
                      className="bg-slate-700 border-slate-600 hover:bg-slate-600"
                    >
                      {isPreviewing ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          Previewing...
                        </>
                      ) : (
                        "Preview"
                      )}
                    </Button>
                    <Button
                      onClick={handleBulkScan}
                      disabled={!scanDirectory || isScanning}
                    >
                      {isScanning ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          Importing...
                        </>
                      ) : (
                        "Import"
                      )}
                    </Button>
                  </>
                )}
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* New Collection Dialog */}
          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" className="bg-transparent border-gray-600 text-white hover:bg-gray-800">
              <Plus className="w-4 h-4 mr-2" />
              New Collection
            </Button>
          </DialogTrigger>
          <DialogContent className="bg-slate-800 border-slate-700 text-white sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle>Create New Collection</DialogTitle>
              <DialogDescription className="text-gray-400">
                Create a new collection to organize your astronomy observations and photos.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="name">Collection Name</Label>
                <Input
                  id="name"
                  value={newCollectionName}
                  onChange={(e) => setNewCollectionName(e.target.value)}
                  placeholder="e.g., M31 Andromeda Galaxy"
                  className="bg-slate-700 border-slate-600"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  value={newCollectionDescription}
                  onChange={(e) => setNewCollectionDescription(e.target.value)}
                  placeholder="Add a description of your observation session..."
                  className="bg-slate-700 border-slate-600 resize-none"
                />
                <p className="text-xs text-gray-500">Optional. Supports markdown formatting.</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="session_date">Session Date</Label>
                <Input
                  id="session_date"
                  type="date"
                  value={newCollectionSessionDate}
                  onChange={(e) => setNewCollectionSessionDate(e.target.value)}
                  className="bg-slate-700 border-slate-600"
                />
                <p className="text-xs text-gray-500">Date of your observation session</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="template">Collection Type</Label>
                <Select value={newCollectionTemplate} onValueChange={setNewCollectionTemplate}>
                  <SelectTrigger className="w-full bg-slate-700 border-slate-600">
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-700 border-slate-600">
                    <SelectItem value="general">General Collection</SelectItem>
                    <SelectItem value="astrolog">Observation Log</SelectItem>
                    <SelectItem value="messier">Messier Object</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-gray-500">Choose the type of collection to organize your content</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="visibility">Visibility</Label>
                <Select value={newCollectionVisibility} onValueChange={setNewCollectionVisibility}>
                  <SelectTrigger className="w-full bg-slate-700 border-slate-600">
                    <SelectValue placeholder="Select visibility" />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-700 border-slate-600">
                    <SelectItem value="private">Private</SelectItem>
                    <SelectItem value="public">Public</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-gray-500">Private collections are only visible to you</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="tags">Tags</Label>
                <Input
                  id="tags"
                  value={newCollectionTags}
                  onChange={(e) => setNewCollectionTags(e.target.value)}
                  placeholder="galaxy, deep-sky, widefield"
                  className="bg-slate-700 border-slate-600"
                />
                <p className="text-xs text-gray-500">Optional. Enter comma-separated tags to categorize your collection.</p>
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setIsDialogOpen(false)}
                className="bg-transparent border-gray-600 text-white hover:bg-gray-700"
              >
                Cancel
              </Button>
              <Button
                onClick={handleCreateCollection}
                disabled={!newCollectionName.trim() || createCollection.isPending}
              >
                {createCollection.isPending ? "Creating..." : "Create Collection"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        </div>
      </div>

      {/* Description */}
      <p className="text-gray-300 mb-8 max-w-4xl">
        Daily observation logs. Photos and some commentary. Most of these include just the raw,
        out-of-scope photos without any formal processing. At times, it may include a combination
        of out-of-scope and post-processed photos. But they will always be clearly marked.
      </p>

      {/* Collections */}
      {isLoading ? (
        <div className="text-center py-12">
          <p className="text-gray-400">Loading collections...</p>
        </div>
      ) : collections.length === 0 ? (
        <div className="text-center py-12 rounded-lg bg-slate-800/50">
          <FolderOpen className="w-12 h-12 mx-auto mb-4 text-gray-500" />
          <p className="text-gray-400 mb-2">No collections yet</p>
          <p className="text-sm text-gray-500">
            Create a new collection to start organizing your observations.
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          {Object.entries(groupedCollections).map(([monthYear, monthCollections]) => (
            <div key={monthYear}>
              {/* Month header */}
              <div className="bg-slate-800 rounded-lg px-4 py-3 mb-4">
                <h2 className="text-lg font-semibold text-white">{monthYear}</h2>
              </div>

              {/* Collection cards grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {monthCollections.map((collection) => (
                  <CollectionCard
                    key={collection.id}
                    collection={collection}
                    imageCount={getImageCount(collection.id)}
                    previewImage={getPreviewImage(collection.id)}
                    onRefresh={refetch}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CollectionCard({
  collection,
  imageCount,
  previewImage,
  onRefresh,
}: {
  collection: Collection;
  imageCount: number;
  previewImage: Image | null;
  onRefresh: () => void;
}) {
  const tags = parseTags(collection.tags);
  const updateCollection = useUpdateCollection();
  const deleteCollection = useDeleteCollection();

  const handleToggleFavorite = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await updateCollection.mutateAsync({
        id: collection.id,
        favorite: !collection.favorite,
      });
      toast.success(
        collection.favorite
          ? `Removed ${collection.name} from favorites`
          : `Added ${collection.name} to favorites`
      );
    } catch (err) {
      toast.error("Failed to update collection");
    }
  };

  const handleToggleArchived = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await updateCollection.mutateAsync({
        id: collection.id,
        archived: !collection.archived,
      });
      toast.success(
        collection.archived
          ? `Unarchived ${collection.name}`
          : `Archived ${collection.name}`
      );
      onRefresh();
    } catch (err) {
      toast.error("Failed to update collection");
    }
  };

  const handleDelete = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm(`Delete "${collection.name}"? This cannot be undone.`)) return;
    try {
      await deleteCollection.mutateAsync(collection.id);
      toast.success(`Deleted ${collection.name}`);
    } catch (err) {
      toast.error("Failed to delete collection");
    }
  };

  // Try to get session date from metadata, fall back to created_at
  const getSessionDate = (): Date => {
    if (collection.metadata) {
      try {
        const meta = JSON.parse(collection.metadata);
        if (meta.session_date) {
          return new Date(meta.session_date);
        }
      } catch {
        // Ignore parse errors
      }
    }
    return new Date(collection.created_at);
  };

  const date = getSessionDate();
  const formattedDate = date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div>
      <div className="overflow-hidden rounded-lg transition-transform hover:scale-[1.02] cursor-pointer relative">
        {/* Clickable area - the entire card except the menu */}
        <Link to={`/collections/${collection.id}`} className="block">
          {/* Image area */}
          <div className="relative aspect-[4/3] bg-slate-700">
            {/* Preview thumbnail */}
            {previewImage?.thumbnail && (
              <img
                src={previewImage.thumbnail}
                alt={collection.name}
                className="absolute inset-0 w-full h-full object-cover"
              />
            )}

            {/* Favorite indicator */}
            {collection.favorite && (
              <div className="absolute top-2 right-12 text-yellow-400">
                <svg className="w-5 h-5 fill-current" viewBox="0 0 20 20">
                  <path d="M10 15l-5.878 3.09 1.123-6.545L.489 6.91l6.572-.955L10 0l2.939 5.955 6.572.955-4.756 4.635 1.123 6.545z" />
                </svg>
              </div>
            )}

            {/* Collection title overlay */}
            <div className="absolute top-0 left-0 right-0 p-3 bg-gradient-to-b from-black/60 to-transparent">
              <h3 className="font-semibold text-white pr-8">{collection.name}</h3>
            </div>

            {/* Empty collection placeholder */}
            {imageCount === 0 && (
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-gray-400 text-lg">Empty collection</span>
              </div>
            )}

            {/* Bottom info bar */}
            <div className="absolute bottom-0 left-0 right-0 p-3 bg-gradient-to-t from-black/60 to-transparent flex items-end justify-between">
              {/* Photo count */}
              <span className="bg-slate-800/90 text-white text-sm px-2 py-1 rounded">
                {imageCount} photo{imageCount !== 1 ? "s" : ""}
              </span>

              {/* Tags */}
              {tags.length > 0 && (
                <div className="flex gap-1">
                  {tags.slice(0, 2).map((tag) => (
                    <span
                      key={tag}
                      className="bg-teal-600/80 text-white text-xs px-2 py-1 rounded"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </Link>

        {/* Menu - positioned outside the Link to prevent navigation */}
        <div className="absolute top-2 right-2 z-10">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="p-1 rounded hover:bg-white/20 transition-colors bg-black/30">
                <MoreHorizontal className="h-5 w-5 text-white" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="bg-slate-800 border-slate-700">
              <DropdownMenuItem onClick={handleToggleFavorite} className="text-white hover:bg-slate-700">
                {collection.favorite ? "Remove from Favorites" : "Add to Favorites"}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleToggleArchived} className="text-white hover:bg-slate-700">
                {collection.archived ? "Unarchive" : "Archive"}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleDelete} className="text-red-400 hover:bg-slate-700">
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {/* Date below the card */}
      <p className="text-center text-gray-400 text-sm mt-2">{formattedDate}</p>
    </div>
  );
}

/**
 * Get session date from collection metadata or fall back to created_at
 */
function getCollectionSessionDate(collection: Collection): Date {
  if (collection.metadata) {
    try {
      const meta = JSON.parse(collection.metadata);
      if (meta.session_date) {
        return new Date(meta.session_date);
      }
    } catch {
      // Ignore parse errors
    }
  }
  return new Date(collection.created_at);
}

/**
 * Group collections by month/year based on session date
 */
function groupCollectionsByMonth(
  collections: Collection[]
): Record<string, Collection[]> {
  const grouped: Record<string, Collection[]> = {};

  // Sort collections by session date (newest first)
  const sorted = [...collections].sort(
    (a, b) => getCollectionSessionDate(b).getTime() - getCollectionSessionDate(a).getTime()
  );

  for (const collection of sorted) {
    const date = getCollectionSessionDate(collection);
    const monthYear = date.toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
    });

    if (!grouped[monthYear]) {
      grouped[monthYear] = [];
    }
    grouped[monthYear].push(collection);
  }

  return grouped;
}
