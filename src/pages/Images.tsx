/**
 * Images Page - Browse all images, most recent first, paginated
 */

import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { ChevronLeft, ChevronRight, ImageIcon, Search } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useImages } from "@/hooks/use-images";
import type { Image } from "@/lib/tauri/commands";

const PAGE_SIZE = 60;

export default function Images() {
  const { data: allImages = [], isLoading } = useImages();
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");

  // Sort by created_at descending, filter by search
  const filtered = useMemo(() => {
    let images = [...allImages].sort(
      (a, b) => b.created_at.localeCompare(a.created_at)
    );

    if (search) {
      const q = search.toLowerCase();
      images = images.filter(
        (img) =>
          img.filename.toLowerCase().includes(q) ||
          img.summary?.toLowerCase().includes(q) ||
          img.description?.toLowerCase().includes(q)
      );
    }

    return images;
  }, [allImages, search]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const pageImages = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  // Reset page when search changes
  const handleSearch = (value: string) => {
    setSearch(value);
    setPage(0);
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 to-slate-950 p-6 space-y-6">
      {/* Breadcrumb */}
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link to="/">Home</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Images</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">All Images</h1>
          <p className="text-sm text-gray-400 mt-1">
            {allImages.length} total image{allImages.length !== 1 ? "s" : ""}
            {search && ` — ${filtered.length} matching`}
          </p>
        </div>
      </div>

      {/* Search + Pagination controls */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-[400px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input
            placeholder="Search images..."
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            className="pl-9 bg-slate-800 border-slate-600 text-white placeholder:text-slate-400"
          />
        </div>

        {totalPages > 1 && (
          <div className="flex items-center gap-2 ml-auto">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <span className="text-sm text-slate-400">
              Page {page + 1} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        )}
      </div>

      {/* Image Grid */}
      {isLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
          {Array.from({ length: 24 }).map((_, i) => (
            <Skeleton key={i} className="aspect-square rounded-lg" />
          ))}
        </div>
      ) : pageImages.length === 0 ? (
        <div className="text-center py-12 bg-slate-800/50 rounded-lg">
          <ImageIcon className="w-12 h-12 mx-auto mb-4 text-gray-500" />
          <p className="text-white">
            {search ? "No images match your search" : "No images yet"}
          </p>
          <p className="text-gray-400 text-sm mt-1">
            {search
              ? "Try a different search term"
              : "Import images via bulk scan or auto-import"}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
          {pageImages.map((image) => (
            <ImageCard key={image.id} image={image} />
          ))}
        </div>
      )}

      {/* Bottom pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
          >
            <ChevronLeft className="w-4 h-4 mr-1" />
            Previous
          </Button>
          <span className="text-sm text-slate-400 px-4">
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, filtered.length)} of{" "}
            {filtered.length}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
          >
            Next
            <ChevronRight className="w-4 h-4 ml-1" />
          </Button>
        </div>
      )}
    </div>
  );
}

function ImageCard({ image }: { image: Image }) {
  const thumbnailSrc = image.thumbnail || undefined;
  const title = image.summary || image.filename;

  // Count catalog objects from annotations
  const objectCount = useMemo(() => {
    if (!image.annotations) return 0;
    try {
      const parsed = typeof image.annotations === "string"
        ? JSON.parse(image.annotations)
        : image.annotations;
      return Array.isArray(parsed) ? parsed.length : 0;
    } catch {
      return 0;
    }
  }, [image.annotations]);

  return (
    <Link
      to={`/i/${image.id}`}
      className="group relative aspect-square rounded-lg overflow-hidden bg-slate-800 hover:ring-2 hover:ring-indigo-500 transition-all"
    >
      {thumbnailSrc ? (
        <img
          src={thumbnailSrc}
          alt={title}
          className="w-full h-full object-cover"
          loading="lazy"
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center">
          <ImageIcon className="w-8 h-8 text-slate-600" />
        </div>
      )}
      {objectCount > 0 && (
        <div className="absolute top-1.5 right-1.5 bg-indigo-600/90 text-white text-[10px] font-medium px-1.5 py-0.5 rounded-full leading-none">
          {objectCount}
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <p className="text-xs text-white truncate">{title}</p>
        <p className="text-xs text-slate-400">
          {new Date(image.created_at).toLocaleDateString()}
        </p>
      </div>
    </Link>
  );
}
