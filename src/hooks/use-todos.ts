/**
 * React Query hooks for todo operations
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  todoApi,
  type AstronomyTodo,
  type CreateTodoInput,
  type UpdateTodoInput,
} from "@/lib/tauri/commands";

export const todoKeys = {
  all: ["todos"] as const,
  lists: () => [...todoKeys.all, "list"] as const,
  list: (filters: string) => [...todoKeys.lists(), { filters }] as const,
  details: () => [...todoKeys.all, "detail"] as const,
  detail: (id: string) => [...todoKeys.details(), id] as const,
};

export function useTodos() {
  return useQuery({
    queryKey: todoKeys.lists(),
    queryFn: () => todoApi.getAll(),
  });
}

export function useTodo(id: string) {
  return useQuery({
    queryKey: todoKeys.detail(id),
    queryFn: () => todoApi.getById(id),
    enabled: !!id,
  });
}

export function useCreateTodo() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateTodoInput) => todoApi.create(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: todoKeys.lists() });
    },
  });
}

export function useUpdateTodo() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: UpdateTodoInput) => todoApi.update(input),
    onSuccess: (data: AstronomyTodo) => {
      queryClient.invalidateQueries({ queryKey: todoKeys.lists() });
      queryClient.setQueryData(todoKeys.detail(data.id), data);
    },
  });
}

export function useDeleteTodo() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => todoApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: todoKeys.lists() });
    },
  });
}

export function useSyncTodos() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => todoApi.sync(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: todoKeys.lists() });
    },
  });
}
