import { createFileRoute } from "@tanstack/react-router";
import { AdminAnalyticsSearchSchema } from "@berry/shared";
import { ManagementExperience } from "@/components/management/management-experience";
import { useManagementRouteContext } from "@/components/management/management-route-context";

export const Route = createFileRoute("/admin/$tab")({
  validateSearch: AdminAnalyticsSearchSchema,
  component: OrganizationAdminRoute,
});

function OrganizationAdminRoute() {
  const { tab } = Route.useParams();
  const context = useManagementRouteContext();
  return <ManagementExperience kind="admin" tab={tab} {...context} />;
}
