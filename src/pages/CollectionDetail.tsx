/**
 * Collection Detail Page - View and manage a collection
 */

import { useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  ArrowLeft,
  Calendar,
  Edit,
  FolderOpen,
  ImageIcon,
  Plus,
  Save,
  Star,
  Trash2,
} from "lucide-react";
import { useCollection, useUpdateCollection, useDeleteCollection } from "@/hooks/use-collections";
import { useCollectionImages, useImages, useUpdateImage } from "@/hooks/use-images";
import type { Image } from "@/lib/tauri/commands";

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

  const { data: collection, isLoading, error } = useCollection(id || "");
  const { data: collectionImages = [] } = useCollectionImages(id || "");
  const { data: allImages = [] } = useImages();
  const updateCollection = useUpdateCollection();
  const deleteCollection = useDeleteCollection();
  const updateImage = useUpdateImage();

  // Images not in this collection
  const availableImages = allImages.filter(
    (img) => img.collection_id !== id
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

  // Toggle favorite
  const handleToggleFavorite = async () => {
    if (!collection) return;

    try {
      await updateCollection.mutateAsync({
        id: collection.id,
        favorite: !collection.favorite,
      });
      toast.success(collection.favorite ? "Removed from favorites" : "Added to favorites");
    } catch (err) {
      toast.error("Failed to update favorite status");
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

    try {
      // Update each selected image to belong to this collection
      for (const imageId of selectedImages) {
        await updateImage.mutateAsync({
          id: imageId,
          collection_id: collection.id,
        });
      }
      toast.success(`Added ${selectedImages.length} image(s) to collection`);
      setAddImagesDialogOpen(false);
      setSelectedImages([]);
    } catch (err) {
      toast.error("Failed to add images");
      console.error(err);
    }
  };

  // Remove image from collection
  const handleRemoveImage = async (imageId: string) => {
    try {
      await updateImage.mutateAsync({
        id: imageId,
        collection_id: "", // Remove from collection
      });
      toast.success("Image removed from collection");
    } catch (err) {
      toast.error("Failed to remove image");
      console.error(err);
    }
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
      <div className="flex items-center justify-center min-h-[400px]">
        <p className="text-muted-foreground">Loading collection...</p>
      </div>
    );
  }

  if (error || !collection) {
    return (
      <div className="text-center py-12">
        <FolderOpen className="w-12 h-12 mx-auto mb-4 opacity-50" />
        <h2 className="text-xl font-semibold mb-2">Collection not found</h2>
        <p className="text-muted-foreground mb-4">
          The requested collection could not be found.
        </p>
        <Link to="/collections">
          <Button>
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Collections
          </Button>
        </Link>
      </div>
    );
  }

  const tags = collection.tags
    ? collection.tags.split(",").map((t) => t.trim()).filter(Boolean)
    : [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to="/collections">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold">{collection.name}</h1>
            {collection.description && (
              <p className="text-muted-foreground">{collection.description}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleToggleFavorite}
            disabled={updateCollection.isPending}
          >
            <Star
              className={`w-5 h-5 ${
                collection.favorite ? "text-yellow-500 fill-yellow-500" : ""
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

      <div className="grid lg:grid-cols-4 gap-6">
        {/* Collection Info */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {isEditing ? (
                <>
                  <div>
                    <Label>Name</Label>
                    <Input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label>Description</Label>
                    <Textarea
                      value={editDescription}
                      onChange={(e) => setEditDescription(e.target.value)}
                      className="mt-1"
                      rows={3}
                    />
                  </div>
                  <div>
                    <Label>Tags</Label>
                    <Input
                      value={editTags}
                      onChange={(e) => setEditTags(e.target.value)}
                      placeholder="galaxy, nebula (comma separated)"
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label>Visibility</Label>
                    <Select value={editVisibility} onValueChange={setEditVisibility}>
                      <SelectTrigger className="mt-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="private">Private</SelectItem>
                        <SelectItem value="public">Public</SelectItem>
                        <SelectItem value="unlisted">Unlisted</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      onClick={handleSave}
                      disabled={updateCollection.isPending}
                      className="flex-1"
                    >
                      <Save className="w-4 h-4 mr-2" />
                      {updateCollection.isPending ? "Saving..." : "Save"}
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
                  <div className="flex items-center gap-2">
                    <Calendar className="w-4 h-4 text-muted-foreground" />
                    <span className="text-sm">
                      Created {new Date(collection.created_at).toLocaleDateString()}
                    </span>
                  </div>

                  <div>
                    <Label className="text-muted-foreground">Visibility</Label>
                    <p>
                      <Badge variant="outline" className="capitalize">
                        {collection.visibility}
                      </Badge>
                    </p>
                  </div>

                  <div>
                    <Label className="text-muted-foreground">Images</Label>
                    <p>{collectionImages.length} images</p>
                  </div>

                  {tags.length > 0 && (
                    <div>
                      <Label className="text-muted-foreground">Tags</Label>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {tags.map((tag) => (
                          <Badge key={tag} variant="secondary">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Images Grid */}
        <div className="lg:col-span-3">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-semibold">Images</h2>
            <Button size="sm" onClick={() => setAddImagesDialogOpen(true)}>
              <Plus className="w-4 h-4 mr-2" />
              Add Images
            </Button>
          </div>

          {collectionImages.length === 0 ? (
            <div className="text-center py-12 border rounded-lg bg-muted/30">
              <ImageIcon className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p className="text-muted-foreground mb-2">No images in this collection</p>
              <Button variant="outline" onClick={() => setAddImagesDialogOpen(true)}>
                <Plus className="w-4 h-4 mr-2" />
                Add Images
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              {collectionImages.map((image) => (
                <ImageCard
                  key={image.id}
                  image={image}
                  onRemove={() => handleRemoveImage(image.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Collection</DialogTitle>
          </DialogHeader>
          <p className="text-muted-foreground">
            Are you sure you want to delete &quot;{collection.name}&quot;? This will not
            delete the images, but they will be removed from this collection.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>
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

      {/* Add Images Dialog */}
      <Dialog open={addImagesDialogOpen} onOpenChange={setAddImagesDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Add Images to Collection</DialogTitle>
            <DialogDescription>
              Select images to add to &quot;{collection.name}&quot;
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[400px] overflow-y-auto">
            {availableImages.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">
                No available images to add
              </p>
            ) : (
              <div className="grid grid-cols-3 gap-3">
                {availableImages.map((image) => (
                  <div
                    key={image.id}
                    className={`relative cursor-pointer rounded-lg overflow-hidden border-2 transition-colors ${
                      selectedImages.includes(image.id)
                        ? "border-primary"
                        : "border-transparent"
                    }`}
                    onClick={() => toggleImageSelection(image.id)}
                  >
                    <div className="aspect-video bg-muted">
                      {image.url ? (
                        <img
                          src={image.url}
                          alt={image.filename}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <ImageIcon className="w-8 h-8 text-muted-foreground/50" />
                        </div>
                      )}
                    </div>
                    <p className="text-xs p-1 truncate">{image.filename}</p>
                    {selectedImages.includes(image.id) && (
                      <div className="absolute top-1 right-1 w-5 h-5 bg-primary rounded-full flex items-center justify-center">
                        <span className="text-xs text-primary-foreground">✓</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddImagesDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleAddImages}
              disabled={selectedImages.length === 0 || updateImage.isPending}
            >
              {updateImage.isPending
                ? "Adding..."
                : `Add ${selectedImages.length} Image${selectedImages.length !== 1 ? "s" : ""}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ImageCard({ image, onRemove }: { image: Image; onRemove: () => void }) {
  return (
    <div className="group relative rounded-lg overflow-hidden border">
      <Link to={`/i/${image.id}`}>
        <div className="aspect-video bg-muted">
          {image.url ? (
            <img
              src={image.url}
              alt={image.filename}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <ImageIcon className="w-10 h-10 text-muted-foreground/50" />
            </div>
          )}
        </div>
        <div className="p-2">
          <p className="font-medium truncate text-sm">{image.summary || image.filename}</p>
          {image.favorite && (
            <Star className="w-4 h-4 text-yellow-500 fill-yellow-500 inline" />
          )}
        </div>
      </Link>
      <Button
        variant="destructive"
        size="sm"
        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onRemove();
        }}
      >
        <Trash2 className="w-3 h-3" />
      </Button>
    </div>
  );
}
