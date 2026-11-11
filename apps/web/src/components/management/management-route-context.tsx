import * as React from "react";
import { ManagementResourceScope, type ManagementScreenProps } from "./management-context";

const ManagementRouteContext = React.createContext<ManagementScreenProps | null>(null);

export function ManagementRouteProvider({ value, children }: { value: ManagementScreenProps; children: React.ReactNode }) {
  const scope = `${value.tenantId}:${value.userId ?? "anonymous"}:${value.supportView ? "support" : "self"}`;
  return <ManagementResourceScope.Provider value={scope}><ManagementRouteContext.Provider value={value}>{children}</ManagementRouteContext.Provider></ManagementResourceScope.Provider>;
}

export function useManagementRouteContext() {
  const value = React.useContext(ManagementRouteContext);
  if (!value) throw new Error("Management routes must render inside ManagementRouteProvider");
  return value;
}
