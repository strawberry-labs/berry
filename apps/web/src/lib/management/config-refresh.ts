export function settledValue<T>(result: PromiseSettledResult<unknown>, fallback: T): T {
  return result.status === "fulfilled" ? result.value as T : fallback;
}

export function replaceTenantValue<T extends { tenantId: string }>(current: T[], tenantId: string, next: T | null): T[] {
  return next ? [...current.filter((entry) => entry.tenantId !== tenantId), next] : current;
}
