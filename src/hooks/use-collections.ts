/**
 * React Query hooks for collection operations
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  collectionApi,
  type Collection,
  type CreateCollectionInput,
  type UpdateCollectionInput,
} from "@/lib/tauri/commands";

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
