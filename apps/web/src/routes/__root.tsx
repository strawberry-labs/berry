import * as React from "react";
import { isChunkLoadError, recoverChunkLoadError } from "@/lib/chunk-load-recovery";
import type { ErrorComponentProps } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { createRootRoute, HeadContent, Scripts, useRouter } from "@tanstack/react-router";
import { AuthBoundary } from "@/components/shell/auth-boundary";
import { loadWebBootstrap } from "@/lib/config.functions";
import { loadFixtureShellData } from "@/lib/shell-data";
import { BERRY_THEME_BOOTSTRAP_SCRIPT } from "@/lib/theme";
import { QueryClientProvider } from "@tanstack/react-query";
import { createWebQueryClient } from "@/lib/query-client";
import appCss from "../styles.css?url";

const AppShell = React.lazy(() => import("@/components/app-shell").then((module) => ({ default: module.AppShell })));

export const Route = createRootRoute({
  loader: async () => {
    const bootstrap = await loadWebBootstrap();
    return loadFixtureShellData(bootstrap.config, bootstrap.user, bootstrap.sessionResolved);
  },
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Berry" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/berry-logo.svg", type: "image/svg+xml" },
    ],
  }),
  component: RootComponent,
  shellComponent: RootDocument,
  errorComponent: RootError,
});

function RootComponent() {
  const initial = Route.useLoaderData();
  const fallback = <div className="auth-shell" role="status" aria-live="polite" aria-busy="true">Loading Berry…</div>;
  const content = initial.config.demoMode ? (
    <WebQueryBoundary>
      <React.Suspense fallback={fallback}>
        <AppShell initial={initial} user={null} />
      </React.Suspense>
    </WebQueryBoundary>
  ) : (
    <AuthBoundary
      baseUrl={initial.config.apiBaseUrl ?? ""}
      initialUser={initial.user}
      sessionResolved={initial.sessionResolved}
    >
      {(user, onSignedOut) => (
        <WebQueryBoundary key={user.id}>
          <React.Suspense fallback={fallback}>
            <AppShell initial={initial} user={user} onSignedOut={onSignedOut} />
          </React.Suspense>
        </WebQueryBoundary>
      )}
    </AuthBoundary>
  );
  return content;
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  const router = useRouter();
  const nonce = router.options.ssr?.nonce;
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <script suppressHydrationWarning nonce={nonce} dangerouslySetInnerHTML={{ __html: BERRY_THEME_BOOTSTRAP_SCRIPT }} />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function WebQueryBoundary({ children }: Readonly<{ children: ReactNode }>) {
  const [client] = React.useState(createWebQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function RootError({ error, reset }: ErrorComponentProps) {
  const chunkError = isChunkLoadError(error);
  const [reloading, setReloading] = React.useState(false);
  React.useEffect(() => {
    setReloading(recoverChunkLoadError(error));
  }, [error]);
  return (
    <main className="auth-shell">
      <section className="max-w-md space-y-3 p-6 text-sm" role="alert">
        <h1 className="text-lg font-semibold">{reloading ? "Updating Berry…" : chunkError ? "Berry needs a refresh" : "Something went wrong"}</h1>
        <p className="text-[var(--berry-text-secondary)]">
          {reloading ? "Loading the latest version. Your task will reopen here."
            : chunkError ? "A part of the app could not load. This can happen after an update or a connection interruption. Check your connection, then refresh."
            : "Please try again. If the problem continues, refresh the page."}
        </p>
        {!reloading && (
          <div className="flex gap-2">
            {!chunkError && <button type="button" className="rounded-md border border-[var(--berry-border)] px-3 py-2 focus-visible:outline" onClick={reset}>Try again</button>}
            <button type="button" className="rounded-md border border-[var(--berry-border)] px-3 py-2 focus-visible:outline" onClick={() => window.location.reload()}>Refresh page</button>
          </div>
        )}
      </section>
    </main>
  );
}
