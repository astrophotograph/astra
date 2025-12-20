/**
 * Typed Tauri command wrappers
 *
 * This module provides type-safe wrappers around Tauri's invoke function
 * for all backend commands.
 */

import { invoke } from "@tauri-apps/api/core";

// =============================================================================
// Types
// =============================================================================

export interface AppInfo {
  name: string;
  version: string;
  description: string;
}

export interface AstronomyTodo {
  id: string;
  user_id: string;
  name: string;
  ra: string;
  dec: string;
  magnitude: string;
  size: string;
  object_type: string | null;
  added_at: string;
  completed: boolean;
  completed_at: string | null;
  goal_time: string | null;
  notes: string | null;
  flagged: boolean;
  last_updated: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateTodoInput {
  name: string;
  ra: string;
  dec: string;
  magnitude: string;
  size: string;
  object_type?: string;
  goal_time?: string;
  notes?: string;
}

export interface UpdateTodoInput {
  id: string;
  name?: string;
  ra?: string;
  dec?: string;
  magnitude?: string;
  size?: string;
  object_type?: string;
  completed?: boolean;
  completed_at?: string;
  goal_time?: string;
  notes?: string;
  flagged?: boolean;
}

export interface Collection {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  visibility: string;
  template: string | null;
  favorite: boolean;
  tags: string | null;
  metadata: string | null;
  is_synced: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateCollectionInput {
  name: string;
  description?: string;
  visibility?: string;
  template?: string;
  tags?: string;
}

export interface UpdateCollectionInput {
  id: string;
  name?: string;
  description?: string;
  visibility?: string;
  template?: string;
  favorite?: boolean;
  tags?: string;
  metadata?: string;
}

export interface Image {
  id: string;
  user_id: string;
  collection_id: string | null;
  filename: string;
  url: string | null;
  summary: string | null;
  description: string | null;
  content_type: string | null;
  favorite: boolean;
  tags: string | null;
  visibility: string | null;
  location: string | null;
  annotations: string | null;
  metadata: string | null;
  is_synced: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateImageInput {
  collection_id?: string;
  filename: string;
  url?: string;
  summary?: string;
  description?: string;
  content_type?: string;
  tags?: string;
  visibility?: string;
  location?: string;
  annotations?: string;
  metadata?: string;
}

export interface UpdateImageInput {
  id: string;
  collection_id?: string;
  filename?: string;
  url?: string;
  summary?: string;
  description?: string;
  content_type?: string;
  favorite?: boolean;
  tags?: string;
  visibility?: string;
  location?: string;
  annotations?: string;
  metadata?: string;
}

export interface ScheduleItem {
  id: string;
  todo_id: string;
  object_name: string;
  start_time: string;
  end_time: string;
  priority: number;
  notes: string | null;
  completed: boolean;
}

export interface ObservationSchedule {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  scheduled_date: string | null;
  location: string | null;
  items: string; // JSON string of ScheduleItem[]
  is_active: boolean;
  is_synced: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateScheduleInput {
  name: string;
  description?: string;
  scheduled_date?: string;
  location?: string;
  is_active?: boolean;
}

export interface UpdateScheduleInput {
  id: string;
  name?: string;
  description?: string;
  scheduled_date?: string;
  location?: string;
  items?: ScheduleItem[];
  is_active?: boolean;
}

// =============================================================================
// App Commands
// =============================================================================

export const appApi = {
  getInfo: () => invoke<AppInfo>("get_app_info"),
};

// =============================================================================
// Todo Commands
// =============================================================================

export const todoApi = {
  getAll: () => invoke<AstronomyTodo[]>("get_todos"),

  getById: (id: string) => invoke<AstronomyTodo | null>("get_todo", { id }),

  create: (input: CreateTodoInput) =>
    invoke<AstronomyTodo>("create_todo", { input }),

  update: (input: UpdateTodoInput) =>
    invoke<AstronomyTodo>("update_todo", { input }),

  delete: (id: string) => invoke<boolean>("delete_todo", { id }),

  sync: () => invoke<AstronomyTodo[]>("sync_todos"),
};

// =============================================================================
// Collection Commands
// =============================================================================

export const collectionApi = {
  getAll: () => invoke<Collection[]>("get_collections"),

  getById: (id: string) =>
    invoke<Collection | null>("get_collection", { id }),

  create: (input: CreateCollectionInput) =>
    invoke<Collection>("create_collection", { input }),

  update: (input: UpdateCollectionInput) =>
    invoke<Collection>("update_collection", { input }),

  delete: (id: string) => invoke<boolean>("delete_collection", { id }),
};

// =============================================================================
// Image Commands
// =============================================================================

export const imageApi = {
  getAll: () => invoke<Image[]>("get_images"),

  getByCollection: (collectionId: string) =>
    invoke<Image[]>("get_collection_images", { collectionId }),

  getById: (id: string) => invoke<Image | null>("get_image", { id }),

  create: (input: CreateImageInput) =>
    invoke<Image>("create_image", { input }),

  update: (input: UpdateImageInput) =>
    invoke<Image>("update_image", { input }),

  delete: (id: string) => invoke<boolean>("delete_image", { id }),
};

// =============================================================================
// Schedule Commands
// =============================================================================

export const scheduleApi = {
  getAll: () => invoke<ObservationSchedule[]>("get_schedules"),

  getActive: () => invoke<ObservationSchedule | null>("get_active_schedule"),

  getById: (id: string) =>
    invoke<ObservationSchedule | null>("get_schedule", { id }),

  create: (input: CreateScheduleInput) =>
    invoke<ObservationSchedule>("create_schedule", { input }),

  update: (input: UpdateScheduleInput) =>
    invoke<ObservationSchedule>("update_schedule", { input }),

  delete: (id: string) => invoke<boolean>("delete_schedule", { id }),

  addItem: (scheduleId: string, item: ScheduleItem) =>
    invoke<ObservationSchedule>("add_schedule_item", { scheduleId, item }),

  removeItem: (scheduleId: string, itemId: string) =>
    invoke<ObservationSchedule>("remove_schedule_item", { scheduleId, itemId }),
};

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Parse schedule items from JSON string
 */
export function parseScheduleItems(schedule: ObservationSchedule): ScheduleItem[] {
  try {
    return JSON.parse(schedule.items);
  } catch {
    return [];
  }
}

/**
 * Parse tags from comma-separated string
 */
export function parseTags(tags: string | null): string[] {
  if (!tags) return [];
  return tags.split(",").map((t) => t.trim()).filter(Boolean);
}

/**
 * Convert tags array to comma-separated string
 */
export function stringifyTags(tags: string[]): string {
  return tags.join(", ");
}

// =============================================================================
// Astronomy Types
// =============================================================================

export interface SimbadObject {
  name: string;
  objectType: string;
  ra: string;
  dec: string;
  raDeg?: number;
  decDeg?: number;
  magnitude?: string;
  size?: string;
  commonName?: string;
  distance?: {
    parsecs: number;
    lightYears: number;
  };
  spectralType?: string;
  alternativeNames?: string[];
  catalogs?: Record<string, string>;
}

export interface ObserverLocation {
  latitude: number;
  longitude: number;
  elevation?: number;
  name?: string;
}

export interface AltitudePoint {
  time: string;
  altitude: number;
  azimuth: number;
  compassDirection: string;
}

export interface SunTimes {
  sunrise: string | null;
  sunset: string | null;
  civilTwilightStart: string | null;
  civilTwilightEnd: string | null;
  nauticalTwilightStart: string | null;
  nauticalTwilightEnd: string | null;
  astronomicalTwilightStart: string | null;
  astronomicalTwilightEnd: string | null;
}

// =============================================================================
// Astronomy Commands
// =============================================================================

// =============================================================================
// Backup Types
// =============================================================================

export interface BackupInfo {
  filename: string;
  path: string;
  size_bytes: number;
  created_at: string;
}

export interface BackupResult {
  success: boolean;
  message: string;
  backup_info: BackupInfo | null;
}

export interface RestoreResult {
  success: boolean;
  message: string;
}

// =============================================================================
// Backup Commands
// =============================================================================

export const backupApi = {
  /**
   * Create a backup of the database
   */
  create: () => invoke<BackupResult>("create_backup"),

  /**
   * List all available backups
   */
  list: () => invoke<BackupInfo[]>("list_backups"),

  /**
   * Restore database from a backup
   */
  restore: (backupPath: string) =>
    invoke<RestoreResult>("restore_backup", { backupPath }),

  /**
   * Delete a backup file
   */
  delete: (backupPath: string) =>
    invoke<RestoreResult>("delete_backup", { backupPath }),

  /**
   * Export database to a custom location
   */
  export: (exportPath: string) =>
    invoke<BackupResult>("export_database", { exportPath }),

  /**
   * Import database from a custom location
   */
  import: (importPath: string) =>
    invoke<RestoreResult>("import_database", { importPath }),
};

export const astronomyApi = {
  /**
   * Look up an astronomical object in SIMBAD
   */
  lookupObject: (name: string) =>
    invoke<SimbadObject | null>("lookup_astronomy_object", { name }),

  /**
   * Calculate current altitude and azimuth for an object
   */
  calculateAltitude: (raDeg: number, decDeg: number, location: ObserverLocation) =>
    invoke<AltitudePoint>("calculate_object_altitude", { raDeg, decDeg, location }),

  /**
   * Calculate altitude data over a time range for plotting
   */
  calculateAltitudeData: (
    raDeg: number,
    decDeg: number,
    location: ObserverLocation,
    durationHours?: number,
    intervalMinutes?: number
  ) =>
    invoke<AltitudePoint[]>("calculate_altitude_data", {
      raDeg,
      decDeg,
      location,
      durationHours,
      intervalMinutes,
    }),

  /**
   * Get sunrise, sunset, and twilight times for a location
   */
  getSunTimes: (location: ObserverLocation) =>
    invoke<SunTimes>("get_sun_times", { location }),
};
