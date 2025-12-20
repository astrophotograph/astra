/**
 * React Query hooks for schedule operations
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  scheduleApi,
  type ObservationSchedule,
  type CreateScheduleInput,
  type UpdateScheduleInput,
  type ScheduleItem,
} from "@/lib/tauri/commands";

export const scheduleKeys = {
  all: ["schedules"] as const,
  lists: () => [...scheduleKeys.all, "list"] as const,
  active: () => [...scheduleKeys.all, "active"] as const,
  details: () => [...scheduleKeys.all, "detail"] as const,
  detail: (id: string) => [...scheduleKeys.details(), id] as const,
};

export function useSchedules() {
  return useQuery({
    queryKey: scheduleKeys.lists(),
    queryFn: () => scheduleApi.getAll(),
  });
}

export function useActiveSchedule() {
  return useQuery({
    queryKey: scheduleKeys.active(),
    queryFn: () => scheduleApi.getActive(),
  });
}

export function useSchedule(id: string) {
  return useQuery({
    queryKey: scheduleKeys.detail(id),
    queryFn: () => scheduleApi.getById(id),
    enabled: !!id,
  });
}

export function useCreateSchedule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateScheduleInput) => scheduleApi.create(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: scheduleKeys.lists() });
      queryClient.invalidateQueries({ queryKey: scheduleKeys.active() });
    },
  });
}

export function useUpdateSchedule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: UpdateScheduleInput) => scheduleApi.update(input),
    onSuccess: (data: ObservationSchedule) => {
      queryClient.invalidateQueries({ queryKey: scheduleKeys.lists() });
      queryClient.invalidateQueries({ queryKey: scheduleKeys.active() });
      queryClient.setQueryData(scheduleKeys.detail(data.id), data);
    },
  });
}

export function useDeleteSchedule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => scheduleApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: scheduleKeys.lists() });
      queryClient.invalidateQueries({ queryKey: scheduleKeys.active() });
    },
  });
}

export function useAddScheduleItem() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ scheduleId, item }: { scheduleId: string; item: ScheduleItem }) =>
      scheduleApi.addItem(scheduleId, item),
    onSuccess: (data: ObservationSchedule) => {
      queryClient.invalidateQueries({ queryKey: scheduleKeys.lists() });
      queryClient.invalidateQueries({ queryKey: scheduleKeys.active() });
      queryClient.setQueryData(scheduleKeys.detail(data.id), data);
    },
  });
}

export function useRemoveScheduleItem() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ scheduleId, itemId }: { scheduleId: string; itemId: string }) =>
      scheduleApi.removeItem(scheduleId, itemId),
    onSuccess: (data: ObservationSchedule) => {
      queryClient.invalidateQueries({ queryKey: scheduleKeys.lists() });
      queryClient.invalidateQueries({ queryKey: scheduleKeys.active() });
      queryClient.setQueryData(scheduleKeys.detail(data.id), data);
    },
  });
}
