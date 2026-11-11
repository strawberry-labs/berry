import * as React from "react";
import type { ManagementScreenProps } from "./management-context";
import { ManagementScreenFallback } from "./management-screen-skeletons";

const PlatformRolloutScreen = React.lazy(async () => ({
  default: (await import("./platform-rollout-screen")).PlatformRolloutScreen,
}));
const PlatformOverviewScreen = React.lazy(async () => ({
  default: (await import("./platform-overview-screen")).PlatformOverviewScreen,
}));
const PlatformOrganizationsScreen = React.lazy(async () => ({
  default: (await import("./platform-organizations-screen")).PlatformOrganizationsScreen,
}));
const PlatformRouterHealthScreen = React.lazy(async () => ({
  default: (await import("./platform-router-health-screen")).PlatformRouterHealthScreen,
}));
const PlatformBillingOperationsScreen = React.lazy(async () => ({
  default: (await import("./platform-billing-operations-screen")).PlatformBillingOperationsScreen,
}));

const PLATFORM_TABS = new Set(["overview", "organizations", "feature-rollout", "router-health", "billing-operations"]);

export function PlatformScreen({
  tab,
  ...props
}: ManagementScreenProps & { tab: string }) {
  let screen: React.ReactNode;
  if (tab === "overview") screen = <PlatformOverviewScreen {...props} />;
  else if (tab === "organizations") screen = <PlatformOrganizationsScreen {...props} />;
  else if (tab === "feature-rollout") screen = <PlatformRolloutScreen {...props} />;
  else if (tab === "router-health") screen = <PlatformRouterHealthScreen {...props} />;
  else if (tab === "billing-operations") screen = <PlatformBillingOperationsScreen {...props} />;
  else screen = <PlatformBillingOperationsScreen {...props} />;
  return <React.Suspense fallback={<ManagementScreenFallback area="platform" tab={PLATFORM_TABS.has(tab) ? tab : "billing-operations"} />}>{screen}</React.Suspense>;
}
