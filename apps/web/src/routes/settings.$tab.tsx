import * as React from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { PersonalSettingsScreen } from "@/components/management/personal-settings-screen";
import { useManagementRouteContext } from "@/components/management/management-route-context";

export const Route = createFileRoute("/settings/$tab")({
  // Search state is partial while the route is mounted; the screen applies
  // the shared defaulting/legacy-kind normalization when it reads it.
  validateSearch: z.object({
    q: z.string().optional(),
    workspace: z.string().optional(),
    state: z.enum(["archived", "deleted", "all"]).optional(),
  }).passthrough(),
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
