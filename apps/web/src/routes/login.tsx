import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

export const Route = createFileRoute("/login")({
  validateSearch: z.object({
    error: z.string().max(120).optional(),
    error_description: z.string().max(500).optional(),
  }).passthrough(),
  component: EmptyRoute,
});

function EmptyRoute() { return null; }
