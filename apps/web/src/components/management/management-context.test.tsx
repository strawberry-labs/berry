import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { useResource } from "./management-context";

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true, writable: true });

function Probe({ loader }: { loader: (signal?: AbortSignal) => Promise<string[]> }) {
  const resource = useResource("test-resource", loader, [] as string[]);
  return <div><span>{resource.data.join(",")}</span><button onClick={() => resource.setData((current) => [...current, "optimistic"])}>update</button></div>;
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

describe("management query resources", () => {
  it("deduplicates the initial request and updates only its keyed cache", async () => {
    const loader = vi.fn(async () => ["server"]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryClientProvider client={queryClient}><Probe loader={loader} /></QueryClientProvider>);
    });
    await settle();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(renderer!.root.findByType("span").children).toEqual(["server"]);
    await act(async () => {
      renderer!.root.findByType("button").props.onClick();
    });
    await settle();
    expect(renderer!.root.findByType("span").children).toEqual(["server,optimistic"]);
    await act(async () => renderer!.unmount());
  });

  it("aborts an in-flight request when the management surface unmounts", async () => {
    let signal: AbortSignal | undefined;
    const loader = vi.fn(async (requestSignal?: AbortSignal) => {
      signal = requestSignal;
      await new Promise<string[]>((resolve) => setTimeout(() => resolve(["late"]), 50));
      return ["late"];
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<QueryClientProvider client={queryClient}><Probe loader={loader} /></QueryClientProvider>);
    });
    await settle();
    await act(async () => renderer!.unmount());
    await settle();
    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(true);
  });
});
