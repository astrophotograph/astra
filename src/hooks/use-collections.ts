/**
 * React Query hooks for collection operations
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  collectionApi,
  collectionImageApi,
  imageApi,
  type Collection,
  type CreateCollectionInput,
  type UpdateCollectionInput,
  type Image,
} from "@/lib/tauri/commands";
import { extractExposureSeconds } from "@/components/CatalogObjectDialog";

export const collectionKeys = {
  all: ["collections"] as const,
  lists: () => [...collectionKeys.all, "list"] as const,
  details: () => [...collectionKeys.all, "detail"] as const,
  detail: (id: string) => [...collectionKeys.details(), id] as const,
};

export function useCollections() {
  return useQuery({
    queryKey: collectionKeys.lists(),
    queryFn: () => collectionApi.getAll(),
    staleTime: 0, // Always refetch in background when component mounts
    gcTime: 30 * 60 * 1000, // Keep in cache for 30 minutes (shown instantly on return)
  });
}

export function useCollection(id: string) {
  return useQuery({
    queryKey: collectionKeys.detail(id),
    queryFn: () => collectionApi.getById(id),
    enabled: !!id,
  });
}

export function useCreateCollection() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateCollectionInput) => collectionApi.create(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: collectionKeys.lists() });
    },
  });
}

export function useUpdateCollection() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: UpdateCollectionInput) => collectionApi.update(input),
    onSuccess: (data: Collection) => {
      queryClient.invalidateQueries({ queryKey: collectionKeys.lists() });
      queryClient.setQueryData(collectionKeys.detail(data.id), data);
    },
  });
}

export function useDeleteCollection() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => collectionApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: collectionKeys.lists() });
    },
  });
}

// Helper to check if image is plate-solved
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

export interface CollectionMetadata {
  imageCount: number;
  plateSolvedCount: number;
  previewImage: Image | null;
  totalExposureSeconds: number;
}

/**
 * Fetch metadata for all collections (image counts, plate solved counts, preview images)
 * This is cached separately for instant loading on repeat visits
 */
export function useCollectionsMetadata(collections: Collection[]) {
  return useQuery({
    queryKey: [...collectionKeys.all, "metadata", collections.map((c) => c.id).join(",")],
    queryFn: async (): Promise<Record<string, CollectionMetadata>> => {
      const result: Record<string, CollectionMetadata> = {};

      for (const collection of collections) {
        try {
          const count = await collectionImageApi.getCount(collection.id);

          if (count > 0) {
            const images = await imageApi.getByCollection(collection.id);
            const favorite = images.find((img) => img.favorite);
            const totalExposure = images.reduce(
              (sum, img) => sum + extractExposureSeconds(img),
              0
            );
            result[collection.id] = {
              imageCount: count,
              plateSolvedCount: images.filter(isPlateSolved).length,
              previewImage: favorite || images[0] || null,
              totalExposureSeconds: totalExposure,
            };
          } else {
            result[collection.id] = {
              imageCount: 0,
              plateSolvedCount: 0,
              previewImage: null,
              totalExposureSeconds: 0,
            };
          }
        } catch (err) {
          console.error(`Error fetching metadata for ${collection.id}:`, err);
          result[collection.id] = {
            imageCount: 0,
            plateSolvedCount: 0,
            previewImage: null,
            totalExposureSeconds: 0,
          };
        }
      }

      return result;
    },
    enabled: collections.length > 0,
    staleTime: 0, // Always refetch in background when component mounts
    gcTime: 30 * 60 * 1000, // Keep in cache for 30 minutes (shown instantly on return)
  });
}
