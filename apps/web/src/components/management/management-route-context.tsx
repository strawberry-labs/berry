import * as React from "react";
import type { ManagementScreenProps } from "./management-context";

const ManagementRouteContext = React.createContext<ManagementScreenProps | null>(null);

export function ManagementRouteProvider({ value, children }: { value: ManagementScreenProps; children: React.ReactNode }) {
  return <ManagementRouteContext.Provider value={value}>{children}</ManagementRouteContext.Provider>;
}

export function useManagementRouteContext() {
  const value = React.useContext(ManagementRouteContext);
  if (!value) throw new Error("Management routes must render inside ManagementRouteProvider");
  return value;
}
