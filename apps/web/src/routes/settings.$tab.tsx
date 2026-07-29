import { createFileRoute } from "@tanstack/react-router";
import { ArchivedChatsSearchSchema } from "@berry/shared";
import { PersonalSettingsScreen } from "@/components/management/personal-settings-screen";
import { useManagementRouteContext } from "@/components/management/management-route-context";

export const Route = createFileRoute("/settings/$tab")({
  validateSearch: ArchivedChatsSearchSchema.partial().passthrough(),
  component: PersonalSettingsRoute,
});

function PersonalSettingsRoute() {
  const { tab } = Route.useParams();
  const context = useManagementRouteContext();
  return <PersonalSettingsScreen tab={tab} {...context} />;
}
