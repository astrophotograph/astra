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
