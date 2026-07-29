import { createFileRoute } from "@tanstack/react-router";
import { AdminAnalyticsSearchSchema } from "@berry/shared";
import { AdminScreen } from "@/components/management/admin-screens";
import { useManagementRouteContext } from "@/components/management/management-route-context";

export const Route = createFileRoute("/admin/$tab")({
  validateSearch: AdminAnalyticsSearchSchema,
  component: OrganizationAdminRoute,
});

function OrganizationAdminRoute() {
  const { tab } = Route.useParams();
  const context = useManagementRouteContext();
  return <AdminScreen tab={tab} {...context} />;
}
