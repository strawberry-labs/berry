import { createFileRoute } from "@tanstack/react-router";
import { ArchivedChatsSearchSchema } from "@berry/shared";
import { ManagementExperience } from "@/components/management/management-experience";
import { useManagementRouteContext } from "@/components/management/management-route-context";

export const Route = createFileRoute("/settings/$tab")({
  validateSearch: ArchivedChatsSearchSchema.partial().passthrough(),
  component: PersonalSettingsRoute,
});

function PersonalSettingsRoute() {
  const { tab } = Route.useParams();
  const context = useManagementRouteContext();
  return <ManagementExperience kind="settings" tab={tab} {...context} />;
}
