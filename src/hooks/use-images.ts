/**
 * React Query hooks for image operations
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  imageApi,
  type Image,
  type CreateImageInput,
  type UpdateImageInput,
} from "@/lib/tauri/commands";

/** Library visibility: hidden images stay out of every browsing surface
 *  (collections, slideshows, sky map) except the Images screen's explicit
 *  "Show hidden" toggle. */
export function isVisibleImage(image: Image): boolean {
  return !image.hidden;
}

const selectVisible = (images: Image[]) => images.filter(isVisibleImage);

export const imageKeys = {
  all: ["images"] as const,
  lists: () => [...imageKeys.all, "list"] as const,
  byCollection: (collectionId: string) =>
    [...imageKeys.lists(), { collectionId }] as const,
  details: () => [...imageKeys.all, "detail"] as const,
  detail: (id: string) => [...imageKeys.details(), id] as const,
};

export function useImages() {
  return useQuery({
    queryKey: imageKeys.lists(),
    queryFn: () => imageApi.getAll(),
  });
}

export function useCollectionImages(collectionId: string) {
  return useQuery({
    queryKey: imageKeys.byCollection(collectionId),
    queryFn: () => imageApi.getByCollection(collectionId),
    select: selectVisible,
    enabled: !!collectionId,
  });
}

export function useImage(id: string) {
  return useQuery({
    queryKey: imageKeys.detail(id),
    queryFn: () => imageApi.getById(id),
    enabled: !!id,
  });
}

export function useCreateImage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateImageInput) => imageApi.create(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: imageKeys.lists() });
    },
  });
}

export function useUpdateImage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: UpdateImageInput) => imageApi.update(input),
    onSuccess: (data: Image) => {
      queryClient.invalidateQueries({ queryKey: imageKeys.lists() });
      queryClient.setQueryData(imageKeys.detail(data.id), data);
    },
  });
}

export function useDeleteImage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => imageApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: imageKeys.lists() });
    },
  });
}
