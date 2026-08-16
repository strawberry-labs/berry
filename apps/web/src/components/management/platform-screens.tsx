import * as React from "react";
import type { ManagementScreenProps } from "./management-context";

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

function PlatformScreenFallback() {
  return (
    <div
      className="flex min-h-24 items-center justify-center text-sm text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      Loading platform section…
    </div>
  );
}

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
  return <React.Suspense fallback={<PlatformScreenFallback />}>{screen}</React.Suspense>;
}
