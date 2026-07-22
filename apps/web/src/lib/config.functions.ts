import { createServerFn } from "@tanstack/react-start";
import { getWebConfig } from "./env.server";

export const loadWebConfig = createServerFn({ method: "GET" }).handler(() => getWebConfig());
