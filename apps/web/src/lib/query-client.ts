import { QueryClient } from "@tanstack/react-query";

/** Shared client for management data: short freshness, bounded retries, and
 * no focus storms while an operator is editing a form. */
export const webQueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: 2,
      retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 5_000),
    },
  },
});
