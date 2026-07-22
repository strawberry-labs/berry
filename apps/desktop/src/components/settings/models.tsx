import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft,
  ChevronDown,
  Monitor,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "@berry/desktop-ui/lib/icons";
import {
  resolveModelCapabilities,
  type ConversationKind,
  type DiscoveredLocalProvider,
  type ModelApiType,
  type ModelCapabilities,
  type ModelProvider,
  type ModelProviderPreset,
  type ProviderCheckResult,
  type ProviderAuthType,
  type RemoteModel,
} from "@berry/shared";
import { Badge } from "@berry/desktop-ui/components/ui/badge";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@berry/desktop-ui/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@berry/desktop-ui/components/ui/dialog";
import { Input } from "@berry/desktop-ui/components/ui/input";
import { Label } from "@berry/desktop-ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@berry/desktop-ui/components/ui/select";
import { Skeleton } from "@berry/desktop-ui/components/ui/skeleton";
import { Switch } from "@berry/desktop-ui/components/ui/switch";
import { cn } from "@berry/desktop-ui/lib/utils";
import { host } from "@/lib/berry";
import { enrichModelsWithModelsDev, fetchModelsDevCatalog, modelsDevProviderId, useModelsDevCatalog } from "@/lib/models-dev";
import { ProviderLogo } from "./provider-logos";
import { formatTokens, SettingsPageHeader, slugify } from "./shared";

const PROVIDERS_KEY = ["model-providers"] as const;
const PRESETS_KEY = ["model-presets"] as const;
const PROVIDER_HEALTH_INTERVAL_MS = 60_000;
const MODE_DEFAULTS: Array<{ mode: ConversationKind; label: string }> = [
  { mode: "chat", label: "Chat" },
  { mode: "code", label: "Code" },
];

interface ModelSelectionSetting {
  providerId: string;
  model: string;
}

function modeDefaultKey(mode: ConversationKind): string {
  return `model.defaultSelection.${mode}`;
}

function selectionValue(selection: ModelSelectionSetting): string {
  return JSON.stringify([selection.providerId, selection.model]);
}

function selectionFromValue(value: string): ModelSelectionSetting | null {
  if (value === "__provider_default__") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string"
      ? { providerId: parsed[0], model: parsed[1] }
      : null;
  } catch {
    return null;
  }
}

const API_TYPES: Array<{ id: ModelApiType; label: string; path: string }> = [
  { id: "openai-chat-completions", label: "Chat Completions", path: "/chat/completions" },
  { id: "openai-responses", label: "OpenAI Responses", path: "/responses" },
  { id: "anthropic-messages", label: "Anthropic Messages", path: "/messages" },
];

const AUTH_TYPES: Array<{ id: ProviderAuthType; label: string }> = [
  { id: "none", label: "No API key" },
  { id: "bearer", label: "Bearer token" },
  { id: "optional-bearer", label: "Optional API token" },
  { id: "x-api-key", label: "x-api-key header" },
];

function useProviders() {
  return useQuery({
    queryKey: PROVIDERS_KEY,
    queryFn: () => host.call<ModelProvider[]>("model.provider.list"),
  });
}

function usePresets() {
  return useQuery({
    queryKey: PRESETS_KEY,
    queryFn: () => host.call<ModelProviderPreset[]>("model.preset.list"),
    staleTime: Infinity,
  });
}

function apiTypeLabel(apiType: ModelApiType): string {
  return API_TYPES.find((candidate) => candidate.id === apiType)?.label ?? apiType;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function isLocalProvider(provider: ModelProvider): boolean {
  if (provider.kind === "local" || provider.kind === "lm-studio") return true;
  if (provider.kind !== "ollama") return false;
  try {
    const hostname = new URL(provider.baseUrl).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

/* ================================================================== */
/* Provider persistence                                                */
/* ================================================================== */

interface ProviderDraft {
  name: string;
  kind: ModelProvider["kind"];
  apiType: ModelApiType;
  baseUrl: string;
  endpointPath: string;
  modelsPath: string;
  authType: ProviderAuthType;
  apiKey: string;
}

interface CredentialStatus {
  exists: boolean;
  hint: string | null;
  storage?: string;
  plaintext: boolean;
}

function draftFromProvider(provider: ModelProvider): ProviderDraft {
  return {
    name: provider.name,
    kind: provider.kind,
    apiType: provider.apiType,
    baseUrl: provider.baseUrl,
    endpointPath: provider.endpointPath ?? "",
    modelsPath: provider.modelsPath ?? "",
    authType: provider.authType,
    apiKey: "",
  };
}

/** Persist a draft: store the key in the keychain when given, then save the row. */
async function persistProvider(input: {
  provider?: ModelProvider | undefined;
  draft: ProviderDraft;
  models?: RemoteModel[];
  defaultModel?: string;
  enabled?: boolean;
  source?: string;
}): Promise<ModelProvider> {
  const { provider, draft } = input;
  const trimmedKey = draft.apiKey.trim();
  let credentialRef = provider?.credentialRef ?? null;
  if (draft.authType === "none") credentialRef = null;
  else if (!credentialRef) credentialRef = `provider-${slugify(draft.name) || "custom"}`;
  if (trimmedKey.length > 0 && credentialRef) {
    await host.call("credential.set", { reference: credentialRef, secret: trimmedKey });
  }
  return host.call<ModelProvider>("model.provider.save", {
    ...(provider ? { id: provider.id } : {}),
    kind: draft.kind,
    name: draft.name.trim(),
    apiType: draft.apiType,
    baseUrl: draft.baseUrl.trim(),
    endpointPath: draft.endpointPath.trim() || null,
    modelsPath: draft.modelsPath.trim() || null,
    defaultModel: input.defaultModel ?? provider?.defaultModel ?? "",
    credentialRef,
    authType: draft.authType,
    enabled: input.enabled ?? provider?.enabled ?? true,
    models: input.models ?? provider?.models ?? [],
    source: input.source ?? provider?.source ?? "custom",
  });
}

function fetchModelsParams(provider: ModelProvider | undefined, draft: ProviderDraft): Record<string, unknown> {
  return provider
    ? { providerId: provider.id, ...(provider.credentialRef ? { credentialRef: provider.credentialRef } : {}) }
    : {
        baseUrl: draft.baseUrl.trim(),
        kind: draft.kind,
        apiType: draft.apiType,
        authType: draft.authType,
        modelsPath: draft.modelsPath.trim() || "/models",
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
      };
}

function checkStatusMessage(result: ProviderCheckResult): string {
  switch (result.status) {
    case "ok":
      return `Connection OK${typeof result.modelCount === "number" ? ` — ${result.modelCount} models available` : ""}`;
    case "manual-models":
      return "Reachable — models are managed manually for this provider.";
    case "not-running":
      return "The local server is not running.";
    case "missing-key":
      return "No API key configured.";
    case "invalid-key":
      return "The API key was rejected.";
    case "model-missing":
      return result.message ?? "The configured default model is not available from this provider.";
    case "unreachable":
      return "The provider could not be reached. Check the network and endpoint URL.";
    case "http-error":
      return result.message ?? "The provider returned a server error.";
    default:
      return result.message ?? "Connection failed.";
  }
}

function useProviderHealth(provider: ModelProvider) {
  return useQuery({
    queryKey: ["model-provider-health", provider.id],
    queryFn: () => host.call<ProviderCheckResult>("model.provider.check", fetchModelsParams(provider, draftFromProvider(provider)) as never),
    enabled: provider.enabled,
    retry: false,
    staleTime: 30_000,
    refetchInterval: provider.enabled ? PROVIDER_HEALTH_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
  });
}

function healthCategory(result: ProviderCheckResult | undefined): NonNullable<ProviderCheckResult["category"]> | "checking" | "disabled" {
  if (!result) return "checking";
  if (result.category) return result.category;
  if (result.ok) return "healthy";
  if (result.status === "missing-key" || result.status === "invalid-key") return "auth";
  if (result.status === "not-running" || result.status === "unreachable") return "network";
  if (result.status === "model-missing") return "model";
  return "server";
}

function healthDotClass(category: ReturnType<typeof healthCategory>): string {
  switch (category) {
    case "healthy":
      return "bg-emerald-500";
    case "auth":
      return "bg-rose-500";
    case "network":
      return "bg-amber-500";
    case "model":
      return "bg-orange-500";
    case "server":
      return "bg-red-500";
    case "checking":
      return "animate-pulse bg-sky-500";
    default:
      return "bg-muted-foreground/40";
  }
}

/* ================================================================== */
/* Small building blocks                                               */
/* ================================================================== */

function Field({
  id,
  label,
  hint,
  children,
}: {
  id?: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id} className="text-[13px] text-muted-foreground">
        {label}
      </Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground/80">{hint}</p> : null}
    </div>
  );
}

function ApiKeyInput({
  id,
  value,
  placeholder,
  disabled,
  autoFocus,
  onChange,
}: {
  id: string;
  value: string;
  placeholder: string;
  disabled?: boolean;
  autoFocus?: boolean;
  onChange: (value: string) => void;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input
        id={id}
        type={visible ? "text" : "password"}
        autoComplete="off"
        spellCheck={false}
        className="pr-14 font-mono text-xs"
        disabled={disabled ?? false}
        autoFocus={autoFocus ?? false}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <button
        type="button"
        tabIndex={-1}
        disabled={disabled ?? false}
        onClick={() => setVisible((current) => !current)}
        className="absolute inset-y-0 right-2 my-auto h-6 rounded px-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
      >
        {visible ? "Hide" : "Show"}
      </button>
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/80">{children}</h3>;
}

/* ================================================================== */
/* Model list                                                          */
/* ================================================================== */

interface ModelDialogState {
  open: boolean;
  editingId: string | null;
  id: string;
  name: string;
  contextWindow: string;
  maxOutputTokens: string;
  tools: CapabilityChoice;
  vision: CapabilityChoice;
  reasoning: CapabilityChoice;
  json: CapabilityChoice;
  inputCost: string;
  outputCost: string;
}

type CapabilityChoice = "auto" | "yes" | "no";

const CLOSED_MODEL_DIALOG: ModelDialogState = {
  open: false,
  editingId: null,
  id: "",
  name: "",
  contextWindow: "",
  maxOutputTokens: "",
  tools: "auto",
  vision: "auto",
  reasoning: "auto",
  json: "auto",
  inputCost: "",
  outputCost: "",
};

function capabilityChoice(value: boolean | undefined): CapabilityChoice {
  return value === undefined ? "auto" : value ? "yes" : "no";
}

function choiceValue(value: CapabilityChoice): boolean | undefined {
  return value === "auto" ? undefined : value === "yes";
}

function CapabilityField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: CapabilityChoice;
  onChange: (value: CapabilityChoice) => void;
}) {
  return (
    <Field id={id} label={label}>
      <Select value={value} onValueChange={(next) => onChange(next as CapabilityChoice)}>
        <SelectTrigger id={id} aria-label={label} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="auto">Auto-detect</SelectItem>
          <SelectItem value="yes">Supported</SelectItem>
          <SelectItem value="no">Not supported</SelectItem>
        </SelectContent>
      </Select>
    </Field>
  );
}

function ModelsSection({ provider }: { provider: ModelProvider }) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [dialog, setDialog] = useState<ModelDialogState>(CLOSED_MODEL_DIALOG);
  const modelsDevCatalog = useModelsDevCatalog().data ?? null;

  // The default model always shows even when it never came from a fetch.
  const models = useMemo(() => {
    const list = [...provider.models];
    if (provider.defaultModel && !list.some((model) => model.id === provider.defaultModel)) {
      list.unshift({ id: provider.defaultModel });
    }
    return list;
  }, [provider.models, provider.defaultModel]);

  const filtered = search.trim()
    ? models.filter((model) => `${model.id} ${model.name ?? ""}`.toLowerCase().includes(search.trim().toLowerCase()))
    : models;

  const saveModels = useMutation({
    mutationFn: (input: { models: RemoteModel[]; defaultModel?: string }) =>
      persistProvider({
        provider,
        draft: draftFromProvider(provider),
        models: input.models,
        ...(input.defaultModel !== undefined ? { defaultModel: input.defaultModel } : {}),
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: PROVIDERS_KEY }),
    onError: () => toast.error("Could not update models"),
  });

  const fetchModels = useMutation({
    mutationFn: async () => {
      const fetched = await host.call<RemoteModel[]>("model.provider.models", fetchModelsParams(provider, draftFromProvider(provider)) as never);
      const catalogId = modelsDevProviderId(provider.id, provider.name, provider.baseUrl);
      const catalog = catalogId ? modelsDevCatalog ?? await fetchModelsDevCatalog() : modelsDevCatalog;
      const enriched = enrichModelsWithModelsDev(provider, fetched, catalog);
      if (enriched.some((model, index) => JSON.stringify(model) !== JSON.stringify(fetched[index]))) {
        await persistProvider({ provider, draft: draftFromProvider(provider), models: enriched });
      }
      return enriched;
    },
    onSuccess: (fetched) => {
      if (fetched.length === 0) toast.info("No models returned by this endpoint.");
      else toast.success(`Fetched ${fetched.length} models`);
      void queryClient.invalidateQueries({ queryKey: PROVIDERS_KEY });
    },
    onError: (error: unknown) => toast.error(`Could not fetch models: ${error instanceof Error ? error.message : String(error)}`),
  });

  const submitDialog = () => {
    const id = dialog.id.trim();
    if (!id) return;
    const original = dialog.editingId ? provider.models.find((model) => model.id === dialog.editingId) : undefined;
    const {
      name: _name,
      contextWindow: _contextWindow,
      maxOutputTokens: _maxOutputTokens,
      capabilityOverrides: _capabilityOverrides,
      ...preserved
    } = original ?? { id };
    const capabilityOverrides: ModelCapabilities = {};
    for (const [key, value] of [
      ["tools", choiceValue(dialog.tools)],
      ["vision", choiceValue(dialog.vision)],
      ["reasoning", choiceValue(dialog.reasoning)],
      ["json", choiceValue(dialog.json)],
    ] as const) {
      if (value !== undefined) capabilityOverrides[key] = value;
    }
    const contextWindow = Number(dialog.contextWindow);
    const maxOutputTokens = Number(dialog.maxOutputTokens);
    if (contextWindow > 0 || maxOutputTokens > 0) {
      capabilityOverrides.context = {
        ...(contextWindow > 0 ? { windowTokens: contextWindow } : {}),
        ...(maxOutputTokens > 0 ? { maxOutputTokens } : {}),
      };
    }
    const inputCost = Number(dialog.inputCost);
    const outputCost = Number(dialog.outputCost);
    if (dialog.inputCost.trim() || dialog.outputCost.trim()) {
      capabilityOverrides.cost = {
        ...(inputCost >= 0 && dialog.inputCost.trim() ? { input: inputCost } : {}),
        ...(outputCost >= 0 && dialog.outputCost.trim() ? { output: outputCost } : {}),
      };
    }
    const entry: RemoteModel = {
      ...preserved,
      id,
      ...(dialog.name.trim() && dialog.name.trim() !== id ? { name: dialog.name.trim() } : {}),
      ...(contextWindow > 0 ? { contextWindow } : {}),
      ...(maxOutputTokens > 0 ? { maxOutputTokens } : {}),
      ...(Object.keys(capabilityOverrides).length > 0 ? { capabilityOverrides } : {}),
    };
    const next = dialog.editingId
      ? provider.models.map((model) => (model.id === dialog.editingId ? entry : model))
      : [...provider.models.filter((model) => model.id !== id), entry];
    const renamedDefault = dialog.editingId !== null && provider.defaultModel === dialog.editingId && dialog.editingId !== id;
    saveModels.mutate({ models: next, ...(renamedDefault ? { defaultModel: id } : {}) });
    setDialog(CLOSED_MODEL_DIALOG);
  };

  const removeModel = (id: string) => {
    const next = provider.models.filter((model) => model.id !== id);
    const defaultModel = provider.defaultModel === id ? next[0]?.id ?? "" : provider.defaultModel;
    saveModels.mutate({ models: next, defaultModel });
  };

  return (
    <section className="flex flex-col gap-2.5" data-testid="provider-models">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <SectionLabel>Models</SectionLabel>
          <span className="rounded-full border border-border px-1.5 py-px text-[11px] tabular-nums text-muted-foreground">
            {models.length}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
            disabled={fetchModels.isPending || provider.modelsPath === null}
            title={provider.modelsPath === null ? "This provider has no model list endpoint" : "Fetch models from the endpoint"}
            onClick={() => fetchModels.mutate()}
          >
            <RefreshCw className={cn("size-3.5", fetchModels.isPending && "animate-spin")} />
            Fetch
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setDialog({ ...CLOSED_MODEL_DIALOG, open: true })}
          >
            <Plus className="size-3.5" />
            Add model
          </Button>
        </div>
      </div>

      {models.length > 6 ? (
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search models…"
            aria-label="Search models"
            className="h-8 pl-8 text-xs"
          />
        </div>
      ) : null}

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-1 rounded-lg border border-dashed border-border px-4 py-6 text-center">
          <p className="text-sm text-muted-foreground">{search ? "No models match your search." : "No models yet."}</p>
          {!search ? (
            <p className="text-xs text-muted-foreground/70">
              {provider.modelsPath === null ? "Add models manually for this provider." : "Fetch from the endpoint, or add one manually."}
            </p>
          ) : null}
        </div>
      ) : (
        <ul className="max-h-[30rem] divide-y divide-border/70 overflow-y-auto rounded-lg border border-border">
          {filtered.map((model) => {
            const isDefault = model.id === provider.defaultModel;
            const capabilities = resolveModelCapabilities(model);
            const capabilityBadges = [
              ...(capabilities.tools === true ? ["Tools"] : []),
              ...(capabilities.vision === true ? ["Vision"] : []),
              ...(capabilities.reasoning === true ? ["Reasoning"] : []),
            ];
            return (
              <li key={model.id} className="group flex items-center gap-3 px-3 py-2">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-mono text-xs text-foreground" title={model.id}>
                    {model.name && model.name !== model.id ? model.name : model.id}
                  </span>
                  {model.name && model.name !== model.id ? (
                    <span className="truncate font-mono text-[11px] text-muted-foreground/70">{model.id}</span>
                  ) : null}
                </div>
                {model.contextWindow ? (
                  <span
                    className="rounded border border-border px-1.5 py-px font-mono text-[10px] uppercase text-muted-foreground"
                    title={`${model.contextWindow.toLocaleString()} token context window`}
                  >
                    {formatTokens(model.contextWindow)}
                  </span>
                ) : null}
                {capabilityBadges.slice(0, 2).map((label) => (
                  <span key={label} className="rounded border border-border px-1.5 py-px text-[10px] text-muted-foreground">
                    {label}
                  </span>
                ))}
                {isDefault ? (
                  <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                    Default
                  </Badge>
                ) : (
                  <button
                    type="button"
                    onClick={() => saveModels.mutate({ models: provider.models, defaultModel: model.id })}
                    className="hidden shrink-0 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground group-hover:block"
                  >
                    Set default
                  </button>
                )}
                <div className="flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    className="size-6 text-muted-foreground hover:text-foreground"
                    aria-label={`Edit ${model.id}`}
                    onClick={() =>
                      setDialog({
                        open: true,
                        editingId: model.id,
                        id: model.id,
                        name: model.name && model.name !== model.id ? model.name : "",
                        contextWindow: model.contextWindow ? String(model.contextWindow) : "",
                        maxOutputTokens: model.maxOutputTokens ? String(model.maxOutputTokens) : "",
                        tools: capabilityChoice(model.capabilityOverrides?.tools),
                        vision: capabilityChoice(model.capabilityOverrides?.vision),
                        reasoning: capabilityChoice(model.capabilityOverrides?.reasoning),
                        json: capabilityChoice(model.capabilityOverrides?.json),
                        inputCost: model.capabilityOverrides?.cost?.input !== undefined ? String(model.capabilityOverrides.cost.input) : "",
                        outputCost: model.capabilityOverrides?.cost?.output !== undefined ? String(model.capabilityOverrides.cost.output) : "",
                      })
                    }
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    className="size-6 text-muted-foreground hover:text-destructive"
                    aria-label={`Remove ${model.id}`}
                    onClick={() => removeModel(model.id)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Dialog open={dialog.open} onOpenChange={(open) => setDialog(open ? dialog : CLOSED_MODEL_DIALOG)}>
        <DialogContent className="max-h-[min(90vh,760px)] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{dialog.editingId ? "Edit model" : "Add model"}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <Field id="model-id" label="Model ID">
              <Input
                id="model-id"
                className="font-mono text-xs"
                placeholder="e.g. gpt-4.1-mini"
                autoFocus
                value={dialog.id}
                onChange={(event) => setDialog({ ...dialog, id: event.target.value })}
              />
            </Field>
            <Field id="model-name" label="Display name (optional)">
              <Input
                id="model-name"
                placeholder="e.g. GPT-4.1 mini"
                value={dialog.name}
                onChange={(event) => setDialog({ ...dialog, name: event.target.value })}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field id="model-context" label="Context window">
                <Input
                  id="model-context"
                  type="number"
                  placeholder="e.g. 128000"
                  value={dialog.contextWindow}
                  onChange={(event) => setDialog({ ...dialog, contextWindow: event.target.value })}
                />
              </Field>
              <Field id="model-max-output" label="Max output tokens">
                <Input
                  id="model-max-output"
                  type="number"
                  placeholder="e.g. 32000"
                  value={dialog.maxOutputTokens}
                  onChange={(event) => setDialog({ ...dialog, maxOutputTokens: event.target.value })}
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <CapabilityField id="model-tools" label="Tool calling" value={dialog.tools} onChange={(tools) => setDialog({ ...dialog, tools })} />
              <CapabilityField id="model-vision" label="Image input" value={dialog.vision} onChange={(vision) => setDialog({ ...dialog, vision })} />
              <CapabilityField id="model-reasoning" label="Reasoning" value={dialog.reasoning} onChange={(reasoning) => setDialog({ ...dialog, reasoning })} />
              <CapabilityField id="model-json" label="Structured JSON" value={dialog.json} onChange={(json) => setDialog({ ...dialog, json })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field id="model-input-cost" label="Input $ / 1M tokens">
                <Input
                  id="model-input-cost"
                  type="number"
                  min="0"
                  step="any"
                  placeholder="e.g. 1.25"
                  value={dialog.inputCost}
                  onChange={(event) => setDialog({ ...dialog, inputCost: event.target.value })}
                />
              </Field>
              <Field id="model-output-cost" label="Output $ / 1M tokens">
                <Input
                  id="model-output-cost"
                  type="number"
                  min="0"
                  step="any"
                  placeholder="e.g. 5"
                  value={dialog.outputCost}
                  onChange={(event) => setDialog({ ...dialog, outputCost: event.target.value })}
                />
              </Field>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setDialog(CLOSED_MODEL_DIALOG)}>
              Cancel
            </Button>
            <Button type="button" disabled={dialog.id.trim().length === 0} onClick={submitDialog}>
              {dialog.editingId ? "Save model" : "Add model"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

/* ================================================================== */
/* Provider detail                                                     */
/* ================================================================== */

function AdvancedFields({
  draft,
  setDraft,
  idPrefix,
}: {
  draft: ProviderDraft;
  setDraft: (update: (previous: ProviderDraft) => ProviderDraft) => void;
  idPrefix: string;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <Field id={`${idPrefix}-endpoint-path`} label="Endpoint path">
        <Input
          id={`${idPrefix}-endpoint-path`}
          className="font-mono text-xs"
          placeholder="/chat/completions"
          value={draft.endpointPath}
          onChange={(event) => setDraft((previous) => ({ ...previous, endpointPath: event.target.value }))}
        />
      </Field>
      <Field id={`${idPrefix}-models-path`} label="Models path">
        <Input
          id={`${idPrefix}-models-path`}
          className="font-mono text-xs"
          placeholder="/models"
          value={draft.modelsPath}
          onChange={(event) => setDraft((previous) => ({ ...previous, modelsPath: event.target.value }))}
        />
      </Field>
      <Field id={`${idPrefix}-auth-type`} label="Authentication">
        <Select
          value={draft.authType}
          onValueChange={(authType) => setDraft((previous) => ({ ...previous, authType: authType as ProviderAuthType }))}
        >
          <SelectTrigger id={`${idPrefix}-auth-type`} aria-label="Authentication" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AUTH_TYPES.map((authType) => (
              <SelectItem key={authType.id} value={authType.id}>
                {authType.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </div>
  );
}

function ApiTypeSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: ModelApiType;
  onChange: (apiType: ModelApiType) => void;
}) {
  return (
    <Select value={value} onValueChange={(apiType) => onChange(apiType as ModelApiType)}>
      <SelectTrigger id={id} aria-label="API format" className="w-full">
        {/* Custom value: keep the trigger short; paths show in the menu only. */}
        <SelectValue>{apiTypeLabel(value)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {API_TYPES.map((apiType) => (
          <SelectItem key={apiType.id} value={apiType.id}>
            {apiType.label}
            <span className="ml-1 font-mono text-xs text-muted-foreground">({apiType.path})</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Applies the endpoint-path + auth conventions when the API format changes. */
function withApiType(previous: ProviderDraft, apiType: ModelApiType): ProviderDraft {
  return {
    ...previous,
    apiType,
    endpointPath: API_TYPES.find((candidate) => candidate.id === apiType)?.path ?? previous.endpointPath,
    ...(apiType === "anthropic-messages" && previous.authType === "bearer" ? { authType: "x-api-key" as const } : {}),
  };
}

function ProviderDetail({ provider }: { provider: ModelProvider }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ProviderDraft>(() => draftFromProvider(provider));
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const health = useProviderHealth(provider);
  useEffect(() => {
    setDraft(draftFromProvider(provider));
    // Re-sync when another mutation (models, enable) refreshes the row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.id, provider.updatedAt]);

  const saved = draftFromProvider(provider);
  const dirty =
    draft.apiKey.trim().length > 0 ||
    (Object.keys(saved) as Array<keyof ProviderDraft>).some((key) => key !== "apiKey" && draft[key] !== saved[key]);
  const credentialReference = provider.credentialRef;
  const showCredentialStatus = Boolean(credentialReference && draft.authType !== "none");
  const credentialStatus = useQuery({
    queryKey: ["credential-status", credentialReference],
    enabled: showCredentialStatus,
    staleTime: 30_000,
    queryFn: () => {
      if (!credentialReference) throw new Error("Missing credential reference");
      return host.call<CredentialStatus>("credential.status", { reference: credentialReference });
    },
  });

  const save = useMutation({
    mutationFn: () => persistProvider({ provider, draft }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PROVIDERS_KEY });
      void queryClient.invalidateQueries({ queryKey: ["model-provider-health", provider.id] });
      if (credentialReference) void queryClient.invalidateQueries({ queryKey: ["credential-status", credentialReference] });
      toast.success(`Saved ${draft.name.trim() || provider.name}`);
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : "Could not save provider"),
  });

  const deleteCredential = useMutation({
    mutationFn: async () => {
      if (!credentialReference) return;
      await host.call("credential.delete", { reference: credentialReference });
    },
    onSuccess: () => {
      if (credentialReference) void queryClient.invalidateQueries({ queryKey: ["credential-status", credentialReference] });
      toast.success("Deleted saved API key");
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : "Could not delete API key"),
  });

  const toggleEnabled = useMutation({
    mutationFn: (enabled: boolean) => persistProvider({ provider, draft: draftFromProvider(provider), enabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PROVIDERS_KEY });
      void queryClient.invalidateQueries({ queryKey: ["model-provider-health", provider.id] });
    },
    onError: () => toast.error(`Could not update ${provider.name}`),
  });

  const testConnection = async () => {
    try {
      const { data: result } = await health.refetch();
      if (!result) throw new Error("Connection test returned no result");
      const message = checkStatusMessage(result);
      if (result.ok) toast.success(message);
      else toast.error(message);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Connection test failed");
    }
  };

  const remove = useMutation({
    mutationFn: () => host.call("model.provider.delete", { id: provider.id }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PROVIDERS_KEY });
      toast.success(`Removed ${provider.name}`);
    },
    onError: () => toast.error("Could not remove provider"),
  });

  const keyOptional = draft.authType === "none" || draft.authType === "optional-bearer" || provider.kind === "local" || provider.kind === "lm-studio";

  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="provider-detail">
      <div className="flex flex-wrap items-center gap-3 border-b border-border/70 px-5 py-4">
        <ProviderLogo hints={[provider.id, provider.name, provider.baseUrl]} name={provider.name} size="lg" />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2">
            <span className="truncate text-base font-semibold">{provider.name}</span>
            <Badge variant={provider.enabled ? "secondary" : "outline"} className="h-5 px-1.5 text-[10px]">
              {provider.enabled ? "Enabled" : "Disabled"}
            </Badge>
          </div>
          <span className="truncate font-mono text-xs text-muted-foreground">
            {hostnameOf(provider.baseUrl)} · {apiTypeLabel(provider.apiType)}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button type="button" variant="outline" size="sm" className="h-8" disabled={health.isFetching || !provider.enabled} onClick={() => void testConnection()}>
            {health.isFetching ? "Testing…" : "Test connection"}
          </Button>
          {provider.kind !== "berry-router" ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="text-muted-foreground hover:text-destructive"
              aria-label={`Remove ${provider.name}`}
              onClick={() => remove.mutate()}
            >
              <Trash2 />
            </Button>
          ) : null}
          <Switch
            checked={provider.enabled}
            onCheckedChange={(enabled) => toggleEnabled.mutate(enabled)}
            aria-label={`Enable ${provider.name}`}
          />
        </div>
      </div>

      <div className="flex min-w-0 items-center gap-2 border-b border-border/70 px-5 py-2 text-xs" data-testid="provider-health">
        <span
          aria-hidden
          className={cn("size-2 shrink-0 rounded-full", healthDotClass(provider.enabled ? healthCategory(health.data) : "disabled"))}
        />
        <span className={cn("truncate", health.data?.ok ? "text-muted-foreground" : "text-foreground")}>
          {!provider.enabled
            ? "Health checks paused while this provider is disabled."
            : health.isPending
              ? "Checking provider health…"
              : checkStatusMessage(health.data ?? { ok: false, status: "unreachable", category: "network" })}
        </span>
        {health.data?.checkedAt ? (
          <span className="ml-auto shrink-0 tabular-nums text-muted-foreground/70" title={health.data.checkedAt}>
            {health.data.latencyMs ?? 0} ms
          </span>
        ) : null}
      </div>

      <div className="grid flex-1 grid-cols-1 content-start gap-x-10 gap-y-6 overflow-y-auto p-5 xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <section className="flex flex-col gap-3.5">
          <SectionLabel>Connection</SectionLabel>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
            <Field id="provider-name" label="Name">
              <Input
                id="provider-name"
                value={draft.name}
                onChange={(event) => setDraft((previous) => ({ ...previous, name: event.target.value }))}
              />
            </Field>
            <Field id="provider-api-type" label="API format">
              <ApiTypeSelect id="provider-api-type" value={draft.apiType} onChange={(apiType) => setDraft((previous) => withApiType(previous, apiType))} />
            </Field>
          </div>
          <Field id="provider-base-url" label="Base URL">
            <Input
              id="provider-base-url"
              className="font-mono text-xs"
              placeholder="https://api.example.com/v1"
              value={draft.baseUrl}
              onChange={(event) => setDraft((previous) => ({ ...previous, baseUrl: event.target.value }))}
            />
          </Field>
          <Field
            id="provider-api-key"
            label={keyOptional ? "API key (optional)" : "API key"}
            hint="Stored encrypted on this device, never in settings files."
          >
            <ApiKeyInput
              id="provider-api-key"
              disabled={draft.authType === "none"}
              placeholder={
                draft.authType === "none"
                  ? "No key required"
                  : provider.credentialRef
                    ? "••••••••  (leave blank to keep current)"
                    : "sk-…"
              }
              value={draft.apiKey}
              onChange={(apiKey) => setDraft((previous) => ({ ...previous, apiKey }))}
            />
            {showCredentialStatus ? (
              <div className="flex min-h-9 flex-wrap items-center justify-between gap-2 rounded-md border border-border/70 bg-muted/25 px-3 py-2 text-xs">
                <span className="min-w-0 truncate text-muted-foreground">
                  {credentialStatus.isLoading
                    ? "Checking saved key"
                    : credentialStatus.isError
                      ? "Could not read saved key"
                      : credentialStatus.data?.exists
                        ? `Saved ${credentialStatus.data.hint ?? "••••"}`
                        : "No saved key"}
                </span>
                {credentialStatus.data?.exists ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                    disabled={deleteCredential.isPending}
                    onClick={() => deleteCredential.mutate()}
                  >
                    Delete key
                  </Button>
                ) : null}
              </div>
            ) : null}
          </Field>
          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                <ChevronDown
                  className={cn(
                    "size-3.5 transition-transform duration-[var(--duration-fast)] ease-[var(--ease-smooth-out)]",
                    !advancedOpen && "-rotate-90",
                  )}
                />
                Advanced
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-3">
              <AdvancedFields draft={draft} setDraft={setDraft} idPrefix="provider" />
            </CollapsibleContent>
          </Collapsible>
        </section>

        <ModelsSection provider={provider} />
      </div>

      {dirty ? (
        <div className="flex items-center justify-between gap-3 border-t border-border/70 bg-muted/30 px-5 py-3">
          <span className="text-xs text-muted-foreground">Unsaved changes</span>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(draftFromProvider(provider))}>
              Discard
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={save.isPending || draft.name.trim().length === 0 || draft.baseUrl.trim().length === 0}
              onClick={() => save.mutate()}
            >
              {save.isPending ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ================================================================== */
/* Add-provider flow                                                   */
/* ================================================================== */

const CUSTOM_PRESET_ID = "custom-openai-compatible";

function PresetCard({ preset, onSelect }: { preset: ModelProviderPreset; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="group flex items-center gap-3 rounded-xl border border-border bg-card/40 px-3.5 py-3 text-left transition-[border-color,background-color] hover:border-foreground/25 hover:bg-accent/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
    >
      <ProviderLogo hints={[preset.id, preset.name, preset.baseUrl]} name={preset.name} />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium">{preset.name}</span>
        <span className="truncate text-xs text-muted-foreground">
          {preset.local
            ? hostnameOf(preset.baseUrl)
            : preset.kind === "openai"
              ? `${apiTypeLabel(preset.apiType)} API`
              : preset.authType === "none"
                ? "No key needed"
                : preset.authType === "optional-bearer"
                  ? "Token optional"
                : "Add an API key"}
        </span>
      </span>
      <Plus className="ml-auto size-4 shrink-0 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground" />
    </button>
  );
}

function PresetSetup({
  preset,
  onBack,
  onSaved,
}: {
  preset: ModelProviderPreset;
  onBack: () => void;
  onSaved: (saved: ModelProvider) => void;
}) {
  const queryClient = useQueryClient();
  const isCustom = preset.id === CUSTOM_PRESET_ID;
  const [draft, setDraft] = useState<ProviderDraft>({
    name: isCustom ? "" : preset.name,
    kind: preset.kind,
    apiType: preset.apiType,
    baseUrl: preset.baseUrl,
    endpointPath: preset.endpointPath ?? "",
    modelsPath: preset.modelsPath ?? "",
    authType: preset.authType,
    apiKey: "",
  });
  const [modelId, setModelId] = useState(preset.defaultModel);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const keyless = draft.authType === "none" && !isCustom;
  const keyOptional = draft.authType === "optional-bearer";

  const add = useMutation({
    mutationFn: async () => {
      const saved = await persistProvider({
        draft,
        defaultModel: modelId.trim(),
        models: modelId.trim() ? [{ id: modelId.trim() }] : [],
        source: isCustom ? "custom" : "preset",
      });
      // Best-effort: pull the live model list right away so the picker is
      // populated without an extra step. Failures are fine (offline/local).
      try {
        await host.call("model.provider.models", {
          providerId: saved.id,
          ...(saved.credentialRef ? { credentialRef: saved.credentialRef } : {}),
        });
      } catch {
        /* fetched lazily later */
      }
      return saved;
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: PROVIDERS_KEY });
      toast.success(`Added ${saved.name}`);
      onSaved(saved);
    },
    onError: (error: unknown) => toast.error(error instanceof Error ? error.message : "Could not add provider"),
  });

  const valid =
    draft.name.trim().length > 0 &&
    draft.baseUrl.trim().length > 0 &&
    (keyless || keyOptional || isCustom || draft.apiKey.trim().length > 0);

  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="provider-setup">
      <div className="flex items-center gap-3 border-b border-border/70 px-5 py-4">
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Back to provider gallery" onClick={onBack}>
          <ArrowLeft />
        </Button>
        <ProviderLogo hints={[preset.id, preset.name, preset.baseUrl]} name={preset.name} size="lg" />
        <div className="flex min-w-0 flex-col">
          <span className="text-base font-semibold">{isCustom ? "Custom endpoint" : preset.name}</span>
          <span className="truncate text-xs text-muted-foreground">
            {apiTypeLabel(draft.apiType)}
            {draft.baseUrl ? (
              <>
                {" · "}
                <span className="font-mono">{hostnameOf(draft.baseUrl)}</span>
              </>
            ) : null}
          </span>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-5">
        <p className="text-sm text-muted-foreground">{preset.description}</p>

        {isCustom ? (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field id="setup-name" label="Name">
                <Input
                  id="setup-name"
                  placeholder="e.g. My inference server"
                  autoFocus
                  value={draft.name}
                  onChange={(event) => setDraft((previous) => ({ ...previous, name: event.target.value }))}
                />
              </Field>
              <Field id="setup-api-type" label="API format">
                <ApiTypeSelect id="setup-api-type" value={draft.apiType} onChange={(apiType) => setDraft((previous) => withApiType(previous, apiType))} />
              </Field>
            </div>
            <Field id="setup-base-url" label="Base URL">
              <Input
                id="setup-base-url"
                className="font-mono text-xs"
                placeholder="https://api.example.com/v1"
                value={draft.baseUrl}
                onChange={(event) => setDraft((previous) => ({ ...previous, baseUrl: event.target.value }))}
              />
            </Field>
            <Field id="setup-auth-type" label="Authentication">
              <Select
                value={draft.authType}
                onValueChange={(authType) => setDraft((previous) => ({ ...previous, authType: authType as ProviderAuthType }))}
              >
                <SelectTrigger id="setup-auth-type" aria-label="Authentication" className="w-full sm:w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AUTH_TYPES.map((authType) => (
                    <SelectItem key={authType.id} value={authType.id}>
                      {authType.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </>
        ) : null}

        {keyless ? (
          <div className="rounded-lg border border-border bg-muted/30 px-3.5 py-2.5 text-sm text-muted-foreground">
            No API key needed — Berry connects to <span className="font-mono text-xs">{hostnameOf(draft.baseUrl || "localhost")}</span>{" "}
            directly.
          </div>
        ) : draft.authType !== "none" ? (
          <Field
            id="setup-api-key"
            label={isCustom || keyOptional ? "API key (optional)" : "API key"}
            hint={
              isCustom || keyOptional
                ? "Stored encrypted on this device."
                : "That's all you need — endpoints and models are prefilled. Stored encrypted on this device."
            }
          >
            <ApiKeyInput
              id="setup-api-key"
              autoFocus={!isCustom}
              placeholder={draft.authType === "x-api-key" ? "sk-ant-…" : "sk-…"}
              value={draft.apiKey}
              onChange={(apiKey) => setDraft((previous) => ({ ...previous, apiKey }))}
            />
          </Field>
        ) : null}

        <Field id="setup-model" label="Default model" hint="Berry fetches the full model list from the endpoint after adding.">
          <Input
            id="setup-model"
            className="font-mono text-xs"
            placeholder="model-id"
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
          />
        </Field>

        <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronDown
                className={cn(
                  "size-3.5 transition-transform duration-[var(--duration-fast)] ease-[var(--ease-smooth-out)]",
                  !advancedOpen && "-rotate-90",
                )}
              />
              Advanced
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="flex flex-col gap-4 pt-3">
            {!isCustom ? (
              <Field id="setup-base-url-advanced" label="Base URL">
                <Input
                  id="setup-base-url-advanced"
                  className="font-mono text-xs"
                  value={draft.baseUrl}
                  onChange={(event) => setDraft((previous) => ({ ...previous, baseUrl: event.target.value }))}
                />
              </Field>
            ) : null}
            <AdvancedFields draft={draft} setDraft={setDraft} idPrefix="setup" />
          </CollapsibleContent>
        </Collapsible>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border/70 px-5 py-3">
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          Cancel
        </Button>
        <Button type="button" size="sm" disabled={!valid || add.isPending} onClick={() => add.mutate()}>
          {add.isPending ? "Adding…" : "Add provider"}
        </Button>
      </div>
    </div>
  );
}

function AddProviderGallery({
  onPick,
  onSaved,
}: {
  onPick: (preset: ModelProviderPreset) => void;
  onSaved: (saved: ModelProvider) => void;
}) {
  const presets = usePresets();
  const queryClient = useQueryClient();
  const list = presets.data ?? [];
  const cloud = list.filter((preset) => !preset.local && preset.id !== CUSTOM_PRESET_ID && preset.kind !== "berry-router");
  const local = list.filter((preset) => preset.local);
  const custom = list.find((preset) => preset.id === CUSTOM_PRESET_ID);

  const discover = useMutation({
    mutationFn: () => host.call<DiscoveredLocalProvider[]>("model.local.discover"),
    onSuccess: (found) => {
      if (found.length === 0) toast.info("No local model servers detected.");
    },
    onError: () => toast.error("Local discovery failed"),
  });
  const addDiscovered = useMutation({
    mutationFn: (suggestion: DiscoveredLocalProvider) =>
      host.call<ModelProvider>("model.provider.save", {
        kind: suggestion.kind,
        name: suggestion.name,
        apiType: suggestion.apiType,
        baseUrl: suggestion.baseUrl,
        defaultModel: suggestion.models[0]?.id ?? "",
        authType: suggestion.authType,
        models: suggestion.models,
        source: "discovered",
        enabled: true,
      }),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: PROVIDERS_KEY });
      toast.success(`Added ${saved.name}`);
      onSaved(saved);
    },
    onError: () => toast.error("Could not add local provider"),
  });

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-6 overflow-y-auto p-5" data-testid="provider-gallery">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold">Add a provider</h2>
        <p className="text-sm text-muted-foreground">
          Pick a provider and paste an API key — Berry prefills endpoints and fetches the model list.
        </p>
      </div>

      <section className="flex flex-col gap-2.5">
        <SectionLabel>Cloud providers</SectionLabel>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {cloud.map((preset) => (
            <PresetCard key={preset.id} preset={preset} onSelect={() => onPick(preset)} />
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-2.5">
        <div className="flex items-center justify-between gap-3">
          <SectionLabel>Local engines</SectionLabel>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
            disabled={discover.isPending}
            onClick={() => discover.mutate()}
          >
            <Monitor className="size-3.5" />
            {discover.isPending ? "Scanning…" : "Detect running servers"}
          </Button>
        </div>
        {(discover.data ?? []).length > 0 ? (
          <div className="flex flex-col gap-2" data-testid="discover-local">
            {(discover.data ?? []).map((suggestion) => (
              <div key={suggestion.presetId} className="flex items-center gap-3 rounded-xl border border-border bg-card/40 px-3.5 py-2.5">
                <ProviderLogo hints={[suggestion.presetId, suggestion.name, suggestion.baseUrl]} name={suggestion.name} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    {suggestion.name}
                    <Badge variant={suggestion.running ? "secondary" : "outline"} className="h-5 px-1.5 text-[10px]">
                      {suggestion.running ? "Running" : "Not running"}
                    </Badge>
                  </span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {suggestion.baseUrl}
                    {suggestion.models.length > 0 ? ` · ${suggestion.models.length} model${suggestion.models.length === 1 ? "" : "s"}` : ""}
                  </span>
                  {suggestion.helpCommand ? (
                    <span className="truncate font-mono text-[11px] text-muted-foreground/70">Start it with: {suggestion.helpCommand}</span>
                  ) : null}
                </div>
                <Button type="button" size="sm" variant="secondary" disabled={addDiscovered.isPending} onClick={() => addDiscovered.mutate(suggestion)}>
                  Add
                </Button>
              </div>
            ))}
          </div>
        ) : null}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {local.map((preset) => (
            <PresetCard key={preset.id} preset={preset} onSelect={() => onPick(preset)} />
          ))}
        </div>
      </section>

      {custom ? (
        <section className="flex flex-col gap-2.5">
          <SectionLabel>Custom</SectionLabel>
          <button
            type="button"
            onClick={() => onPick(custom)}
            className="group flex items-center gap-3 rounded-xl border border-dashed border-border px-3.5 py-3 text-left transition-[border-color,background-color] hover:border-foreground/25 hover:bg-accent/40"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted">
              <Plug className="size-4 text-muted-foreground" />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="text-sm font-medium">Custom endpoint</span>
              <span className="text-xs text-muted-foreground">Any OpenAI-compatible, Responses, or Anthropic-style API.</span>
            </span>
          </button>
        </section>
      ) : null}
    </div>
  );
}

/* ================================================================== */
/* Rail + page                                                         */
/* ================================================================== */

function ModeDefaultField({ mode, label, providers }: { mode: ConversationKind; label: string; providers: ModelProvider[] }) {
  const queryClient = useQueryClient();
  const key = modeDefaultKey(mode);
  const selection = useQuery({
    queryKey: ["settings", key],
    queryFn: () => host.call<ModelSelectionSetting | null>("settings.get", { key }),
  });
  const save = useMutation({
    mutationFn: (value: string) => {
      const selected = selectionFromValue(value);
      return host.call("settings.set", { key, value: selected ? { providerId: selected.providerId, model: selected.model } : null });
    },
    onSuccess: (_result, value) => {
      queryClient.setQueryData(["settings", key], selectionFromValue(value));
      toast.success(`${label} default updated`);
    },
    onError: () => toast.error(`Could not update the ${label.toLowerCase()} default`),
  });
  const options = providers.flatMap((provider) =>
    [...new Set([provider.defaultModel, ...provider.models.map((model) => model.id)].filter(Boolean))].map((model) => ({
      provider,
      model,
      value: selectionValue({ providerId: provider.id, model }),
    })),
  );
  const current = selection.data ? selectionValue(selection.data) : "__provider_default__";

  return (
    <Field id={`mode-default-${mode}`} label={label}>
      <Select value={current} onValueChange={(value) => save.mutate(value)} disabled={selection.isPending || save.isPending}>
        <SelectTrigger id={`mode-default-${mode}`} aria-label={`${label} default model`} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__provider_default__">Provider default</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.provider.name} · {option.model}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

function ModeDefaults({ providers }: { providers: ModelProvider[] }) {
  return (
    <section className="grid grid-cols-1 gap-3 border-y border-border/70 py-4 sm:grid-cols-[auto_repeat(3,minmax(0,1fr))] sm:items-end" data-testid="mode-defaults">
      <div className="pb-2 sm:pb-2.5 sm:pr-3">
        <SectionLabel>Mode defaults</SectionLabel>
      </div>
      {MODE_DEFAULTS.map(({ mode, label }) => (
        <ModeDefaultField key={mode} mode={mode} label={label} providers={providers} />
      ))}
    </section>
  );
}

function RailRow({ provider, active, onClick }: { provider: ModelProvider; active: boolean; onClick: () => void }) {
  const health = useProviderHealth(provider);
  const category = provider.enabled ? healthCategory(health.data) : "disabled";
  const status = provider.enabled
    ? health.data
      ? checkStatusMessage(health.data)
      : "Checking provider health…"
    : "Health checks paused";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex shrink-0 items-center gap-2.5 rounded-lg border border-transparent px-2.5 py-2 text-left text-sm transition-colors md:w-full",
        active ? "border-border bg-accent/70 font-medium" : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
      )}
    >
      <ProviderLogo hints={[provider.id, provider.name, provider.baseUrl]} name={provider.name} size="sm" />
      <span className="min-w-0 flex-1 truncate">{provider.name}</span>
      <span
        aria-hidden
        title={status}
        className={cn("size-2 shrink-0 rounded-full", healthDotClass(category))}
      />
    </button>
  );
}

function RailSectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="hidden px-2.5 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70 first:pt-0 md:block">
      {children}
    </div>
  );
}

export function ModelSettings() {
  const queryClient = useQueryClient();
  const providers = useProviders();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [setupPreset, setSetupPreset] = useState<ModelProviderPreset | null>(null);

  const list = providers.data ?? [];
  const firstParty = list.filter((provider) => provider.kind === "berry-router");
  const local = list.filter(isLocalProvider);
  const cloud = list.filter((provider) => provider.kind !== "berry-router" && !isLocalProvider(provider));
  const effectiveId = selectedId ?? list[0]?.id ?? "__add";
  const selected = list.find((provider) => provider.id === effectiveId);

  const openProvider = (id: string) => {
    setSelectedId(id);
    setSetupPreset(null);
  };

  return (
    <div className="flex flex-col gap-6">
      <SettingsPageHeader
        title="Model settings"
        description="Manage model providers. Once configured, they can be selected during chat."
        actions={
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Refresh providers"
            onClick={() => void queryClient.invalidateQueries({ queryKey: PROVIDERS_KEY })}
          >
            <RefreshCw />
          </Button>
        }
      />

      {!providers.isPending ? <ModeDefaults providers={list.filter((provider) => provider.enabled)} /> : null}

      {providers.isPending ? (
        <Skeleton className="h-[32rem] rounded-xl" />
      ) : (
        <div className="flex min-h-[32rem] flex-col overflow-hidden rounded-xl border border-border bg-card/20 md:flex-row">
          <nav
            aria-label="Providers"
            data-testid="provider-rail"
            className="flex shrink-0 gap-1 overflow-x-auto border-b border-border bg-muted/20 p-2.5 md:w-60 md:flex-col md:gap-0.5 md:overflow-y-auto md:border-b-0 md:border-r"
          >
            {firstParty.length > 0 ? <RailSectionLabel>Berry</RailSectionLabel> : null}
            {firstParty.map((provider) => (
              <RailRow
                key={provider.id}
                provider={provider}
                active={!setupPreset && effectiveId === provider.id}
                onClick={() => openProvider(provider.id)}
              />
            ))}
            {cloud.length > 0 ? <RailSectionLabel>Providers</RailSectionLabel> : null}
            {cloud.map((provider) => (
              <RailRow
                key={provider.id}
                provider={provider}
                active={!setupPreset && effectiveId === provider.id}
                onClick={() => openProvider(provider.id)}
              />
            ))}
            {local.length > 0 ? <RailSectionLabel>Local</RailSectionLabel> : null}
            {local.map((provider) => (
              <RailRow
                key={provider.id}
                provider={provider}
                active={!setupPreset && effectiveId === provider.id}
                onClick={() => openProvider(provider.id)}
              />
            ))}
            <div className="shrink-0 md:mt-2 md:border-t md:border-border md:pt-2">
              <button
                type="button"
                onClick={() => {
                  setSelectedId("__add");
                  setSetupPreset(null);
                }}
                aria-pressed={!setupPreset && effectiveId === "__add"}
                className={cn(
                  "flex shrink-0 items-center gap-2.5 rounded-lg border border-transparent px-2.5 py-2 text-left text-sm transition-colors md:w-full",
                  effectiveId === "__add"
                    ? "border-border bg-accent/70 font-medium"
                    : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
                )}
              >
                <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-dashed border-border">
                  <Plus className="size-3.5" />
                </span>
                Add provider
              </button>
            </div>
          </nav>

          {setupPreset ? (
            <PresetSetup
              preset={setupPreset}
              onBack={() => setSetupPreset(null)}
              onSaved={(saved) => {
                setSetupPreset(null);
                setSelectedId(saved.id);
              }}
            />
          ) : selected ? (
            <ProviderDetail key={selected.id} provider={selected} />
          ) : (
            <AddProviderGallery
              onPick={(preset) => setSetupPreset(preset)}
              onSaved={(saved) => {
                setSetupPreset(null);
                setSelectedId(saved.id);
              }}
            />
          )}
        </div>
      )}

      <p className="text-sm text-muted-foreground">Usage is tracked locally and never leaves this machine.</p>
    </div>
  );
}
