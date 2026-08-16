import * as React from "react";
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
  return (
    <RootDocument>
      {content}
    </RootDocument>
  );
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
