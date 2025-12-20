/**
 * Collections Page - Manage observation collections
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  useCollections,
  useCreateCollection,
  useUpdateCollection,
  useDeleteCollection,
} from "@/hooks/use-collections";
import type { Collection, CreateCollectionInput } from "@/lib/tauri/commands";
import { cn } from "@/lib/utils";

export default function CollectionsPage() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingCollection, setEditingCollection] = useState<Collection | null>(null);

  // Form state for adding new collection
  const [newCollection, setNewCollection] = useState<CreateCollectionInput>({
    name: "",
    description: "",
    visibility: "private",
    tags: "",
  });

  // Queries and mutations
  const { data: collections = [], isLoading, error } = useCollections();
  const createCollection = useCreateCollection();
  const updateCollection = useUpdateCollection();
  const deleteCollection = useDeleteCollection();

  const handleAddCollection = async () => {
    if (!newCollection.name.trim()) {
      toast.error("Please enter a collection name");
      return;
    }

    try {
      await createCollection.mutateAsync(newCollection);
      toast.success(`Created collection: ${newCollection.name}`);
      setDialogOpen(false);
      setNewCollection({
        name: "",
        description: "",
        visibility: "private",
        tags: "",
      });
    } catch (err) {
      toast.error("Failed to create collection");
      console.error(err);
    }
  };

  const handleToggleFavorite = async (collection: Collection) => {
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
      console.error(err);
    }
  };

  const handleDelete = async (collection: Collection) => {
    try {
      await deleteCollection.mutateAsync(collection.id);
      toast.success(`Deleted collection: ${collection.name}`);
    } catch (err) {
      toast.error("Failed to delete collection");
      console.error(err);
    }
  };

  const handleEditCollection = (collection: Collection) => {
    setEditingCollection(collection);
    setEditDialogOpen(true);
  };

  const handleSaveEdit = async () => {
    if (!editingCollection) return;

    try {
      await updateCollection.mutateAsync({
        id: editingCollection.id,
        name: editingCollection.name,
        description: editingCollection.description || undefined,
        visibility: editingCollection.visibility,
        tags: editingCollection.tags || undefined,
      });
      toast.success(`Updated ${editingCollection.name}`);
      setEditDialogOpen(false);
      setEditingCollection(null);
    } catch (err) {
      toast.error("Failed to update collection");
      console.error(err);
    }
  };

  if (error) {
    return (
      <div className="container py-8">
        <p className="text-destructive">Error loading collections: {String(error)}</p>
      </div>
    );
  }

  // Separate favorites and regular collections
  const favoriteCollections = collections.filter((c) => c.favorite);
  const regularCollections = collections.filter((c) => !c.favorite);

  return (
    <div className="container py-8 space-y-8">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold">Collections</h1>
          <p className="text-muted-foreground">
            Organize your astronomical observations
          </p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button>New Collection</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Collection</DialogTitle>
              <DialogDescription>
                Create a new collection to organize your observations.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="name">Name *</Label>
                <Input
                  id="name"
                  placeholder="e.g., Messier Objects, Summer 2024"
                  value={newCollection.name}
                  onChange={(e) =>
                    setNewCollection({ ...newCollection, name: e.target.value })
                  }
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  placeholder="Describe this collection..."
                  value={newCollection.description || ""}
                  onChange={(e) =>
                    setNewCollection({
                      ...newCollection,
                      description: e.target.value,
                    })
                  }
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="tags">Tags (comma-separated)</Label>
                <Input
                  id="tags"
                  placeholder="e.g., galaxies, deep-sky, beginner"
                  value={newCollection.tags || ""}
                  onChange={(e) =>
                    setNewCollection({ ...newCollection, tags: e.target.value })
                  }
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleAddCollection}
                disabled={createCollection.isPending}
              >
                {createCollection.isPending ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="text-center py-12 border rounded-lg bg-muted/30">
          <p className="text-muted-foreground">Loading collections...</p>
        </div>
      ) : collections.length === 0 ? (
        <div className="text-center py-12 border rounded-lg bg-muted/30">
          <p className="text-muted-foreground mb-4">
            No collections yet. Create one to organize your observations!
          </p>
          <Button onClick={() => setDialogOpen(true)}>Create Collection</Button>
        </div>
      ) : (
        <>
          {/* Favorites Section */}
          {favoriteCollections.length > 0 && (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold">Favorites</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {favoriteCollections.map((collection) => (
                  <CollectionCard
                    key={collection.id}
                    collection={collection}
                    onEdit={handleEditCollection}
                    onDelete={handleDelete}
                    onToggleFavorite={handleToggleFavorite}
                  />
                ))}
              </div>
            </div>
          )}

          {/* All Collections */}
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">
              {favoriteCollections.length > 0 ? "All Collections" : "Collections"}
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {regularCollections.map((collection) => (
                <CollectionCard
                  key={collection.id}
                  collection={collection}
                  onEdit={handleEditCollection}
                  onDelete={handleDelete}
                  onToggleFavorite={handleToggleFavorite}
                />
              ))}
            </div>
          </div>
        </>
      )}

      {/* Edit Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Collection</DialogTitle>
          </DialogHeader>
          {editingCollection && (
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="edit_name">Name</Label>
                <Input
                  id="edit_name"
                  value={editingCollection.name}
                  onChange={(e) =>
                    setEditingCollection({
                      ...editingCollection,
                      name: e.target.value,
                    })
                  }
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="edit_description">Description</Label>
                <Textarea
                  id="edit_description"
                  value={editingCollection.description || ""}
                  onChange={(e) =>
                    setEditingCollection({
                      ...editingCollection,
                      description: e.target.value,
                    })
                  }
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="edit_tags">Tags</Label>
                <Input
                  id="edit_tags"
                  value={editingCollection.tags || ""}
                  onChange={(e) =>
                    setEditingCollection({
                      ...editingCollection,
                      tags: e.target.value,
                    })
                  }
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveEdit} disabled={updateCollection.isPending}>
              {updateCollection.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Collection Card Component
interface CollectionCardProps {
  collection: Collection;
  onEdit: (collection: Collection) => void;
  onDelete: (collection: Collection) => void;
  onToggleFavorite: (collection: Collection) => void;
}

function CollectionCard({
  collection,
  onEdit,
  onDelete,
  onToggleFavorite,
}: CollectionCardProps) {
  const tags = collection.tags
    ? collection.tags.split(",").map((t) => t.trim()).filter(Boolean)
    : [];

  return (
    <Card className={cn("hover:shadow-md transition-shadow")}>
      <CardHeader className="pb-2">
        <div className="flex justify-between items-start">
          <div className="flex-1">
            <Link to={`/c/${collection.id}`}>
              <CardTitle className="text-lg hover:underline">
                {collection.name}
              </CardTitle>
            </Link>
            {collection.description && (
              <CardDescription className="line-clamp-2">
                {collection.description}
              </CardDescription>
            )}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm">
                ...
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onToggleFavorite(collection)}>
                {collection.favorite ? "Remove from Favorites" : "Add to Favorites"}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onEdit(collection)}>
                Edit
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive"
                onClick={() => onDelete(collection)}
              >
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-1">
          {collection.favorite && (
            <Badge variant="secondary" className="text-xs">
              Favorite
            </Badge>
          )}
          <Badge
            variant="outline"
            className={cn(
              "text-xs",
              collection.visibility === "public"
                ? "border-green-500"
                : "border-slate-500"
            )}
          >
            {collection.visibility}
          </Badge>
          {tags.slice(0, 3).map((tag) => (
            <Badge key={tag} variant="outline" className="text-xs">
              {tag}
            </Badge>
          ))}
          {tags.length > 3 && (
            <Badge variant="outline" className="text-xs">
              +{tags.length - 3}
            </Badge>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
