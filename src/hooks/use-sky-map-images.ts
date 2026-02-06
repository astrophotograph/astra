/**
 * React Query hook for fetching images for sky coverage map
 *
 * Fetches images for all collections that have plate-solved images
 * and extracts footprint data for visualization.
 */

import { useQuery } from "@tanstack/react-query";
import {
  imageApi,
  type Collection,
  type Image,
} from "@/lib/tauri/commands";
import {
  getImageFootprint,
  getCollectionColor,
  type ImageFootprint,
} from "@/lib/sky-map-utils";

export interface UnsolvedImage {
  id: string;
  filename: string;
  collectionId: string;
  collectionName: string;
  /** Hint RA from metadata (FITS header, etc.) */
  hintRa?: number;
  /** Hint Dec from metadata (FITS header, etc.) */
  hintDec?: number;
  /** Whether plate solving has previously failed for this image */
  hasFailed?: boolean;
}

export interface SkyMapData {
  footprints: ImageFootprint[];
  collectionColors: Record<string, string>;
  unsolvedImages: UnsolvedImage[];
}

/**
 * Check if an image has plate-solve data
 */
function isPlateSolved(image: Image): boolean {
  if (!image.metadata) return false;
  try {
    const metadata =
      typeof image.metadata === "string"
        ? JSON.parse(image.metadata)
        : image.metadata;
    return !!metadata.plate_solve;
  } catch {
    return false;
  }
}

/**
 * Check if an image has a failed plate-solve flag
 */
function hasPlateSolveFailed(image: Image): boolean {
  if (!image.metadata) return false;
  try {
    const metadata =
      typeof image.metadata === "string"
        ? JSON.parse(image.metadata)
        : image.metadata;
    return !!metadata.plate_solve_failed;
  } catch {
    return false;
  }
}

/**
 * Extract coordinate hints from image metadata
 * Looks for RA/Dec in FITS headers, target coordinates, etc.
 */
function extractCoordinateHints(image: Image): { hintRa?: number; hintDec?: number } {
  if (!image.metadata) return {};

  try {
    const metadata =
      typeof image.metadata === "string"
        ? JSON.parse(image.metadata)
        : image.metadata;

    // Check various possible sources of coordinates

    // 1. Target coordinates (if user specified a target)
    if (typeof metadata.target_ra === "number" && typeof metadata.target_dec === "number") {
      return { hintRa: metadata.target_ra, hintDec: metadata.target_dec };
    }

    // 2. FITS header coordinates (RA/DEC, OBJCTRA/OBJCTDEC, CRVAL1/CRVAL2)
    const fits = metadata.fits || {};

    // Try OBJCTRA/OBJCTDEC (common in astrophotography)
    if (fits.OBJCTRA && fits.OBJCTDEC) {
      const ra = parseCoordinate(fits.OBJCTRA, "ra");
      const dec = parseCoordinate(fits.OBJCTDEC, "dec");
      if (ra !== null && dec !== null) {
        return { hintRa: ra, hintDec: dec };
      }
    }

    // Try RA/DEC
    if (fits.RA && fits.DEC) {
      const ra = parseCoordinate(fits.RA, "ra");
      const dec = parseCoordinate(fits.DEC, "dec");
      if (ra !== null && dec !== null) {
        return { hintRa: ra, hintDec: dec };
      }
    }

    // Try CRVAL1/CRVAL2 (WCS reference point)
    if (typeof fits.CRVAL1 === "number" && typeof fits.CRVAL2 === "number") {
      return { hintRa: fits.CRVAL1, hintDec: fits.CRVAL2 };
    }

    // 3. Seestar metadata
    if (typeof metadata.ra === "number" && typeof metadata.dec === "number") {
      return { hintRa: metadata.ra, hintDec: metadata.dec };
    }

    return {};
  } catch {
    return {};
  }
}

/**
 * Parse a coordinate string (HMS or degrees) to degrees
 */
function parseCoordinate(value: string | number, type: "ra" | "dec"): number | null {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value !== "string") {
    return null;
  }

  // Try parsing as HMS/DMS (e.g., "12h 30m 45.5s" or "12:30:45.5" or "+45d 30m 15s")
  const hmsMatch = value.match(/^([+-]?)(\d+)[hd: ](\d+)[m: ](\d+(?:\.\d+)?)[s ]?$/i);
  if (hmsMatch) {
    const sign = hmsMatch[1] === "-" ? -1 : 1;
    const h = parseFloat(hmsMatch[2]);
    const m = parseFloat(hmsMatch[3]);
    const s = parseFloat(hmsMatch[4]);
    let degrees = h + m / 60 + s / 3600;
    if (type === "ra") {
      degrees *= 15; // Convert hours to degrees for RA
    }
    return sign * degrees;
  }

  // Try parsing as decimal degrees
  const num = parseFloat(value);
  if (!isNaN(num)) {
    return num;
  }

  return null;
}

/**
 * Fetch images for sky map from observation collections
 * Returns both plate-solved footprints and unsolved images for batch processing
 */
export function useSkyMapImages(
  collections: Collection[],
  collectionsMetadata: Record<string, { plateSolvedCount: number; imageCount: number }>
) {
  // Filter to active (non-archived) collections that have images
  const activeCollections = collections.filter((c) => {
    const meta = collectionsMetadata[c.id];
    return meta && meta.imageCount > 0 && !c.archived;
  });

  return useQuery({
    queryKey: [
      "sky-map-images",
      activeCollections.map((c) => c.id).join(","),
    ],
    queryFn: async (): Promise<SkyMapData> => {
      const footprints: ImageFootprint[] = [];
      const collectionColors: Record<string, string> = {};
      const unsolvedImages: UnsolvedImage[] = [];
      let colorIndex = 0;

      // Fetch images for each collection
      for (const collection of activeCollections) {
        try {
          const images = await imageApi.getByCollection(collection.id);

          for (const image of images) {
            if (isPlateSolved(image)) {
              // Process plate-solved images
              const footprint = getImageFootprint(image, collection);
              if (footprint) {
                footprints.push(footprint);

                // Assign color to collection if not already assigned
                if (footprint.collectionId && !collectionColors[footprint.collectionId]) {
                  collectionColors[footprint.collectionId] = getCollectionColor(
                    footprint.collectionId,
                    colorIndex++
                  );
                }
              }
            } else {
              // Track unsolved images with coordinate hints from metadata
              const hints = extractCoordinateHints(image);
              unsolvedImages.push({
                id: image.id,
                filename: image.filename,
                collectionId: collection.id,
                collectionName: collection.name,
                hintRa: hints.hintRa,
                hintDec: hints.hintDec,
                hasFailed: hasPlateSolveFailed(image),
              });
            }
          }
        } catch (error) {
          console.error(`Error fetching images for collection ${collection.id}:`, error);
        }
      }

      return { footprints, collectionColors, unsolvedImages };
    },
    enabled: activeCollections.length > 0,
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
    gcTime: 30 * 60 * 1000, // Keep in cache for 30 minutes
  });
}
