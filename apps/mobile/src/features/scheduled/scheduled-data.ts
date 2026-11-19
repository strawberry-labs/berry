import * as React from "react";
import * as Crypto from "expo-crypto";
import { useIsFocused } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ScheduledTask, ScheduledTaskCreate, ScheduledTaskUpdate } from "@berry/shared";
import { useSignedInSession } from "../../session/session";

const SCHEDULE_REFRESH_MS = 10_000;
const RUNS_REFRESH_MS = 5_000;
const RUN_HISTORY_LIMIT = 30;

export const scheduleKeys = {
  all: (server: string) => ["scheduled-tasks", server] as const,
  list: (server: string) => ["scheduled-tasks", server, "list"] as const,
  runs: (server: string, id: string) => ["scheduled-tasks", server, "runs", id] as const,
};

/** The web polls schedules every 10 s; the phone does too, but only while the screen is in front. */
export function useScheduledTasks() {
  const { client, profile } = useSignedInSession();
  const focused = useIsFocused();
  return useQuery({
    queryKey: scheduleKeys.list(profile.serverUrl),
    queryFn: ({ signal }) => client.listScheduledTasks({ signal }),
    refetchInterval: focused ? SCHEDULE_REFRESH_MS : false,
  });
}

export function useScheduledTaskRuns(task: ScheduledTask | null) {
  const { client, profile } = useSignedInSession();
  return useQuery({
    queryKey: scheduleKeys.runs(profile.serverUrl, task?.id ?? "none"),
    queryFn: ({ signal }) => client.listScheduledTaskRuns(task!.id, RUN_HISTORY_LIMIT, { signal }),
    enabled: Boolean(task),
    refetchInterval: task ? RUNS_REFRESH_MS : false,
  });
}

export function newOperationId(): string {
  return Crypto.randomUUID();
}

export type ScheduleAction =
  | { kind: "create"; input: ScheduledTaskCreate }
  | { kind: "update"; task: ScheduledTask; changes: ScheduledTaskUpdate; operationId: string }
  | { kind: "toggle"; task: ScheduledTask }
  | { kind: "run"; task: ScheduledTask }
  | { kind: "delete"; task: ScheduledTask };

/**
 * Every schedule mutation from the web screen. Manual runs reuse one
 * idempotency key per schedule until they succeed, so a retried tap after a
 * timeout can't queue the same run twice.
 */
export function useScheduleActions() {
  const { client, profile } = useSignedInSession();
  const queryClient = useQueryClient();
  const listKey = scheduleKeys.list(profile.serverUrl);
  const manualKeys = React.useRef(new Map<string, string>());
  return useMutation({
    mutationFn: async (action: ScheduleAction): Promise<unknown> => {
      switch (action.kind) {
        case "create": return client.createScheduledTask(action.input);
        case "update": return client.updateScheduledTask(action.task.id, action.changes, action.operationId);
        case "toggle": return client.updateScheduledTask(action.task.id, { state: action.task.state === "active" ? "paused" : "active" }, newOperationId());
        case "delete": return client.deleteScheduledTask(action.task.id);
        case "run": {
          const key = manualKeys.current.get(action.task.id) ?? newOperationId();
          manualKeys.current.set(action.task.id, key);
          const run = await client.runScheduledTask(action.task.id, key);
          manualKeys.current.delete(action.task.id);
          return run;
        }
      }
    },
    onMutate: async (action) => {
      if (action.kind !== "toggle" && action.kind !== "delete") return;
      await queryClient.cancelQueries({ queryKey: listKey });
      queryClient.setQueryData<ScheduledTask[]>(listKey, (tasks) => action.kind === "delete"
        ? tasks?.filter((task) => task.id !== action.task.id)
        : tasks?.map((task) => task.id === action.task.id ? { ...task, state: task.state === "active" ? "paused" : "active" } : task));
    },
    onSettled: (_data, _error, action) => {
      void queryClient.invalidateQueries({ queryKey: listKey });
      if (action.kind === "run") void queryClient.invalidateQueries({ queryKey: scheduleKeys.runs(profile.serverUrl, action.task.id) });
    },
  });
}
