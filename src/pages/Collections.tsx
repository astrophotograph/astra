/**
 * Collections Page - Manage observation collections
 */

import { useState, useMemo } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { MoreHorizontal, Play, Target } from "lucide-react";
import {
  type CollectionType,
  getCollectionType,
  COLLECTION_TYPE_COLORS,
  COLLECTION_TEMPLATES,
} from "@/lib/collection-utils";
import TopTargetsDialog from "@/components/TopTargetsDialog";
import SlideshowConfigDialog from "@/components/SlideshowConfigDialog";

export default function CollectionsPage() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingCollection, setEditingCollection] = useState<Collection | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [selectedType, setSelectedType] = useState<CollectionType | "all">("all");
  const [topTargetsOpen, setTopTargetsOpen] = useState(false);
  const [slideshowDialogOpen, setSlideshowDialogOpen] = useState(false);

  // Form state for adding new collection
  const [newCollection, setNewCollection] = useState<CreateCollectionInput>({
    name: "",
    description: "",
    visibility: "private",
    tags: "",
    template: "",
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
      // Convert "_custom" back to empty string for the API
      const input = {
        ...newCollection,
        template: newCollection.template === "_custom" ? "" : newCollection.template,
      };
      await createCollection.mutateAsync(input);
      toast.success(`Created collection: ${newCollection.name}`);
      setDialogOpen(false);
      setNewCollection({
        name: "",
        description: "",
        visibility: "private",
        tags: "",
        template: "",
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

  const handleToggleArchived = async (collection: Collection) => {
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

  // Filter and separate collections
  const archivedFiltered = showArchived
    ? collections.filter((c) => c.archived)
    : collections.filter((c) => !c.archived);

  // Apply type filter
  const visibleCollections = selectedType === "all"
    ? archivedFiltered
    : archivedFiltered.filter((c) => getCollectionType(c.template) === selectedType);

  const favoriteCollections = visibleCollections.filter((c) => c.favorite);
  const regularCollections = visibleCollections.filter((c) => !c.favorite);
  const archivedCount = collections.filter((c) => c.archived).length;

  // Type counts (from non-archived collections for the active view)
  const typeCounts = useMemo(() => {
    const base = showArchived
      ? collections.filter((c) => c.archived)
      : collections.filter((c) => !c.archived);
    return {
      all: base.length,
      observation: base.filter((c) => getCollectionType(c.template) === "observation").length,
      catalog: base.filter((c) => getCollectionType(c.template) === "catalog").length,
      custom: base.filter((c) => getCollectionType(c.template) === "custom").length,
    };
  }, [collections, showArchived]);

  return (
    <div className="container py-8 space-y-8">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold">
            {showArchived ? "Archived Collections" : "Collections"}
          </h1>
          <p className="text-muted-foreground">
            Organize your astronomical observations
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => setSlideshowDialogOpen(true)}
          >
            <Play className="h-4 w-4 mr-2" />
            Slideshow
          </Button>
          <Button
            variant="outline"
            onClick={() => setTopTargetsOpen(true)}
          >
            <Target className="h-4 w-4 mr-2" />
            Top Targets
          </Button>
          {archivedCount > 0 && (
            <Button
              variant={showArchived ? "default" : "outline"}
              onClick={() => setShowArchived(!showArchived)}
            >
              {showArchived ? "Show Active" : `Archived (${archivedCount})`}
            </Button>
          )}
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
                <Label htmlFor="template">Type</Label>
                <Select
                  value={newCollection.template || ""}
                  onValueChange={(value) =>
                    setNewCollection({ ...newCollection, template: value })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select a type..." />
                  </SelectTrigger>
                  <SelectContent>
                    {COLLECTION_TEMPLATES.map((tmpl) => (
                      <SelectItem key={tmpl.value} value={tmpl.value || "_custom"}>
                        {tmpl.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
      </div>

      {/* Type Filter Pills */}
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={() => setSelectedType("all")}
          className={cn(
            "px-3 py-1.5 rounded-full text-sm font-medium transition-colors border",
            selectedType === "all"
              ? "bg-white/10 text-white border-white/20"
              : "bg-transparent text-gray-400 border-transparent hover:text-white hover:bg-white/5"
          )}
        >
          All ({typeCounts.all})
        </button>
        <button
          onClick={() => setSelectedType("observation")}
          className={cn(
            "px-3 py-1.5 rounded-full text-sm font-medium transition-colors border",
            selectedType === "observation"
              ? COLLECTION_TYPE_COLORS.observation
              : "bg-transparent text-gray-400 border-transparent hover:text-violet-300 hover:bg-violet-500/10"
          )}
        >
          Observations ({typeCounts.observation})
        </button>
        <button
          onClick={() => setSelectedType("catalog")}
          className={cn(
            "px-3 py-1.5 rounded-full text-sm font-medium transition-colors border",
            selectedType === "catalog"
              ? COLLECTION_TYPE_COLORS.catalog
              : "bg-transparent text-gray-400 border-transparent hover:text-blue-300 hover:bg-blue-500/10"
          )}
        >
          Catalogs ({typeCounts.catalog})
        </button>
        <button
          onClick={() => setSelectedType("custom")}
          className={cn(
            "px-3 py-1.5 rounded-full text-sm font-medium transition-colors border",
            selectedType === "custom"
              ? COLLECTION_TYPE_COLORS.custom
              : "bg-transparent text-gray-400 border-transparent hover:text-emerald-300 hover:bg-emerald-500/10"
          )}
        >
          Custom ({typeCounts.custom})
        </button>
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
                    onToggleArchived={handleToggleArchived}
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
                  onToggleArchived={handleToggleArchived}
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

      {/* Top Targets Dialog */}
      <TopTargetsDialog
        open={topTargetsOpen}
        onOpenChange={setTopTargetsOpen}
        collections={collections}
      />

      {/* Slideshow Config Dialog */}
      <SlideshowConfigDialog
        open={slideshowDialogOpen}
        onOpenChange={setSlideshowDialogOpen}
      />
    </div>
  );
}

// Collection Card Component
interface CollectionCardProps {
  collection: Collection;
  onEdit: (collection: Collection) => void;
  onDelete: (collection: Collection) => void;
  onToggleFavorite: (collection: Collection) => void;
  onToggleArchived: (collection: Collection) => void;
}

function CollectionCard({
  collection,
  onEdit,
  onDelete,
  onToggleFavorite,
  onToggleArchived,
}: CollectionCardProps) {
  const tags = collection.tags
    ? collection.tags.split(",").map((t) => t.trim()).filter(Boolean)
    : [];
  const collectionType = getCollectionType(collection.template);

  return (
    <Card className={cn("hover:shadow-md transition-shadow")}>
      <CardHeader className="pb-2">
        <div className="flex justify-between items-start">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <Badge
                variant="outline"
                className={cn("text-xs", COLLECTION_TYPE_COLORS[collectionType])}
              >
                {collectionType.charAt(0).toUpperCase() + collectionType.slice(1)}
              </Badge>
            </div>
            <Link to={`/collections/${collection.id}`}>
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
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onToggleFavorite(collection)}>
                {collection.favorite ? "Remove from Favorites" : "Add to Favorites"}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onToggleArchived(collection)}>
                {collection.archived ? "Unarchive" : "Archive"}
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
          {collection.archived && (
            <Badge variant="secondary" className="text-xs">
              Archived
            </Badge>
          )}
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
