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
  tags: string | null;  // JSON array of tag strings
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
  tags?: string[];
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
  tags?: string[];
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
  archived: boolean;
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
  archived?: boolean;
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
  created_at: string;
  updated_at: string;
  thumbnail: string | null;
  fits_url: string | null;
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

export interface PopulateFitsUrlsResult {
  totalChecked: number;
  updated: number;
  alreadySet: number;
  noFitsFound: number;
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
  equipment_id: string | null;
}

export interface CreateScheduleInput {
  name: string;
  description?: string;
  scheduled_date?: string;
  location?: string;
  is_active?: boolean;
  equipment_id?: string;
}

export interface UpdateScheduleInput {
  id: string;
  name?: string;
  description?: string;
  scheduled_date?: string;
  location?: string;
  items?: ScheduleItem[];
  is_active?: boolean;
  equipment_id?: string;
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

  // Many-to-many relationship methods
  addToCollection: (imageId: string, collectionId: string) =>
    invoke<boolean>("add_image_to_collection", { imageId, collectionId }),

  removeFromCollection: (imageId: string, collectionId: string) =>
    invoke<boolean>("remove_image_from_collection", { imageId, collectionId }),

  getCollections: (imageId: string) =>
    invoke<Collection[]>("get_image_collections", { imageId }),

  // Image data methods
  getData: (id: string) =>
    invoke<string>("get_image_data", { id }),

  getThumbnail: (id: string) =>
    invoke<string>("get_image_thumbnail", { id }),

  // FITS URL population methods
  populateFitsUrls: () =>
    invoke<PopulateFitsUrlsResult>("populate_fits_urls"),

  ensureFitsUrl: (id: string) =>
    invoke<string | null>("ensure_fits_url", { id }),
};

export const collectionImageApi = {
  /**
   * Get count of images in a collection
   */
  getCount: (collectionId: string) =>
    invoke<number>("get_collection_image_count", { collectionId }),
};

// =============================================================================
// Schedule Commands
// =============================================================================

export const scheduleApi = {
  getAll: () => invoke<ObservationSchedule[]>("get_schedules"),

  getActive: () => invoke<ObservationSchedule | null>("get_active_schedule"),

  getActiveSchedules: () => invoke<ObservationSchedule[]>("get_active_schedules"),

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

export interface PathPrefix {
  prefix: string;
  count: number;
}

export interface RemapResult {
  success: boolean;
  urls_updated: number;
  fits_urls_updated: number;
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

  /**
   * Get common path prefixes from image URLs (for path remapping after import)
   */
  getPathPrefixes: () =>
    invoke<PathPrefix[]>("get_image_path_prefixes"),

  /**
   * Remap image file paths (replace old prefix with new prefix)
   */
  remapPaths: (oldPrefix: string, newPrefix: string) =>
    invoke<RemapResult>("remap_image_paths", { oldPrefix, newPrefix }),
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

// =============================================================================
// Bulk Scan Types
// =============================================================================

export interface BulkScanInput {
  directory: string;
  tags?: string;
  stacked_only: boolean;
  max_files?: number;
}

export interface BulkScanResult {
  images_imported: number;
  collections_created: number;
  images_skipped: number;
  errors: string[];
}

export interface BulkScanPreview {
  total_images: number;
  stacked_images: number;
  raw_subframes: number;
  with_fits: number;
  with_jpeg: number;
  sample_files: PreviewFile[];
}

export interface PreviewFile {
  name: string;
  directory: string;
  has_fits: boolean;
  has_jpeg: boolean;
  is_stacked: boolean;
}

// =============================================================================
// Bulk Scan Commands
// =============================================================================

export const scanApi = {
  /**
   * Preview what would be imported from a directory scan
   */
  preview: (input: BulkScanInput) =>
    invoke<BulkScanPreview>("preview_bulk_scan", { input }),

  /**
   * Bulk scan a directory and import images
   */
  scan: (input: BulkScanInput) =>
    invoke<BulkScanResult>("bulk_scan_directory", { input }),

  /**
   * Cancel an ongoing scan operation
   */
  cancel: () => invoke<void>("cancel_scan"),
};

// =============================================================================
// Raw File Collection Types
// =============================================================================

export interface CollectRawFilesInput {
  /** List of stacked image file paths */
  stacked_paths: string[];
  /** Target directory to copy files to */
  target_directory: string;
}

export interface CollectRawFilesResult {
  /** Number of files copied */
  files_copied: number;
  /** Number of files skipped (already exist or errors) */
  files_skipped: number;
  /** Total bytes copied */
  bytes_copied: number;
  /** Any errors encountered */
  errors: string[];
}

// =============================================================================
// Raw File Collection Commands
// =============================================================================

export const collectApi = {
  /**
   * Collect raw subframe files for targets
   */
  collect: (input: CollectRawFilesInput) =>
    invoke<CollectRawFilesResult>("collect_raw_files", { input }),

  /**
   * Cancel an ongoing collect operation
   */
  cancel: () => invoke<void>("cancel_collect"),
};

// =============================================================================
// Plate Solving Types
// =============================================================================

export interface PlateSolveInput {
  /** Image ID to plate solve */
  id: string;
  /** Solver type: "nova", "local", or "astap" */
  solver: string;
  /** API key for nova.astrometry.net (required for nova solver) */
  apiKey?: string;
  /** Custom API URL for local astrometry.net instance (optional) */
  apiUrl?: string;
  /** Lower bound of expected image scale (arcsec/pixel) */
  scaleLower?: number;
  /** Upper bound of expected image scale (arcsec/pixel) */
  scaleUpper?: number;
  /** Timeout in seconds */
  timeout?: number;
  /** Whether to query catalogs for objects after solving */
  queryCatalogs?: boolean;
  /** Catalogs to query (if not specified, queries all) */
  catalogs?: string[];
  /** Magnitude limit for bright stars */
  starMagLimit?: number;
  /** Hint RA in degrees (to speed up solving) */
  hintRa?: number;
  /** Hint Dec in degrees (to speed up solving) */
  hintDec?: number;
  /** Hint search radius in degrees (default: 10) */
  hintRadius?: number;
}

export interface PlateSolveResult {
  success: boolean;
  centerRa: number;
  centerDec: number;
  pixelScale: number;
  rotation: number;
  widthDeg: number;
  heightDeg: number;
  imageWidth: number;
  imageHeight: number;
  solver: string;
  solveTime: number;
  errorMessage?: string;
}

export interface CatalogObject {
  name: string;
  catalog: string;
  objectType: string;
  ra: number;
  dec: number;
  magnitude?: number;
  size?: string;
  sizeArcmin?: number;
  commonName?: string;
}

export interface PlateSolveResponse extends PlateSolveResult {
  objects: CatalogObject[];
}

// =============================================================================
// Plate Solving Commands
// =============================================================================

export const plateSolveApi = {
  /**
   * Plate solve an image and optionally query catalogs for objects
   */
  solve: (input: PlateSolveInput) =>
    invoke<PlateSolveResponse>("plate_solve_image", { input }),

  /**
   * Query catalogs for objects in a given sky region
   */
  queryRegion: (
    centerRa: number,
    centerDec: number,
    widthDeg: number,
    heightDeg: number,
    catalogs?: string[],
    starMagLimit?: number
  ) =>
    invoke<CatalogObject[]>("query_sky_region", {
      centerRa,
      centerDec,
      widthDeg,
      heightDeg,
      catalogs,
      starMagLimit,
    }),
};

// =============================================================================
// Skymap Types
// =============================================================================

export interface SkymapInput {
  /** Center Right Ascension in degrees */
  centerRa: number;
  /** Center Declination in degrees */
  centerDec: number;
  /** Field of view width in degrees for the map */
  fovWidth?: number;
  /** Field of view height in degrees for the map */
  fovHeight?: number;
  /** Image FOV width in degrees (for rectangle overlay) */
  imageWidth?: number;
  /** Image FOV height in degrees (for rectangle overlay) */
  imageHeight?: number;
}

export interface SkymapResponse {
  success: boolean;
  /** Base64-encoded PNG image */
  image?: string;
  error?: string;
}

// =============================================================================
// Skymap Commands
// =============================================================================

export const skymapApi = {
  /**
   * Generate a skymap showing the location of an image on the sky
   */
  generate: (input: SkymapInput) =>
    invoke<SkymapResponse>("generate_skymap", { input }),

  /**
   * Generate a wide-field skymap showing position on the entire sky
   */
  generateWide: (centerRa: number, centerDec: number) =>
    invoke<SkymapResponse>("generate_wide_skymap", { centerRa, centerDec }),
};

// =============================================================================
// Image Processing Types
// =============================================================================

export interface ProcessImageInput {
  /** Image ID to process */
  id: string;
  /** Target type override (optional, defaults to "auto") */
  targetType?: string;
  /** Stretch method (optional, defaults to "statistical") */
  stretchMethod?: string;
  /** Stretch factor (optional, default based on target type) */
  stretchFactor?: number;
  /** Whether to remove background (optional, defaults to true) */
  backgroundRemoval?: boolean;
  /** Whether to reduce star brightness (optional, defaults to false) */
  starReduction?: boolean;
  /** Whether to apply color calibration (optional, defaults to true) */
  colorCalibration?: boolean;
  /** Noise reduction strength 0-1 (optional, defaults to 0) */
  noiseReduction?: number;
  /** Contrast adjustment (optional, defaults to 1.3 for Seestar-like output) */
  contrast?: number;
}

export interface ProcessingResult {
  success: boolean;
  outputFitsPath: string;
  outputPreviewPath: string;
  targetType: string;
  processingParams: Record<string, unknown>;
  processingTime: number;
  errorMessage?: string;
}

export interface ProcessImageResponse extends ProcessingResult {}

export interface TargetInfo {
  targetType: string;
  objectName: string;
  confidence: number;
  simbadType?: string;
}

export interface ProcessingParams {
  targetType: string;
  stretchMethod: string;
  stretchFactor: number;
  backgroundRemoval: boolean;
  starReduction: boolean;
  colorCalibration: boolean;
  noiseReduction: number;
  contrast: number;
}

// Target type enum for UI
export const TARGET_TYPES = [
  { value: "auto", label: "Auto-detect" },
  { value: "emission_nebula", label: "Emission Nebula" },
  { value: "reflection_nebula", label: "Reflection Nebula" },
  { value: "planetary_nebula", label: "Planetary Nebula" },
  { value: "galaxy", label: "Galaxy" },
  { value: "globular_cluster", label: "Globular Cluster" },
  { value: "open_cluster", label: "Open Cluster" },
  { value: "star_field", label: "Star Field" },
] as const;

// Stretch method enum for UI
export const STRETCH_METHODS = [
  { value: "statistical", label: "Statistical (Recommended)" },
  { value: "arcsinh", label: "Arcsinh" },
  { value: "log", label: "Logarithmic" },
] as const;

// =============================================================================
// Image Processing Commands
// =============================================================================

export const imageProcessApi = {
  /**
   * Process a FITS image with stretch and enhancements
   */
  process: (input: ProcessImageInput) =>
    invoke<ProcessImageResponse>("process_fits_image", { input }),

  /**
   * Classify a target from its object name
   */
  classifyTarget: (objectName: string) =>
    invoke<TargetInfo>("classify_target_type", { objectName }),

  /**
   * Get default processing parameters for a target type
   */
  getDefaults: (targetType: string) =>
    invoke<ProcessingParams>("get_processing_defaults", { targetType }),
};

// =============================================================================
// Target Browser Types
// =============================================================================

export interface TargetWithCount {
  /** Target/object name */
  name: string;
  /** Number of images of this target */
  imageCount: number;
  /** ID of the most recent image */
  latestImageId: string | null;
  /** Thumbnail of the most recent image */
  latestThumbnail: string | null;
}

// =============================================================================
// Target Browser Commands
// =============================================================================

export const targetApi = {
  /**
   * Get all unique targets with their image counts
   */
  getAll: () => invoke<TargetWithCount[]>("get_targets"),

  /**
   * Search images by target name (partial match)
   */
  searchImages: (query: string) =>
    invoke<Image[]>("search_images_by_target", { query }),

  /**
   * Get all images for a specific target (exact match)
   */
  getImages: (targetName: string) =>
    invoke<Image[]>("get_images_by_target", { targetName }),
};
