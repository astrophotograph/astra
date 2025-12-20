// Types
export interface AstronomyObject {
  id: string;
  name: string;
  ra: string;
  dec: string;
  magnitude: string;
  size: string;
  objectType?: string;
  addedAt: string;
  completed: boolean;
  completedAt?: string;
  goalTime?: string;
  notes?: string;
  flagged?: boolean;
}

export type SortField = "name" | "magnitude" | "size" | "altitude" | "azimuth" | "goalTime" | "maxTime";
export type SortDirection = "asc" | "desc" | null;
