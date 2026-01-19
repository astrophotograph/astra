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
              // Track unsolved images
              unsolvedImages.push({
                id: image.id,
                filename: image.filename,
                collectionId: collection.id,
                collectionName: collection.name,
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
