import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { BerryApiClient } from "@berry/api-client";

export const modelCatalogQueryKey = ["model-catalog"] as const;

export function useModelCatalog(
  client: Pick<BerryApiClient, "modelCatalog"> | null,
  scope: readonly unknown[],
  enabled: boolean,
) {
  return useQuery({
    queryKey: [...modelCatalogQueryKey, ...scope],
    enabled: Boolean(client) && enabled,
    queryFn: async ({ signal }) => {
      const catalog = await client!.modelCatalog();
      signal.throwIfAborted();
      return catalog;
    },
    // Pick up changes made in another tab when returning to the composer.
    refetchOnWindowFocus: "always",
  });
}

export async function invalidateModelCatalog(client: QueryClient) {
  // An import can complete while the initial catalog is still in flight.
  // Discard that older response before requesting the updated catalog.
  await client.cancelQueries({ queryKey: modelCatalogQueryKey });
  await client.invalidateQueries({ queryKey: modelCatalogQueryKey });
}

export function useRefreshModelCatalog() {
  const client = useQueryClient();
  return () => { void invalidateModelCatalog(client); };
}
