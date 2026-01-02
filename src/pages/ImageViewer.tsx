/**
 * Image Viewer Page - View and manage individual images
 */

import { useState, useEffect, useMemo } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { toast } from "sonner";
import { marked } from "marked";
import { imageApi, plateSolveApi, type CatalogObject } from "@/lib/tauri/commands";
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
  ImageIcon,
  Loader2,
  MapPin,
  Save,
  Sparkles,
  Star,
  Tag,
  Trash2,
} from "lucide-react";
import { useImage, useUpdateImage, useDeleteImage } from "@/hooks/use-images";

export default function ImageViewerPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [isEditing, setIsEditing] = useState(false);
  const [editSummary, setEditSummary] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editTags, setEditTags] = useState("");
  const [editLocation, setEditLocation] = useState("");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [isLoadingImage, setIsLoadingImage] = useState(false);
  const [plateSolveDialogOpen, setPlateSolveDialogOpen] = useState(false);
  const [isPlateSolving, setIsPlateSolving] = useState(false);
  const [plateSolveApiKey, setPlateSolveApiKey] = useState(() => {
    return localStorage.getItem("astrometry_api_key") || "";
  });
  const [catalogObjects, setCatalogObjects] = useState<CatalogObject[]>([]);
  const [objectsExpanded, setObjectsExpanded] = useState(false);

  const { data: image, isLoading, error } = useImage(id || "");
  const updateImage = useUpdateImage();
  const deleteImage = useDeleteImage();

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
  }, [image?.id, image?.thumbnail]);

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

  // Handle plate solve
  const handlePlateSolve = async () => {
    if (!image) return;

    if (!plateSolveApiKey) {
      toast.error("Please enter an Astrometry.net API key");
      return;
    }

    // Save API key to localStorage
    localStorage.setItem("astrometry_api_key", plateSolveApiKey);

    setIsPlateSolving(true);
    setPlateSolveDialogOpen(false);

    try {
      const result = await plateSolveApi.solve({
        id: image.id,
        solver: "nova",
        apiKey: plateSolveApiKey,
        queryCatalogs: true,
        timeout: 300,
      });

      if (result.success) {
        toast.success(`Plate solved in ${result.solveTime.toFixed(1)}s - found ${result.objects.length} objects`);
        setCatalogObjects(result.objects);
        // Refresh the image data to get updated metadata
        updateImage.mutate({ id: image.id });
      } else {
        toast.error(result.errorMessage || "Plate solve failed");
      }
    } catch (err) {
      toast.error("Plate solve failed: " + (err as Error).message);
      console.error(err);
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

  // Delete image
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
          <Link to="/observations">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back
            </Button>
          </Link>
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
            onClick={() => setPlateSolveDialogOpen(true)}
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
          {!isEditing && (
            <Button variant="outline" size="sm" onClick={handleStartEdit}>
              <Edit className="w-4 h-4 mr-2" />
              Edit
            </Button>
          )}
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setDeleteDialogOpen(true)}
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Image Display */}
        <div className="lg:col-span-2">
          <div className="rounded-lg overflow-hidden bg-muted">
            {isLoadingImage ? (
              <div className="aspect-video flex items-center justify-center">
                <p className="text-muted-foreground">Loading image...</p>
              </div>
            ) : imageDataUrl ? (
              <img
                src={imageDataUrl}
                alt={image.filename}
                className="w-full h-auto"
              />
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
                  <div>
                    <Label className="text-muted-foreground">Filename</Label>
                    <p className="font-mono text-sm break-all">{image.filename}</p>
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
                    <span className="text-sm">
                      {new Date(image.created_at).toLocaleString()}
                    </span>
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

                  {/* Plate Solve Results */}
                  {plateSolveInfo && (
                    <div className="pt-4 border-t">
                      <div className="flex items-center gap-2 mb-3">
                        <Sparkles className="w-4 h-4 text-teal-500" />
                        <Label className="text-teal-500">Plate Solve Results</Label>
                      </div>
                      <div className="space-y-2 text-sm">
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <span className="text-muted-foreground">RA:</span>
                            <span className="ml-2">{plateSolveInfo.center_ra?.toFixed(4)}°</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">Dec:</span>
                            <span className="ml-2">{plateSolveInfo.center_dec?.toFixed(4)}°</span>
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
                      </div>
                    </div>
                  )}

                  {/* Catalog Objects */}
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
            <Button onClick={handlePlateSolve} disabled={!plateSolveApiKey}>
              <Compass className="w-4 h-4 mr-2" />
              Start Plate Solve
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
