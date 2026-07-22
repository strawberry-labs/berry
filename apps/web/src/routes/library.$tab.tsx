import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/library/$tab")({ component: EmptyRoute });

function EmptyRoute() { return null; }
