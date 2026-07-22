import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/tasks/$taskId")({ component: EmptyRoute });

function EmptyRoute() { return null; }
