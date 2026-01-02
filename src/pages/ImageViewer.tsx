/**
 * Image Viewer Page - View and manage individual images
 */

import { useState, useEffect, useMemo } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { toast } from "sonner";
import { marked } from "marked";
import { imageApi } from "@/lib/tauri/commands";
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
} from "@/components/ui/dialog";
import {
  ArrowLeft,
  Calendar,
  Edit,
  ImageIcon,
  MapPin,
  Save,
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
    </div>
  );
}
