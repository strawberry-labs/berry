/** Stable query-key factories shared by management resources and paginated views. */
export const managementQueryKeys = {
  all: ["management"] as const,
  resource: (key: string) => ["management", key] as const,
  archive: (filters: { q?: string | undefined; workspace: string; state: "archived" | "deleted" | "all" }) => ["management", "tasks", "archive", filters] as const,
} as const;
