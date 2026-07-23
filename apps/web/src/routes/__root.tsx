import type { ReactNode } from "react";
import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { AppShell, loadFixtureShellData } from "@/components/app-shell";
import { loadWebBootstrap } from "@/lib/config.functions";
import { BERRY_THEME_BOOTSTRAP_SCRIPT } from "@/lib/theme";
import appCss from "../styles.css?url";

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
  return (
    <RootDocument>
      <AppShell initial={initial} />
    </RootDocument>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: BERRY_THEME_BOOTSTRAP_SCRIPT }} />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
