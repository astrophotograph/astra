/**
 * Collection type utilities
 *
 * Maps collection templates to logical types for filtering and display.
 */

export type CollectionType = "observation" | "catalog" | "custom";

/**
 * Get the collection type based on the template field
 */
export function getCollectionType(template: string | null): CollectionType {
  if (template === "astrolog") return "observation";
  if (["messier", "caldwell", "ngc", "catalog"].includes(template || "")) return "catalog";
  return "custom";
}

/**
 * Get a display label for the collection type
 */
export function getCollectionTypeLabel(template: string | null): string {
  const type = getCollectionType(template);
  return type.charAt(0).toUpperCase() + type.slice(1);
}

/**
 * Color classes for each collection type (Tailwind)
 */
export const COLLECTION_TYPE_COLORS: Record<CollectionType, string> = {
  observation: "bg-violet-500/20 text-violet-300 border-violet-500/30",
  catalog: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  custom: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
};

/**
 * Template options for creating collections
 */
export const COLLECTION_TEMPLATES = [
  { value: "", label: "Custom", type: "custom" as CollectionType },
  { value: "astrolog", label: "Observation Log", type: "observation" as CollectionType },
  { value: "messier", label: "Messier Catalog", type: "catalog" as CollectionType },
  { value: "caldwell", label: "Caldwell Catalog", type: "catalog" as CollectionType },
  { value: "ngc", label: "NGC Catalog", type: "catalog" as CollectionType },
  { value: "catalog", label: "Generic Catalog", type: "catalog" as CollectionType },
] as const;

/**
 * Filter criteria for filtered/smart collections
 */
export interface CollectionFilters {
  dateRange?: { start: string; end: string };
  cameras?: string[];
  tags?: string[];
  targetNames?: string[];
}

/**
 * Parse FITS metadata value from debug format
 */
function parseFitsVal(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v);
  let m = s.match(/CharacterString\("([^"]*)"\)/);
  if (m) return m[1].trim();
  m = s.match(/IntegerNumber\((\d+)\)/);
  if (m) return m[1];
  if (s !== "None" && !s.startsWith("Some(")) return s;
  return null;
}

/**
 * Get the observation date from an image (DATE-OBS from FITS, or created_at)
 */
export function getImageObsDate(image: { metadata: string | null; created_at: string }): Date {
  if (image.metadata) {
    try {
      const meta = JSON.parse(image.metadata);
      const raw = meta["DATE-OBS"] || meta["date-obs"];
      if (raw) {
        const m = String(raw).match(/CharacterString\("([^"]*)"\)/);
        const dateStr = m ? m[1] : (String(raw) !== "None" ? String(raw) : null);
        if (dateStr) {
          const d = new Date(dateStr);
          if (!isNaN(d.getTime())) return d;
        }
      }
    } catch { /* ignore */ }
  }
  return new Date(image.created_at);
}

/**
 * Get camera/instrument name from image metadata
 */
export function getImageCamera(image: { metadata: string | null }): string | null {
  if (!image.metadata) return null;
  try {
    const meta = JSON.parse(image.metadata);
    return parseFitsVal(meta.INSTRUME || meta.instrume);
  } catch { return null; }
}

/**
 * Check if an image matches collection filter criteria
 */
export function imageMatchesFilters(
  image: { metadata: string | null; created_at: string; tags: string | null; annotations: string | null },
  filters: CollectionFilters,
): boolean {
  // Date range
  if (filters.dateRange) {
    const obsDate = getImageObsDate(image);
    const start = new Date(filters.dateRange.start);
    const end = new Date(filters.dateRange.end + "T23:59:59");
    if (obsDate < start || obsDate > end) return false;
  }

  // Camera
  if (filters.cameras && filters.cameras.length > 0) {
    const camera = getImageCamera(image);
    if (!camera || !filters.cameras.some((c) => camera.toLowerCase().includes(c.toLowerCase()))) {
      return false;
    }
  }

  // Tags
  if (filters.tags && filters.tags.length > 0) {
    const imageTags = (image.tags || "").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
    if (!filters.tags.some((t) => imageTags.includes(t.toLowerCase()))) {
      return false;
    }
  }

  // Target names
  if (filters.targetNames && filters.targetNames.length > 0) {
    if (!image.annotations) return false;
    try {
      const annotations = JSON.parse(image.annotations) as { name: string }[];
      const names = annotations.map((a) => a.name.replace(/\s+/g, "").toUpperCase());
      if (!filters.targetNames.some((t) => names.includes(t.replace(/\s+/g, "").toUpperCase()))) {
        return false;
      }
    } catch { return false; }
  }

  return true;
}
