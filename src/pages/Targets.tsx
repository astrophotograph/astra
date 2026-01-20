/**
 * Targets Page - Browse images grouped by astronomical object
 */

import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Search, Star, Image as ImageIcon, ChevronRight } from "lucide-react";
import { targetApi, type TargetWithCount, type Image } from "@/lib/tauri/commands";

export default function TargetsPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTarget, setSelectedTarget] = useState<string | null>(null);

  // Fetch all targets
  const { data: targets = [], isLoading: isLoadingTargets } = useQuery({
    queryKey: ["targets"],
    queryFn: () => targetApi.getAll(),
  });

  // Fetch images for selected target
  const { data: targetImages = [], isLoading: isLoadingImages } = useQuery({
    queryKey: ["target-images", selectedTarget],
    queryFn: () => (selectedTarget ? targetApi.getImages(selectedTarget) : Promise.resolve([])),
    enabled: !!selectedTarget,
  });

  // Filter targets by search query
  const filteredTargets = useMemo(() => {
    if (!searchQuery.trim()) return targets;
    const query = searchQuery.toLowerCase().replace(/\s+/g, "");
    return targets.filter((target) =>
      target.name.toLowerCase().replace(/\s+/g, "").includes(query)
    );
  }, [targets, searchQuery]);

  // Calculate statistics
  const totalTargets = targets.length;
  const totalImages = targets.reduce((sum, t) => sum + t.imageCount, 0);

  const handleTargetClick = (targetName: string) => {
    setSelectedTarget(targetName);
  };

  const handleCloseDialog = () => {
    setSelectedTarget(null);
  };

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
            <BreadcrumbPage className="text-gray-300">Targets</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-3xl font-bold text-white">Target Browser</h1>
          <p className="text-gray-400 mt-1">
            Browse all {totalTargets} unique targets across {totalImages} images
          </p>
        </div>

        {/* Search */}
        <div className="relative max-w-sm w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <Input
            placeholder="Search targets... (e.g., M42, NGC 7000)"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10 bg-slate-800 border-slate-700"
          />
        </div>
      </div>

      {/* Search results info */}
      {searchQuery && (
        <p className="text-gray-400 text-sm mb-4">
          Found {filteredTargets.length} target{filteredTargets.length !== 1 ? "s" : ""} matching "{searchQuery}"
        </p>
      )}

      {/* Targets Grid */}
      {isLoadingTargets ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          {Array.from({ length: 12 }).map((_, i) => (
            <TargetCardSkeleton key={i} />
          ))}
        </div>
      ) : filteredTargets.length === 0 ? (
        <div className="text-center py-12 rounded-lg bg-slate-800/50">
          <Star className="w-12 h-12 mx-auto mb-4 text-gray-500" />
          {searchQuery ? (
            <>
              <p className="text-gray-400 mb-2">No targets found</p>
              <p className="text-sm text-gray-500">
                Try a different search term, like "M31" or "Orion"
              </p>
            </>
          ) : (
            <>
              <p className="text-gray-400 mb-2">No targets yet</p>
              <p className="text-sm text-gray-500">
                Import some images to see targets here
              </p>
            </>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          {filteredTargets.map((target) => (
            <TargetCard
              key={target.name}
              target={target}
              onClick={() => handleTargetClick(target.name)}
            />
          ))}
        </div>
      )}

      {/* Target Images Dialog */}
      <Dialog open={!!selectedTarget} onOpenChange={(open) => !open && handleCloseDialog()}>
        <DialogContent className="max-w-4xl max-h-[85vh] bg-slate-800 border-slate-700">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-white">
              <Star className="w-5 h-5 text-yellow-400" />
              {selectedTarget}
              <span className="text-gray-400 font-normal text-base ml-2">
                ({targetImages.length} image{targetImages.length !== 1 ? "s" : ""})
              </span>
            </DialogTitle>
          </DialogHeader>

          {isLoadingImages ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 p-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="aspect-square rounded-lg" />
              ))}
            </div>
          ) : targetImages.length === 0 ? (
            <div className="text-center py-8">
              <ImageIcon className="w-12 h-12 mx-auto mb-4 text-gray-500" />
              <p className="text-gray-400">No images found for this target</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 overflow-y-auto max-h-[60vh] p-4">
              {targetImages.map((image) => (
                <ImageCard key={image.id} image={image} />
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TargetCardSkeleton() {
  return (
    <div className="rounded-lg overflow-hidden bg-slate-800">
      <Skeleton className="aspect-square w-full" />
      <div className="p-3">
        <Skeleton className="h-5 w-3/4 mb-2" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    </div>
  );
}

function TargetCard({
  target,
  onClick,
}: {
  target: TargetWithCount;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="group rounded-lg overflow-hidden bg-slate-800 hover:bg-slate-700 transition-colors text-left"
    >
      {/* Thumbnail */}
      <div className="aspect-square bg-slate-700 relative overflow-hidden">
        {target.latestThumbnail ? (
          <img
            src={target.latestThumbnail}
            alt={target.name}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Star className="w-8 h-8 text-gray-600" />
          </div>
        )}

        {/* Image count badge */}
        <div className="absolute bottom-2 right-2 bg-black/70 text-white text-xs px-2 py-1 rounded-full">
          {target.imageCount}
        </div>
      </div>

      {/* Target name */}
      <div className="p-3 flex items-center justify-between">
        <div className="min-w-0 flex-1">
          <h3 className="font-medium text-white truncate">{target.name}</h3>
          <p className="text-xs text-gray-400">
            {target.imageCount} image{target.imageCount !== 1 ? "s" : ""}
          </p>
        </div>
        <ChevronRight className="w-4 h-4 text-gray-500 group-hover:text-white transition-colors flex-shrink-0" />
      </div>
    </button>
  );
}

function ImageCard({ image }: { image: Image }) {
  // Parse observation date from metadata
  const observationDate = useMemo(() => {
    if (image.metadata) {
      try {
        const meta = JSON.parse(image.metadata);
        if (meta.date_obs) {
          return new Date(meta.date_obs).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          });
        }
      } catch {
        // Ignore parse errors
      }
    }
    return new Date(image.created_at).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }, [image]);

  return (
    <Link
      to={`/i/${image.id}`}
      className="group rounded-lg overflow-hidden bg-slate-700 hover:ring-2 hover:ring-teal-500 transition-all"
    >
      {/* Thumbnail */}
      <div className="aspect-square bg-slate-600 relative overflow-hidden">
        {image.thumbnail ? (
          <img
            src={image.thumbnail}
            alt={image.summary || image.filename}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <ImageIcon className="w-8 h-8 text-gray-500" />
          </div>
        )}
      </div>

      {/* Image info */}
      <div className="p-2">
        <p className="text-xs text-gray-400 truncate">{observationDate}</p>
      </div>
    </Link>
  );
}
