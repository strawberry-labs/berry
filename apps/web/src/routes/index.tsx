import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: EmptyRoute,
});

function EmptyRoute() { return null; }
