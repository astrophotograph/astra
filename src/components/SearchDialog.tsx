/**
 * SearchDialog - Global search across astronomy data
 *
 * Searches across todos, schedules, and observations (images)
 */

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Search,
  X,
  CheckSquare,
  Calendar,
  Telescope,
} from "lucide-react";
import { useTodos } from "@/hooks/use-todos";
import { useSchedules } from "@/hooks/use-schedules";
import { useImages } from "@/hooks/use-images";
import { imageApi } from "@/lib/tauri/commands";
import type { AstronomyTodo, ObservationSchedule, Image } from "@/lib/tauri/commands";
import { getObjectTypeInfo } from "@/lib/objectTypeMap";
import { cn } from "@/lib/utils";

type FilterType = "all" | "todos" | "schedules" | "observations";

interface SearchResult {
  id: string;
  type: "todo" | "schedule" | "observation";
  name: string;
  subtitle: string;
  objectType?: string;
  thumbnail?: string;
  catalogNames?: string[];  // First few catalog names (NGC, IC, LDN, etc.)
  data: AstronomyTodo | ObservationSchedule | Image;
}

interface SearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Normalize string for flexible matching (remove spaces, lowercase)
const normalizeForSearch = (str: string): string =>
  str.toLowerCase().replace(/\s+/g, "");

// Check if query matches target (space-insensitive)
const flexibleMatch = (target: string, query: string): boolean => {
  if (!query) return true;
  // Try exact match first
  if (target.toLowerCase().includes(query.toLowerCase())) return true;
  // Try normalized match (removes spaces)
  return normalizeForSearch(target).includes(normalizeForSearch(query));
};

export default function SearchDialog({ open, onOpenChange }: SearchDialogProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterType>("all");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  // Fetch data - refetch when dialog opens to ensure fresh data
  const { data: todos = [], refetch: refetchTodos } = useTodos();
  const { data: schedules = [], refetch: refetchSchedules } = useSchedules();
  const { data: images = [], refetch: refetchImages } = useImages();

  // Refetch all data when dialog opens to get latest (e.g., after plate solving)
  useEffect(() => {
    if (open) {
      refetchTodos();
      refetchSchedules();
      refetchImages();
    }
  }, [open, refetchTodos, refetchSchedules, refetchImages]);

  // Load thumbnails for images
  useEffect(() => {
    const loadThumbnails = async () => {
      const newThumbnails: Record<string, string> = {};
      for (const image of images) {
        if (!thumbnails[image.id]) {
          try {
            const thumb = await imageApi.getThumbnail(image.id);
            if (thumb) {
              newThumbnails[image.id] = thumb;
            }
          } catch {
            // Ignore thumbnail loading errors
          }
        }
      }
      if (Object.keys(newThumbnails).length > 0) {
        setThumbnails(prev => ({ ...prev, ...newThumbnails }));
      }
    };

    if (open && images.length > 0) {
      loadThumbnails();
    }
  }, [open, images, thumbnails]);

  // Search and filter results
  const results = useMemo((): SearchResult[] => {
    const searchResults: SearchResult[] = [];
    const trimmedQuery = query.trim();

    // Search todos
    if (filter === "all" || filter === "todos") {
      todos.forEach((todo) => {
        const matches =
          !trimmedQuery ||
          flexibleMatch(todo.name, trimmedQuery) ||
          (todo.notes && flexibleMatch(todo.notes, trimmedQuery));

        if (matches) {
          searchResults.push({
            id: todo.id,
            type: "todo",
            name: todo.name,
            subtitle: `Mag ${todo.magnitude}`,
            objectType: todo.object_type || undefined,
            data: todo,
          });
        }
      });
    }

    // Search schedules
    if (filter === "all" || filter === "schedules") {
      schedules.forEach((schedule) => {
        const matches =
          !trimmedQuery ||
          flexibleMatch(schedule.name, trimmedQuery) ||
          (schedule.description && flexibleMatch(schedule.description, trimmedQuery));

        if (matches) {
          const date = schedule.scheduled_date
            ? new Date(schedule.scheduled_date).toLocaleDateString()
            : "No date";
          searchResults.push({
            id: schedule.id,
            type: "schedule",
            name: schedule.name,
            subtitle: date,
            data: schedule,
          });
        }
      });
    }

    // Search images/observations
    if (filter === "all" || filter === "observations") {
      images.forEach((image) => {
        // Parse metadata for object info
        let objectName = image.filename;
        let objectType: string | undefined;
        let date = new Date(image.created_at).toLocaleDateString();
        let annotationNames: string[] = [];

        // Try to get name from summary first
        if (image.summary) {
          objectName = image.summary;
        }

        // Parse metadata to extract observation date (DATE-OBS from FITS)
        if (image.metadata) {
          try {
            const meta = JSON.parse(image.metadata);
            // Check for FITS DATE-OBS field
            if (meta.fits && meta.fits["DATE-OBS"]) {
              const dateObs = new Date(meta.fits["DATE-OBS"]);
              if (!isNaN(dateObs.getTime())) {
                date = dateObs.toLocaleDateString();
              }
            }
            // Also check for date_obs at top level
            if (meta.date_obs) {
              const dateObs = new Date(meta.date_obs);
              if (!isNaN(dateObs.getTime())) {
                date = dateObs.toLocaleDateString();
              }
            }
          } catch {
            // Ignore parse errors
          }
        }

        // Parse annotations for object names and type
        let catalogNames: string[] = [];
        if (image.annotations) {
          try {
            const annotations = JSON.parse(image.annotations);
            if (Array.isArray(annotations)) {
              annotations.forEach((ann: { name?: string; type?: string; objectType?: string }) => {
                // Collect object names for searching
                if (ann.name) {
                  annotationNames.push(ann.name);
                  // Collect catalog names for display (first 4)
                  if (catalogNames.length < 4) {
                    catalogNames.push(ann.name);
                  }
                }
                // Get object type from first annotation if not set
                if (!objectType && (ann.type || ann.objectType)) {
                  objectType = ann.type || ann.objectType;
                }
              });
              // Use first annotation name as the display name if no summary
              if (!image.summary && annotations.length > 0 && annotations[0].name) {
                objectName = annotations[0].name;
              }
            }
          } catch {
            // Ignore parse errors
          }
        }

        // Match against query - include annotations (NGC, IC, Messier names)
        // Uses flexible matching to handle "M42" matching "M 42"
        const matches =
          !trimmedQuery ||
          flexibleMatch(objectName, trimmedQuery) ||
          flexibleMatch(image.filename, trimmedQuery) ||
          (image.description && flexibleMatch(image.description, trimmedQuery)) ||
          annotationNames.some(name => flexibleMatch(name, trimmedQuery));

        if (matches) {
          searchResults.push({
            id: image.id,
            type: "observation",
            name: objectName,
            subtitle: date,
            objectType,
            thumbnail: thumbnails[image.id],
            catalogNames: catalogNames.length > 0 ? catalogNames : undefined,
            data: image,
          });
        }
      });
    }

    return searchResults;
  }, [query, filter, todos, schedules, images, thumbnails]);

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [results.length]);

  // Focus input when dialog opens
  useEffect(() => {
    if (open) {
      setTimeout(() => {
        inputRef.current?.focus();
      }, 0);
    } else {
      // Reset state when closing
      setQuery("");
      setFilter("all");
      setSelectedIndex(0);
    }
  }, [open]);

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((prev) => Math.min(prev + 1, results.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((prev) => Math.max(prev - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          if (results[selectedIndex]) {
            handleSelect(results[selectedIndex]);
          }
          break;
        case "Escape":
          e.preventDefault();
          onOpenChange(false);
          break;
      }
    },
    [results, selectedIndex, onOpenChange]
  );

  // Scroll selected item into view
  useEffect(() => {
    if (resultsRef.current && results.length > 0) {
      const selectedElement = resultsRef.current.querySelector(
        `[data-index="${selectedIndex}"]`
      );
      selectedElement?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex, results.length]);

  // Handle selection
  const handleSelect = (result: SearchResult) => {
    onOpenChange(false);

    switch (result.type) {
      case "todo":
        navigate("/todo");
        break;
      case "schedule":
        navigate("/plan");
        break;
      case "observation":
        navigate(`/i/${result.id}`);
        break;
    }
  };

  // Get icon for result type
  const getTypeIcon = (type: SearchResult["type"]) => {
    switch (type) {
      case "todo":
        return <CheckSquare className="w-4 h-4 text-green-400" />;
      case "schedule":
        return <Calendar className="w-4 h-4 text-purple-400" />;
      case "observation":
        return <Telescope className="w-4 h-4 text-blue-400" />;
    }
  };

  // Get type label
  const getTypeLabel = (type: SearchResult["type"]) => {
    switch (type) {
      case "todo":
        return "Todo";
      case "schedule":
        return "Schedule";
      case "observation":
        return "Observation";
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-2xl p-0 gap-0 bg-slate-900/95 border-slate-700"
        showCloseButton={false}
      >
        {/* Search Input */}
        <div className="flex items-center border-b border-slate-700 px-4 py-3">
          <Search className="w-5 h-5 text-slate-400 mr-3" />
          <Input
            ref={inputRef}
            type="text"
            placeholder="Search observations, schedules, and targets..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 border-0 bg-transparent text-lg text-white placeholder:text-slate-500 focus-visible:ring-0 focus-visible:ring-offset-0"
          />
          <button
            onClick={() => onOpenChange(false)}
            className="text-slate-400 hover:text-slate-200 p-1"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Results or Empty State */}
        <div className="min-h-[300px] max-h-[500px]">
          {results.length === 0 && !query ? (
            // Empty state with quick filters
            <div className="p-8 text-center">
              <p className="text-slate-400 mb-6">
                Quick search across your astronomy data
              </p>
              <div className="flex justify-center gap-4 flex-wrap">
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn(
                    "gap-2 text-slate-300 hover:text-white hover:bg-slate-800",
                    filter === "todos" && "bg-slate-800 text-white"
                  )}
                  onClick={() => setFilter(filter === "todos" ? "all" : "todos")}
                >
                  <CheckSquare className="w-4 h-4 text-green-400" />
                  Todo Items
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn(
                    "gap-2 text-slate-300 hover:text-white hover:bg-slate-800",
                    filter === "schedules" && "bg-slate-800 text-white"
                  )}
                  onClick={() => setFilter(filter === "schedules" ? "all" : "schedules")}
                >
                  <Calendar className="w-4 h-4 text-purple-400" />
                  Schedules
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn(
                    "gap-2 text-slate-300 hover:text-white hover:bg-slate-800",
                    filter === "observations" && "bg-slate-800 text-white"
                  )}
                  onClick={() => setFilter(filter === "observations" ? "all" : "observations")}
                >
                  <Telescope className="w-4 h-4 text-blue-400" />
                  Observations
                </Button>
              </div>
            </div>
          ) : results.length === 0 ? (
            // No results
            <div className="p-8 text-center">
              <p className="text-slate-400">
                No results found for "{query}"
              </p>
            </div>
          ) : (
            // Results list
            <ScrollArea className="h-[400px]">
              <div ref={resultsRef} className="py-2">
                {results.map((result, index) => {
                  const typeInfo = result.objectType
                    ? getObjectTypeInfo(result.objectType)
                    : null;

                  return (
                    <button
                      key={`${result.type}-${result.id}`}
                      data-index={index}
                      className={cn(
                        "w-full flex items-center gap-3 px-4 py-3 text-left transition-colors",
                        index === selectedIndex
                          ? "bg-slate-800"
                          : "hover:bg-slate-800/50"
                      )}
                      onClick={() => handleSelect(result)}
                      onMouseEnter={() => setSelectedIndex(index)}
                    >
                      {/* Thumbnail or placeholder */}
                      <div className="w-16 h-16 rounded-md bg-slate-800 overflow-hidden flex-shrink-0">
                        {result.thumbnail ? (
                          <img
                            src={result.thumbnail}
                            alt={result.name}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            {getTypeIcon(result.type)}
                          </div>
                        )}
                      </div>

                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="font-medium text-white truncate">
                            {result.name}
                          </span>
                          {typeInfo && (
                            <Badge
                              variant="outline"
                              className="text-xs"
                              style={{
                                backgroundColor: typeInfo.color + "20",
                                borderColor: typeInfo.color,
                                color: typeInfo.color,
                              }}
                            >
                              {typeInfo.label}
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-sm text-slate-400">
                          {getTypeIcon(result.type)}
                          <span>{getTypeLabel(result.type)}</span>
                          <span className="text-slate-600">•</span>
                          <span>{result.subtitle}</span>
                        </div>
                        {/* Catalog names for observations */}
                        {result.catalogNames && result.catalogNames.length > 0 && (
                          <div className="text-xs text-slate-500 mt-1 truncate">
                            {result.catalogNames.join(", ")}
                          </div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </ScrollArea>
          )}
        </div>

        {/* Footer */}
        {results.length > 0 && (
          <div className="flex items-center justify-between px-4 py-2 border-t border-slate-700 text-xs text-slate-500">
            <span>Use ↑ ↓ to navigate</span>
            <span>Enter to select</span>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
