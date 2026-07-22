import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { HostPushEvent, ModelProvider, RemoteModel } from "@berry/shared";
import { Check, ChevronDown, CirclePlus, FileDown, Loader2Icon, Settings, Square, X } from "@berry/desktop-ui/lib/icons";

import { Button } from "@berry/desktop-ui/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@berry/desktop-ui/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@berry/desktop-ui/components/ui/popover";
import { Input } from "@berry/desktop-ui/components/ui/input";
import { cn } from "@berry/desktop-ui/lib/utils";

import { findProviderLogo } from "@/components/settings/provider-logos";
import { host } from "@/lib/berry";
import {
  describeModelsDevModel,
  loadModelsDevLogo,
  modelsDevLogoCandidates,
  modelsDevProviderId,
  useModelsDevCatalog,
} from "@/lib/models-dev";

export interface ModelSelection {
  providerId: string;
  model: string;
}

type LocalModelProgress = Extract<HostPushEvent, { type: "model.local.progress" }>;

interface PullPanelState {
  providerId: string;
  model: string;
  action: "pull" | "download";
  operationId?: string;
  starting: boolean;
  progress?: LocalModelProgress;
}

/** Models offered per provider: default first, then cached fetched models. */
function providerModels(provider: ModelProvider): string[] {
  const ids = [provider.defaultModel, ...(provider.models ?? []).map((model) => model.id)];
  return [...new Set(ids.filter((id) => id.length > 0))];
}

function middleTruncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const keep = Math.max(4, Math.floor((maxLength - 3) / 2));
  return `${value.slice(0, keep)}...${value.slice(-keep)}`;
}

function compactContext(value: number): string {
  return value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);
}

function modelBadges(model: RemoteModel | undefined): string[] {
  if (!model) return [];
  return [
    ...(model.loaded ? ["Loaded"] : []),
    ...(model.quantization ? [model.quantization] : []),
    ...(model.contextWindow ? [`${compactContext(model.contextWindow)} ctx`] : []),
  ];
}

function modelEngine(model: RemoteModel | undefined): string | null {
  const raw = model?.raw;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return typeof raw.engine === "string" ? raw.engine : null;
}

/** Deterministic soft hue for the letter monogram fallback (cf. ProviderLogo). */
function hueFor(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  return hash % 360;
}

/**
 * Row glyph: the models.dev mark for the model's author (falling back to the
 * serving provider's mark), else the bundled brand SVG, else a monogram.
 * models.dev marks are currentColor; a `text-` class is injected on the <svg>
 * so CommandItem's `svg:not([class*='text-'])` rule doesn't dim it to muted.
 */
function ModelGlyph({ candidates, hints, name }: { candidates: string[]; hints: string[]; name: string }) {
  const cacheKey = candidates.join("|");
  const [resolved, setResolved] = React.useState<{ key: string; svg: string | null } | null>(null);
  React.useEffect(() => {
    let alive = true;
    void loadModelsDevLogo(candidates).then((svg) => {
      if (alive) setResolved({ key: cacheKey, svg });
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey]);

  const haystack = hints.filter(Boolean).join(" ");
  const svg = resolved?.key === cacheKey ? resolved.svg : null;
  const settled = resolved?.key === cacheKey;
  const inline = svg ?? (settled ? findProviderLogo(...hints) : null);

  if (inline) {
    return (
      <span
        aria-hidden
        className="flex size-5 shrink-0 items-center justify-center [&_svg]:size-4"
        dangerouslySetInnerHTML={{ __html: inline.replace(/<svg\s/, '<svg class="text-foreground" ') }}
      />
    );
  }
  if (settled && /berry/i.test(haystack)) {
    return (
      <span aria-hidden className="flex size-5 shrink-0 items-center justify-center">
        <img src="/berry-logo.svg" alt="" draggable={false} className="size-4 object-contain" />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className="flex size-5 shrink-0 items-center justify-center rounded-md text-[10px] font-semibold uppercase"
      style={
        settled
          ? {
              backgroundColor: `oklch(0.32 0.055 ${hueFor(name)})`,
              color: `oklch(0.87 0.06 ${hueFor(name)})`,
            }
          : undefined
      }
    >
      {settled ? name.trim().charAt(0) : null}
    </span>
  );
}

/**
 * Compact command-menu style model picker: a floating panel above the trigger
 * with a search field + settings shortcut, and provider-grouped model rows
 * (author mark, model id, check on the active row). Everything derives from
 * the theme tokens; model metadata/logos come from models.dev.
 */
export function ModelSelector({
  providers,
  active,
  onPick,
  onOpenSettings,
}: {
  providers: ModelProvider[];
  active: ModelSelection | null;
  onPick: (selection: ModelSelection) => void;
  onOpenSettings: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [pull, setPull] = React.useState<PullPanelState | null>(null);
  const [busyModel, setBusyModel] = React.useState<string | null>(null);
  const queryClient = useQueryClient();
  const catalog = useModelsDevCatalog().data ?? null;

  React.useEffect(
    () =>
      host.subscribe((event) => {
        if (event.type !== "model.local.progress") return;
        setPull((current) => {
          if (!current || current.providerId !== event.providerId || current.model !== event.model || current.action !== event.action) return current;
          if (current.operationId && current.operationId !== event.operationId) return current;
          return { ...current, operationId: event.operationId, starting: false, progress: event };
        });
        if (event.done && !event.cancelled && !event.error) {
          void queryClient.invalidateQueries({ queryKey: ["model-providers"] });
          void queryClient.invalidateQueries({ queryKey: ["model.provider.list"] });
        }
      }),
    [queryClient],
  );

  const startPull = async () => {
    if (!pull || pull.starting || pull.operationId || !pull.model.trim()) return;
    const model = pull.model.trim();
    setPull({ ...pull, model, starting: true, progress: undefined });
    try {
      const provider = providers.find((candidate) => candidate.id === pull.providerId);
      const credentials = provider?.credentialRef ? { credentialRef: provider.credentialRef } : {};
      const result = pull.action === "pull"
        ? await host.call("model.local.pull", { providerId: pull.providerId, model, ...credentials })
        : await host.call("model.local.download", { providerId: pull.providerId, model, ...credentials });
      setPull((current) =>
        current?.providerId === pull.providerId && current.model === model
          ? { ...current, operationId: result.operationId, starting: false }
          : current,
      );
    } catch (error) {
      setPull((current) =>
        current?.providerId === pull.providerId
          ? {
              ...current,
              starting: false,
              progress: {
                type: "model.local.progress",
                operationId: "failed",
                providerId: pull.providerId,
                model,
                action: pull.action,
                status: "failed",
                done: true,
                error: error instanceof Error ? error.message : "Pull failed",
              },
            }
          : current,
      );
    }
  };

  const cancelPull = async () => {
    if (!pull?.operationId) return;
    await host.call("model.local.cancel", { operationId: pull.operationId });
  };

  const toggleLmStudioModel = async (provider: ModelProvider, model: RemoteModel) => {
    const key = `${provider.id}:${model.id}`;
    if (busyModel) return;
    setBusyModel(key);
    const credentials = provider.credentialRef ? { credentialRef: provider.credentialRef } : {};
    try {
      const instanceId = model.loadedInstanceIds?.[0];
      if (model.loaded && instanceId) {
        await host.call("model.local.unload", { providerId: provider.id, instanceId, ...credentials });
      } else {
        await host.call("model.local.load", {
          providerId: provider.id,
          model: model.id,
          ...credentials,
        });
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["model-providers"] }),
        queryClient.invalidateQueries({ queryKey: ["model.provider.list"] }),
      ]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "LM Studio model action failed");
    } finally {
      setBusyModel(null);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="berry-pill-control min-w-0 max-w-[min(42vw,240px)] shrink gap-1.5 text-muted-foreground"
          title={active?.model ?? "No model"}
        >
          <span className="berry-composer-model-label min-w-0 truncate">{middleTruncate(active?.model ?? "No model", 36)}</span>
          <ChevronDown />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={12}
        className="w-80 overflow-hidden rounded-2xl p-0 shadow-[var(--berry-shadow-floating)]"
      >
        <Command loop>
          <div className="flex items-center gap-2 px-2.5 pt-2.5 pb-1">
            <CommandInput
              autoFocus
              placeholder="Search models..."
              wrapperClassName="h-9 min-w-0 flex-1 rounded-[10px] border border-border bg-[var(--berry-surface-inset)] px-2.5"
              className="h-9 text-[13px]"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              aria-label="Manage models"
              title="Manage models"
              onClick={() => {
                setOpen(false);
                onOpenSettings();
              }}
              className="size-9 shrink-0 rounded-[10px] border border-border bg-[var(--berry-surface-inset)] text-muted-foreground transition-[background-color,color] hover:bg-[var(--berry-hover)] hover:text-foreground"
            >
              <Settings />
            </Button>
          </div>
          {pull ? (
            <div className="mx-2.5 mb-1 flex flex-col gap-2 border-y border-border/70 py-2.5" data-testid="ollama-pull-panel">
              <div className="flex items-center gap-2">
                <Input
                  aria-label={pull.action === "pull" ? "Ollama model name" : "LM Studio model name"}
                  autoFocus
                  value={pull.model}
                  disabled={pull.starting || Boolean(pull.operationId && !pull.progress?.done)}
                  placeholder={pull.action === "pull" ? "Model name" : "Catalog ID or Hugging Face URL"}
                  className="h-8 min-w-0 flex-1 font-mono text-xs"
                  onChange={(event) => setPull({ ...pull, model: event.target.value, progress: undefined, operationId: undefined })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void startPull();
                    }
                  }}
                />
                {pull.operationId && !pull.progress?.done ? (
                  <Button type="button" size="icon-sm" variant="outline" aria-label="Cancel model pull" title="Cancel" onClick={() => void cancelPull()}>
                    <Square />
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="outline"
                    aria-label={pull.action === "pull" ? "Pull model" : "Download model"}
                    title={pull.action === "pull" ? "Pull model" : "Download model"}
                    disabled={!pull.model.trim() || pull.starting}
                    onClick={() => void startPull()}
                  >
                    {pull.starting ? <Loader2Icon className="animate-spin" /> : <FileDown />}
                  </Button>
                )}
              </div>
              {pull.progress ? (
                <div className="flex flex-col gap-1" aria-live="polite">
                  <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                    <span className={cn("truncate", pull.progress.error && "text-destructive")}>
                      {pull.progress.error ?? pull.progress.status}
                    </span>
                    {pull.progress.percent !== undefined ? <span className="tabular-nums">{Math.round(pull.progress.percent)}%</span> : null}
                  </div>
                  <div className="h-1 overflow-hidden rounded-sm bg-muted">
                    <div
                      className={cn("h-full bg-foreground transition-[width]", pull.progress.error && "bg-destructive")}
                      style={{ width: `${pull.progress.percent ?? (pull.progress.done ? 100 : 8)}%` }}
                    />
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          <CommandList className="max-h-[min(50vh,340px)] px-1.5 pb-1.5">
            {providers.length > 0 ? <CommandEmpty>No models found</CommandEmpty> : null}
            {providers.length === 0 ? (
              <div className="px-2.5 py-4 text-center text-sm text-muted-foreground">No providers configured</div>
            ) : (
              providers.map((provider) => {
                const catalogProvider =
                  catalog?.[modelsDevProviderId(provider.id, provider.name, provider.baseUrl) ?? ""];
                return (
                  <CommandGroup
                    key={provider.id}
                    heading={provider.name}
                    className="p-0 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.08em] [&_[cmdk-group-heading]]:text-[var(--berry-text-tertiary)]"
                  >
                    {providerModels(provider).map((modelId) => {
                      const isActive = active?.providerId === provider.id && active.model === modelId;
                      const info = catalogProvider?.models?.[modelId];
                      const metadata = provider.models.find((candidate) => candidate.id === modelId);
                      const badges = modelBadges(metadata);
                      return (
                        <CommandItem
                          key={modelId}
                          value={`${provider.id} ${provider.name} ${modelId}`}
                          title={info ? describeModelsDevModel(info) : modelId}
                          onSelect={() => {
                            onPick({ providerId: provider.id, model: modelId });
                            setOpen(false);
                          }}
                          className={cn("gap-2.5 rounded-lg px-2.5 py-2", isActive && "bg-[var(--berry-hover)]")}
                        >
                          <ModelGlyph
                            candidates={modelsDevLogoCandidates(modelId, provider.id, provider.name, provider.baseUrl)}
                            hints={[provider.id, provider.name, provider.baseUrl]}
                            name={info?.name ?? modelId}
                          />
                          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground">{modelId}</span>
                          {badges.slice(0, 3).map((badge) => (
                            <span key={badge} className="shrink-0 text-[10px] text-muted-foreground">
                              {badge}
                            </span>
                          ))}
                          {provider.kind === "lm-studio" && metadata && modelEngine(metadata) === "lm-studio" ? (
                            <Button
                              type="button"
                              size="icon-sm"
                              variant="ghost"
                              aria-label={`${metadata.loaded ? "Unload" : "Load"} ${modelId}`}
                              title={metadata.loaded ? "Unload model" : "Load model"}
                              disabled={Boolean(busyModel)}
                              onPointerDown={(event) => event.stopPropagation()}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                void toggleLmStudioModel(provider, metadata);
                              }}
                              className="size-6 shrink-0"
                            >
                              {busyModel === `${provider.id}:${modelId}` ? (
                                <Loader2Icon className="animate-spin" />
                              ) : metadata.loaded ? (
                                <X />
                              ) : (
                                <CirclePlus />
                              )}
                            </Button>
                          ) : null}
                          {isActive ? <Check className="ml-auto size-4 shrink-0 text-foreground" /> : null}
                        </CommandItem>
                      );
                    })}
                    {provider.kind === "ollama" ? (
                      <CommandItem
                        value={`${provider.id} pull ollama model`}
                        onSelect={() => setPull({ providerId: provider.id, model: "", action: "pull", starting: false })}
                        className="gap-2.5 rounded-lg px-2.5 py-2 text-muted-foreground"
                      >
                        <FileDown className="size-4" />
                        <span className="text-xs">Pull model</span>
                      </CommandItem>
                    ) : null}
                    {provider.kind === "lm-studio" ? (
                      <CommandItem
                        value={`${provider.id} download lm studio model`}
                        onSelect={() => setPull({ providerId: provider.id, model: "", action: "download", starting: false })}
                        className="gap-2.5 rounded-lg px-2.5 py-2 text-muted-foreground"
                      >
                        <FileDown className="size-4" />
                        <span className="text-xs">Download model</span>
                      </CommandItem>
                    ) : null}
                  </CommandGroup>
                );
              })
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
