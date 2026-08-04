import * as React from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
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
  const navigate = useNavigate();
  const legacyTarget = tab === "prompts" || tab === "memory"
    ? "personalization"
    : tab === "privacy"
      ? "account"
      : tab === "providers"
        ? "general"
        : null;
  React.useEffect(() => {
    if (!legacyTarget) return;
    void navigate({ to: "/settings/$tab", params: { tab: legacyTarget }, replace: true });
  }, [legacyTarget, navigate]);
  if (legacyTarget) return null;
  return <PersonalSettingsScreen tab={tab} {...context} />;
}
