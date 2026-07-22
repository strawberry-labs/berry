import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from "react";
import { ScrollArea } from "@berry/desktop-ui/components/ui/scroll-area";
import { Skeleton } from "@berry/desktop-ui/components/ui/skeleton";
import type { SettingsPage } from "@/lib/berry";

type SettingsComponent = ComponentType | LazyExoticComponent<ComponentType>;

const GeneralSettings = lazy(() => import("./general").then((module) => ({ default: module.GeneralSettings })));

const PAGES: Record<SettingsPage, SettingsComponent> = {
  general: GeneralSettings,
  "code-preview": lazy(() => import("./code-preview").then((module) => ({ default: module.CodePreviewSettings }))),
  models: lazy(() => import("./models").then((module) => ({ default: module.ModelSettings }))),
  skills: lazy(() => import("./skills").then((module) => ({ default: module.SkillsSettings }))),
  subagents: lazy(() => import("./subagents").then((module) => ({ default: module.SubagentsSettings }))),
  mcp: lazy(() => import("./mcp").then((module) => ({ default: module.McpSettings }))),
  commands: lazy(() => import("./commands").then((module) => ({ default: module.CommandsSettings }))),
  plugins: lazy(() => import("./plugins").then((module) => ({ default: module.PluginsSettings }))),
  security: lazy(() => import("./security").then((module) => ({ default: module.SecuritySettings }))),
  indexing: lazy(() => import("./indexing").then((module) => ({ default: module.IndexingSettings }))),
  usage: lazy(() => import("./usage").then((module) => ({ default: module.UsageSettings }))),
};

export function SettingsView({ page }: { page: SettingsPage }) {
  const Page = PAGES[page] ?? GeneralSettings;

  return (
    <div className="h-full min-h-0 bg-background">
      <ScrollArea className="scroll-fade h-full">
        {/* Left-aligned, full-width settings content: pages own their internal
            layout and use the whole panel, with breathing room on both sides. */}
        <div className="w-full px-8 py-8">
          <Suspense fallback={<SettingsPageSkeleton />}>
            <Page />
          </Suspense>
        </div>
      </ScrollArea>
    </div>
  );
}

function SettingsPageSkeleton() {
  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-44" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Skeleton className="h-24 rounded-lg" />
        <Skeleton className="h-24 rounded-lg" />
        <Skeleton className="h-24 rounded-lg" />
      </div>
      <Skeleton className="h-64 rounded-lg" />
    </div>
  );
}
