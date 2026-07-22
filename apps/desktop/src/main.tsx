import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";

import "@fontsource/source-serif-4/400.css";
import "@fontsource/source-serif-4/500.css";
import "@fontsource/source-serif-4/600.css";
import "@fontsource/source-serif-4/700.css";
import "./globals.css";

import { TooltipProvider } from "@berry/desktop-ui/components/ui/tooltip";
import { Toaster } from "@berry/desktop-ui/components/ui/sonner";
import { DesktopApp } from "./app";
import { host } from "./lib/berry";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing #root element");

installRendererCrashReporter();

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={300}>
          <DesktopApp />
          <Toaster position="bottom-right" />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </React.StrictMode>,
);

function installRendererCrashReporter() {
  const seen = new Set<string>();
  const record = (input: { name?: string; message: string; stack?: string; fatal?: boolean; metadata?: Record<string, string | number | boolean | null> }) => {
    const fingerprint = `${input.name ?? "Error"}:${input.message}:${input.stack?.slice(0, 240) ?? ""}`;
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);
    if (seen.size > 25) seen.clear();
    void host.call("support.crashReport.record", {
      ...input,
      route: window.location.pathname || "desktop",
    }).catch(() => {
      // Crash reporting is best-effort and must never create a second renderer error.
    });
  };
  window.addEventListener("error", (event) => {
    record({
      name: event.error instanceof Error ? event.error.name : "Error",
      message: event.error instanceof Error ? event.error.message : event.message || "Unhandled renderer error",
      stack: event.error instanceof Error ? event.error.stack : undefined,
      fatal: false,
      metadata: { filename: event.filename || null, lineno: event.lineno, colno: event.colno },
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    record({
      name: reason instanceof Error ? reason.name : "UnhandledRejection",
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
      fatal: false,
    });
  });
}
