import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { resolveModelCapabilities, type ModelCapabilities, type ReasoningLevel } from "@berry/shared";
import { reasoningLevelsForModel } from "@berry/client-core/models";
import { useSignedInSession } from "../../session/session";
import { kv } from "../../storage/kv";
import { shellKeys } from "./shell-data";

const MODEL_KEY = "berry.user.model";
const PROVIDER_KEY = "berry.user.modelProviderId";
const REASONING_KEY = "berry.user.reasoning";

export type ModelOption = { id: string; name: string; capabilities: ModelCapabilities };

export type ModelSelection = {
  providerId: string | null;
  modelId: string | null;
  /** Chosen by the person rather than the organization default; only then is it sent. */
  explicit: boolean;
  models: ModelOption[];
  reasoning: ReasoningLevel;
  reasoningLevels: ReasoningLevel[];
  imageGenerationAvailable: boolean;
  skills: Array<{ id: string; name: string; description: string; enabled: boolean }>;
  setModel: (id: string) => void;
  setReasoning: (level: ReasoningLevel) => void;
};

/** The composer's model and reasoning controls, persisted like the web's localStorage keys. */
export function useModelSelection(): ModelSelection {
  const { client, profile } = useSignedInSession();
  const catalog = useQuery({ queryKey: shellKeys.modelCatalog(profile.serverUrl), queryFn: () => client.modelCatalog(), staleTime: 60_000 });
  const [stored, setStored] = React.useState(() => ({ model: kv.getItem(MODEL_KEY), providerId: kv.getItem(PROVIDER_KEY) }));
  const [reasoning, setReasoningState] = React.useState<ReasoningLevel>(() => (kv.getItem(REASONING_KEY) as ReasoningLevel | null) ?? "medium");

  const data = catalog.data ?? null;
  const models = React.useMemo<ModelOption[]>(() => (data?.models ?? []).map((model) => ({
    id: model.id,
    name: model.name ?? model.id,
    capabilities: resolveModelCapabilities(model as Parameters<typeof resolveModelCapabilities>[0]),
  })), [data]);

  // A stored model the organization no longer offers falls back to its default.
  const storedValid = Boolean(stored.model && data && (stored.providerId !== data.providerId || models.some((model) => model.id === stored.model)));
  React.useEffect(() => {
    if (data && stored.model && !storedValid) {
      kv.removeItem(MODEL_KEY);
      kv.removeItem(PROVIDER_KEY);
      setStored({ model: null, providerId: null });
    }
  }, [data, stored.model, storedValid]);

  const explicit = storedValid;
  const modelId = explicit ? stored.model : data?.defaultModel ?? null;
  const providerId = explicit ? stored.providerId : data?.providerId ?? null;
  const current = models.find((model) => model.id === modelId);
  const reasoningLevels = reasoningLevelsForModel(current ? { id: current.id, label: current.name, capabilities: current.capabilities } : undefined);
  const effectiveReasoning = reasoningLevels.includes(reasoning) ? reasoning : reasoningLevels[0]!;

  return {
    providerId,
    modelId,
    explicit,
    models,
    reasoning: effectiveReasoning,
    reasoningLevels,
    imageGenerationAvailable: Boolean(data?.capabilities.imageGeneration.available),
    skills: data?.skills ?? [],
    setModel: (id) => {
      if (!data) return;
      kv.setItem(MODEL_KEY, id);
      kv.setItem(PROVIDER_KEY, data.providerId);
      setStored({ model: id, providerId: data.providerId });
    },
    setReasoning: (level) => {
      kv.setItem(REASONING_KEY, level);
      setReasoningState(level);
    },
  };
}
