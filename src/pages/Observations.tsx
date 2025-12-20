/**
 * Observations Page - View and manage observation images
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { ImageIcon, Search, Star, Calendar } from "lucide-react";
import { useImages } from "@/hooks/use-images";
import type { Image } from "@/lib/tauri/commands";

export default function ObservationsPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const { data: images = [], isLoading } = useImages();

  // Filter images by search query
  const filteredImages = images.filter((image) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      image.filename.toLowerCase().includes(query) ||
      image.summary?.toLowerCase().includes(query) ||
      image.description?.toLowerCase().includes(query) ||
      image.tags?.toLowerCase().includes(query)
    );
  });

  // Sort by date (newest first)
  const sortedImages = [...filteredImages].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold">Observations</h1>
          <p className="text-muted-foreground">
            Your astronomical images and observations
          </p>
        </div>
      </div>

      {/* Search */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search observations..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      {/* Images Grid */}
      {isLoading ? (
        <div className="text-center py-12">
          <p className="text-muted-foreground">Loading observations...</p>
        </div>
      ) : sortedImages.length === 0 ? (
        <div className="text-center py-12 border rounded-lg bg-muted/30">
          <ImageIcon className="w-12 h-12 mx-auto mb-4 opacity-50" />
          <p className="text-muted-foreground mb-2">
            {searchQuery ? "No observations match your search" : "No observations yet"}
          </p>
          <p className="text-sm text-muted-foreground">
            Images added to collections will appear here.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {sortedImages.map((image) => (
            <ImageCard key={image.id} image={image} />
          ))}
        </div>
      )}
    </div>
  );
}

function ImageCard({ image }: { image: Image }) {
  const tags = image.tags ? image.tags.split(",").map((t) => t.trim()).filter(Boolean) : [];

  return (
    <Link to={`/i/${image.id}`}>
      <Card className="overflow-hidden hover:shadow-lg transition-shadow cursor-pointer">
        <div className="aspect-video bg-muted relative">
          {image.url ? (
            <img
              src={image.url}
              alt={image.filename}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <ImageIcon className="w-12 h-12 text-muted-foreground/50" />
            </div>
          )}
          {image.favorite && (
            <div className="absolute top-2 right-2">
              <Star className="w-5 h-5 text-yellow-500 fill-yellow-500" />
            </div>
          )}
        </div>
        <CardContent className="p-3">
          <h3 className="font-medium truncate">{image.filename}</h3>
          {image.summary && (
            <p className="text-sm text-muted-foreground truncate">{image.summary}</p>
          )}
          <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
            <Calendar className="w-3 h-3" />
            {new Date(image.created_at).toLocaleDateString()}
          </div>
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {tags.slice(0, 3).map((tag) => (
                <Badge key={tag} variant="secondary" className="text-xs">
                  {tag}
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}
