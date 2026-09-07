import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invalidateModelCatalog, useModelCatalog } from "./model-catalog";
import { useStaticMentions, type MentionsController } from "../components/mention-menu";
import type { WebConfig } from "./config";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let renderer: ReactTestRenderer | undefined;
let mentions: MentionsController;
const skill = { id: "personal-memo", name: "aesg-task-card", description: "Create an AESG task card" };
const tasks: string[] = [];
const cache = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
function Probe({ client, scope = "member-a" }: { client: any; scope?: string }) {
  const catalog = useModelCatalog(client, [scope], true);
  const editorRef = React.useRef(null);
  mentions = useStaticMentions({ editorRef, config: { skills: catalog.data?.skills ?? [] } as unknown as WebConfig, taskTitles: tasks });
  return <div>{mentions.flatItems.map((item) => item.label).join(",")}</div>;
}
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }
afterEach(async () => { if (renderer) await act(async () => renderer!.unmount()); renderer = undefined; });
async function mount(client: any, queryClient: QueryClient) {
  await act(async () => { renderer = create(<QueryClientProvider client={queryClient}><Probe client={client} /></QueryClientProvider>); });
  await settle();
  await act(async () => { mentions.onDetectedChange({ trigger: "$", query: "aesg-" } as never); });
}

describe("live composer skill catalog", () => {
  it("updates an already-open suggestion menu after import, disable, re-enable, and delete without remounting", async () => {
    let skills: typeof skill[] = [];
    const client = { modelCatalog: vi.fn(async () => ({ skills })) };
    const queryClient = cache();
    await mount(client, queryClient);
    expect(mentions.flatItems).toHaveLength(0);
    for (const nextSkills of [[skill], [], [skill], []]) {
      skills = nextSkills;
      await act(async () => { await invalidateModelCatalog(queryClient); });
      await settle();
      expect(mentions.flatItems.map((item) => item.label)).toEqual(nextSkills.map((item) => item.name));
    }
    expect(client.modelCatalog).toHaveBeenCalledTimes(5);
  });

  it("discards an older in-flight catalog when an import finishes", async () => {
    let resolveOld!: (value: any) => void;
    const client = { modelCatalog: vi.fn().mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; })).mockResolvedValue({ skills: [skill] }) };
    const queryClient = cache();
    await mount(client, queryClient);
    await act(async () => { await invalidateModelCatalog(queryClient); });
    await settle();
    expect(mentions.flatItems.map((item) => item.label)).toEqual([skill.name]);
    await act(async () => { resolveOld({ skills: [] }); });
    await settle();
    expect(mentions.flatItems.map((item) => item.label)).toEqual([skill.name]);
  });

  it("does not reuse another member's catalog", async () => {
    const client = { modelCatalog: vi.fn().mockResolvedValueOnce({ skills: [skill] }).mockResolvedValueOnce({ skills: [] }) };
    const queryClient = cache();
    await mount(client, queryClient);
    expect(mentions.flatItems).toHaveLength(1);
    await act(async () => { renderer!.update(<QueryClientProvider client={queryClient}><Probe client={client} scope="member-b" /></QueryClientProvider>); });
    await settle();
    expect(mentions.flatItems).toHaveLength(0);
    expect(client.modelCatalog).toHaveBeenCalledTimes(2);
  });
});
