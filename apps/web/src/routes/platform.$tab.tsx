import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ManagementExperience } from "@/components/management/management-experience";
import { useManagementRouteContext } from "@/components/management/management-route-context";
import { PermissionDenied } from "@/components/management/management-primitives";

export const Route = createFileRoute("/platform/$tab")({
  validateSearch: z.object({ tenantId: z.string().optional(), status: z.string().optional(), cursor: z.string().optional() }).strict(),
  component: PlatformOperationsRoute,
});

function PlatformOperationsRoute() {
  const { tab } = Route.useParams();
  const context = useManagementRouteContext();
  if (!context.config.platformAuthorized) return <PermissionDenied label="platform operations" />;
  return <ManagementExperience kind="platform" tab={tab} {...context} />;
}
