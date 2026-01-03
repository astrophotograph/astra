/**
 * Collection Detail Page - View and manage a collection
 */

import { useState, useMemo } from "react";
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
  Compass,
  FolderOpen,
  ImageIcon,
  Plus,
  Star,
  Trash2,
} from "lucide-react";
import { useCollection, useUpdateCollection, useDeleteCollection } from "@/hooks/use-collections";
import { useCollectionImages, useImages, imageKeys } from "@/hooks/use-images";
import { imageApi, type Image } from "@/lib/tauri/commands";
import { useQueryClient } from "@tanstack/react-query";

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

  const queryClient = useQueryClient();
  const { data: collection, isLoading, error } = useCollection(id || "");
  const { data: collectionImages = [], error: imagesError, isLoading: imagesLoading } = useCollectionImages(id || "");
  const { data: allImages = [] } = useImages();
  const updateCollection = useUpdateCollection();
  const deleteCollection = useDeleteCollection();
  const [isAddingImages, setIsAddingImages] = useState(false);

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
          <Button
            variant="outline"
            className="bg-transparent border-gray-600 text-white hover:bg-gray-800"
            onClick={() => setAddImagesDialogOpen(true)}
          >
            <Plus className="w-4 h-4 mr-2" />
            Add Image
          </Button>
          <Button
            variant="outline"
            className="bg-transparent border-gray-600 text-white hover:bg-gray-800"
            onClick={handleStartEdit}
          >
            Edit
          </Button>
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

      {/* Images Grid */}
      {collectionImages.length === 0 ? (
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
    </div>
  );
}

// Check if an image has been plate-solved
function isPlateSolved(image: Image): boolean {
  if (!image.metadata) return false;
  try {
    const metadata = JSON.parse(image.metadata);
    return !!metadata.plate_solve;
  } catch {
    return false;
  }
}

function ImageCard({ image, onRemove }: { image: Image; onRemove: () => void }) {
  const plateSolved = isPlateSolved(image);

  return (
    <div className="group relative rounded-lg overflow-hidden bg-slate-800 border border-slate-700">
      <Link to={`/i/${image.id}`}>
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
        </div>
        <div className="p-2">
          <p className="font-medium truncate text-sm text-white">{image.summary || image.filename}</p>
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
