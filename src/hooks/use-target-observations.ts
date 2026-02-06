/**
 * Hook to get observation statistics for a target
 * Groups observations by camera and focal length
 */

import { useMemo } from "react";
import { useImages } from "./use-images";
import type { Image, CatalogObject } from "@/lib/tauri/commands";

export interface ObservationGroup {
  camera: string;
  focalLength: number | null;
  pixelScale: number | null;
  imageCount: number;
  totalExposureSeconds: number;
  images: Image[];
}

export interface TargetObservations {
  totalImages: number;
  totalExposureSeconds: number;
  groups: ObservationGroup[];
}

// Parse plate solve metadata from image
function parsePlateSolveInfo(image: Image): { focalLength: number | null; pixelScale: number | null } {
  if (!image.metadata) return { focalLength: null, pixelScale: null };
  try {
    const metadata = JSON.parse(image.metadata);
    const plateSolve = metadata.plate_solve;
    if (!plateSolve) return { focalLength: null, pixelScale: null };
    return {
      focalLength: metadata.calculated_focal_length || null,
      pixelScale: plateSolve.pixel_scale || null,
    };
  } catch {
    return { focalLength: null, pixelScale: null };
  }
}

// Extract exposure time in seconds from image metadata
function extractExposureSeconds(image: Image): number {
  if (!image.metadata) return 0;
  try {
    const metadata = JSON.parse(image.metadata);
    // Check various possible exposure fields
    if (typeof metadata.exposure === "number") return metadata.exposure;
    if (typeof metadata.exposure_time === "number") return metadata.exposure_time;
    if (typeof metadata.exptime === "number") return metadata.exptime;
    // Check FITS-style nested structure
    if (metadata.fits?.EXPTIME) return parseFloat(metadata.fits.EXPTIME) || 0;
    if (metadata.fits?.EXPOSURE) return parseFloat(metadata.fits.EXPOSURE) || 0;
    return 0;
  } catch {
    return 0;
  }
}

// Check if image matches target by name
function imageMatchesTarget(image: Image, targetName: string): boolean {
  const normalizedTarget = targetName.toLowerCase().trim();

  // Check summary
  if (image.summary?.toLowerCase().includes(normalizedTarget)) {
    return true;
  }

  // Check description
  if (image.description?.toLowerCase().includes(normalizedTarget)) {
    return true;
  }

  // Check tags
  if (image.tags?.toLowerCase().includes(normalizedTarget)) {
    return true;
  }

  // Check annotations (catalog objects from plate solve)
  if (image.annotations) {
    try {
      const annotations = JSON.parse(image.annotations) as CatalogObject[];
      for (const obj of annotations) {
        if (obj.name.toLowerCase() === normalizedTarget) {
          return true;
        }
        if (obj.commonName?.toLowerCase() === normalizedTarget) {
          return true;
        }
      }
    } catch {
      // Ignore parse errors
    }
  }

  return false;
}

// Extract camera name from image metadata or filename
function extractCameraName(image: Image): string {
  // Try to get from metadata
  if (image.metadata) {
    try {
      const metadata = JSON.parse(image.metadata);
      if (metadata.camera) return metadata.camera;
      if (metadata.equipment?.camera) return metadata.equipment.camera;
    } catch {
      // Ignore
    }
  }

  // Fallback to "Unknown"
  return "Unknown";
}

export function useTargetObservations(targetName: string | null): TargetObservations | null {
  const { data: images = [] } = useImages();

  return useMemo(() => {
    if (!targetName) return null;

    // Find all images that match this target
    const matchingImages = images.filter(img => imageMatchesTarget(img, targetName));

    if (matchingImages.length === 0) {
      return { totalImages: 0, totalExposureSeconds: 0, groups: [] };
    }

    // Group by camera and approximate focal length
    const groupMap = new Map<string, ObservationGroup>();

    for (const image of matchingImages) {
      const camera = extractCameraName(image);
      const { focalLength, pixelScale } = parsePlateSolveInfo(image);
      const exposureSeconds = extractExposureSeconds(image);

      // Create group key - round focal length to nearest 10mm for grouping
      const roundedFL = focalLength ? Math.round(focalLength / 10) * 10 : 0;
      const groupKey = `${camera}|${roundedFL}`;

      const existing = groupMap.get(groupKey);
      if (existing) {
        existing.imageCount++;
        existing.totalExposureSeconds += exposureSeconds;
        existing.images.push(image);
      } else {
        groupMap.set(groupKey, {
          camera,
          focalLength: focalLength ? roundedFL : null,
          pixelScale,
          imageCount: 1,
          totalExposureSeconds: exposureSeconds,
          images: [image],
        });
      }
    }

    // Calculate total exposure across all groups
    const groups = Array.from(groupMap.values()).sort((a, b) => b.imageCount - a.imageCount);
    const totalExposureSeconds = groups.reduce((sum, g) => sum + g.totalExposureSeconds, 0);

    return {
      totalImages: matchingImages.length,
      totalExposureSeconds,
      groups,
    };
  }, [images, targetName]);
}
