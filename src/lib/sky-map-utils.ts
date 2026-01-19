/**
 * Sky Map Utilities
 *
 * Helper functions for extracting plate-solve footprint data from images
 * and calculating bounding boxes for Aladin Lite visualization.
 */

import type { Image, Collection } from "@/lib/tauri/commands";

/**
 * Footprint data for a single plate-solved image
 */
export interface ImageFootprint {
  id: string;
  centerRa: number;
  centerDec: number;
  widthDeg: number;
  heightDeg: number;
  rotation: number;
  thumbnail?: string;
  filename: string;
  collectionId?: string;
  collectionName?: string;
  exposureSeconds: number;
}

/**
 * Extract plate-solve footprint from image metadata
 * Returns null if the image has not been plate-solved
 */
export function getImageFootprint(
  image: Image,
  collection?: Collection
): ImageFootprint | null {
  if (!image.metadata) return null;

  try {
    const metadata =
      typeof image.metadata === "string"
        ? JSON.parse(image.metadata)
        : image.metadata;

    const plateSolve = metadata.plate_solve;
    if (!plateSolve) return null;

    // Extract center coordinates
    const centerRa = plateSolve.center_ra ?? plateSolve.ra;
    const centerDec = plateSolve.center_dec ?? plateSolve.dec;

    if (centerRa == null || centerDec == null) return null;

    // Extract field dimensions (in degrees)
    // Try multiple possible field names from different plate solvers
    let widthDeg = plateSolve.width_deg ?? plateSolve.field_width ?? plateSolve.width ?? plateSolve.fieldw;
    let heightDeg = plateSolve.height_deg ?? plateSolve.field_height ?? plateSolve.height ?? plateSolve.fieldh;

    // If dimensions are in arcminutes (likely > 10), convert to degrees
    if (widthDeg && widthDeg > 10) {
      widthDeg = widthDeg / 60;
    }
    if (heightDeg && heightDeg > 10) {
      heightDeg = heightDeg / 60;
    }

    // Default FOV if not available (typical small telescope)
    if (!widthDeg) widthDeg = 1.0;
    if (!heightDeg) heightDeg = widthDeg * 0.75;

    // Rotation angle (degrees, counter-clockwise from north)
    const rotation = plateSolve.orientation ?? plateSolve.rotation ?? 0;

    // Extract exposure time
    const exposureSeconds = extractExposureFromMetadata(metadata, image.filename);

    return {
      id: image.id,
      centerRa,
      centerDec,
      widthDeg,
      heightDeg,
      rotation,
      thumbnail: image.thumbnail ?? undefined,
      filename: image.filename,
      collectionId: collection?.id,
      collectionName: collection?.name,
      exposureSeconds,
    };
  } catch {
    return null;
  }
}

/**
 * Extract exposure time from metadata or filename
 */
function extractExposureFromMetadata(
  metadata: Record<string, unknown>,
  filename: string
): number {
  // Priority 1: Total integration time
  if (
    typeof metadata.total_integration_time === "number" &&
    metadata.total_integration_time > 0
  ) {
    return metadata.total_integration_time;
  }

  // Priority 2: Calculate from stacked frames
  const frames =
    metadata.stacked_frames ??
    metadata.stackedFrames ??
    metadata.frames ??
    metadata.STACKCNT;
  const perFrame =
    metadata.exposure ??
    metadata.exposure_time ??
    metadata.exptime;

  if (
    typeof frames === "number" &&
    frames > 0 &&
    typeof perFrame === "number" &&
    perFrame > 0
  ) {
    return frames * perFrame;
  }

  // Priority 3: Single exposure value
  if (typeof metadata.exposure === "number" && metadata.exposure > 0)
    return metadata.exposure;
  if (typeof metadata.exposure_time === "number" && metadata.exposure_time > 0)
    return metadata.exposure_time;

  // Try filename parsing for Seestar-style names
  const stackedMatch = filename.match(/Stacked_(\d+)_.*?_(\d+(?:\.\d+)?)s_/i);
  if (stackedMatch) {
    const frameCount = parseInt(stackedMatch[1], 10) || 0;
    const perFrameSeconds = parseFloat(stackedMatch[2]) || 0;
    return frameCount * perFrameSeconds;
  }

  return 0;
}

/**
 * Calculate bounding box that contains all footprints
 * Returns center RA/Dec and appropriate FOV for the map view
 */
export function calculateBoundingBox(footprints: ImageFootprint[]): {
  ra: number;
  dec: number;
  fov: number;
} {
  if (footprints.length === 0) {
    // Default to center of sky
    return { ra: 180, dec: 0, fov: 180 };
  }

  if (footprints.length === 1) {
    const fp = footprints[0];
    // Single footprint: center on it with some padding
    return {
      ra: fp.centerRa,
      dec: fp.centerDec,
      fov: Math.max(fp.widthDeg, fp.heightDeg) * 2,
    };
  }

  // Find bounding box of all footprints
  let minRa = Infinity;
  let maxRa = -Infinity;
  let minDec = Infinity;
  let maxDec = -Infinity;

  for (const fp of footprints) {
    // Account for rotation when calculating bounds
    const halfDiag = Math.sqrt(fp.widthDeg ** 2 + fp.heightDeg ** 2) / 2;

    minRa = Math.min(minRa, fp.centerRa - halfDiag);
    maxRa = Math.max(maxRa, fp.centerRa + halfDiag);
    minDec = Math.min(minDec, fp.centerDec - halfDiag);
    maxDec = Math.max(maxDec, fp.centerDec + halfDiag);
  }

  // Handle RA wrap-around near 0/360
  let raSpan = maxRa - minRa;
  let centerRa: number;

  if (raSpan > 180) {
    // Likely crosses RA=0, adjust calculation
    // Find the smallest gap
    const sortedRas = footprints.map((fp) => fp.centerRa).sort((a, b) => a - b);
    let maxGap = 0;
    let gapStart = 0;

    for (let i = 0; i < sortedRas.length; i++) {
      const nextI = (i + 1) % sortedRas.length;
      let gap = sortedRas[nextI] - sortedRas[i];
      if (nextI === 0) gap = 360 + gap;

      if (gap > maxGap) {
        maxGap = gap;
        gapStart = sortedRas[i];
      }
    }

    // Center is opposite the largest gap
    centerRa = (gapStart + (360 - maxGap) / 2) % 360;
    raSpan = 360 - maxGap;
  } else {
    centerRa = (minRa + maxRa) / 2;
  }

  const decSpan = maxDec - minDec;
  const centerDec = Math.max(-90, Math.min(90, (minDec + maxDec) / 2));

  // FOV should cover the larger span, with padding
  const fov = Math.max(raSpan, decSpan) * 1.5;

  return {
    ra: centerRa,
    dec: centerDec,
    fov: Math.min(180, Math.max(1, fov)),
  };
}

/**
 * Generate a unique color for a collection based on its ID
 */
const COLLECTION_COLORS = [
  "#ff6b6b", // Red
  "#4ecdc4", // Teal
  "#45b7d1", // Sky blue
  "#96ceb4", // Sage green
  "#ffeaa7", // Yellow
  "#dfe6e9", // Light gray
  "#a29bfe", // Purple
  "#fd79a8", // Pink
  "#00b894", // Emerald
  "#e17055", // Coral
  "#74b9ff", // Light blue
  "#55a3ff", // Blue
];

/**
 * Get a consistent color for a collection
 */
export function getCollectionColor(_collectionId: string, index: number): string {
  // Use the index for deterministic colors
  return COLLECTION_COLORS[index % COLLECTION_COLORS.length];
}

/**
 * Calculate the four corners of a rotated rectangle in RA/Dec coordinates
 * Accounts for cos(dec) correction for RA
 */
export function calculateCorners(
  centerRa: number,
  centerDec: number,
  widthDeg: number,
  heightDeg: number,
  rotationDeg: number
): Array<[number, number]> {
  const rotRad = (rotationDeg * Math.PI) / 180;
  const cosRot = Math.cos(rotRad);
  const sinRot = Math.sin(rotRad);
  const cosDec = Math.cos((centerDec * Math.PI) / 180);

  // Half dimensions
  const hw = widthDeg / 2;
  const hh = heightDeg / 2;

  // Corner offsets before rotation (in local tangent plane)
  const corners = [
    [-hw, hh], // Top-left
    [hw, hh], // Top-right
    [hw, -hh], // Bottom-right
    [-hw, -hh], // Bottom-left
  ];

  // Apply rotation and convert to RA/Dec
  return corners.map(([dx, dy]) => {
    // Rotate
    const rotX = dx * cosRot - dy * sinRot;
    const rotY = dx * sinRot + dy * cosRot;

    // Apply cos(dec) correction for RA and add to center
    const ra = centerRa + rotX / cosDec;
    const dec = centerDec + rotY;

    return [ra, dec] as [number, number];
  });
}

/**
 * Check if a point is inside a polygon using ray casting
 */
export function pointInPolygon(
  ra: number,
  dec: number,
  corners: Array<[number, number]>
): boolean {
  let inside = false;
  const n = corners.length;

  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = corners[i];
    const [xj, yj] = corners[j];

    if (
      yi > dec !== yj > dec &&
      ra < ((xj - xi) * (dec - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }

  return inside;
}

/**
 * Format seconds as human-readable duration
 */
export function formatDuration(seconds: number): string {
  if (seconds === 0) return "0s";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.round((seconds % 3600) / 60);

  if (days > 0) {
    if (hours > 0) return `${days}d ${hours}h`;
    if (minutes > 0) return `${days}d ${minutes}m`;
    return `${days}d`;
  }
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}
