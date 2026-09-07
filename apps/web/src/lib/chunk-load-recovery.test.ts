import { describe, expect, it, vi } from "vitest";
import { createChunkLoadRecovery, isChunkLoadError } from "./chunk-load-recovery";

const staleChunk = new TypeError("Failed to fetch dynamically imported module: https://ai.aesg.com/assets/document-preview-modal-old.js");
function makeBrowser(storage = new Map<string, string>()) {
  const events = new EventTarget();
  return {
    sessionStorage: {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => { storage.set(key, value); }),
    } as unknown as Storage,
    location: { reload: vi.fn() } as unknown as Location,
    navigator: { onLine: true } as Navigator,
    addEventListener: events.addEventListener.bind(events) as Window["addEventListener"],
    removeEventListener: events.removeEventListener.bind(events) as Window["removeEventListener"],
    events,
  };
}
function preloadError(browser: ReturnType<typeof makeBrowser>, payload: unknown) {
  const event = Object.assign(new Event("vite:preloadError", { cancelable: true }), { payload });
  browser.events.dispatchEvent(event);
  return event;
}

describe("deployment chunk recovery", () => {
  it("reloads on Vite's stale document-preview error and suppresses the original throw", () => {
    const browser = makeBrowser();
    const recovery = createChunkLoadRecovery(browser);
    expect(preloadError(browser, staleChunk).defaultPrevented).toBe(true);
    expect(browser.location.reload).toHaveBeenCalledOnce();
    expect(recovery.recover(staleChunk)).toBe(true);
    expect(browser.location.reload).toHaveBeenCalledOnce();
  });

  it("does not loop when the same module still fails after a page reload", () => {
    const storage = new Map<string, string>();
    createChunkLoadRecovery(makeBrowser(storage), () => 1_000).recover(staleChunk);
    const nextPage = makeBrowser(storage);
    createChunkLoadRecovery(nextPage, () => 900_000);
    expect(preloadError(nextPage, staleChunk).defaultPrevented).toBe(false);
    expect(nextPage.location.reload).not.toHaveBeenCalled();
  });

  it("guards different failing modules during startup, but permits a later deployment", () => {
    const storage = new Map<string, string>();
    createChunkLoadRecovery(makeBrowser(storage), () => 1_000).recover(staleChunk);
    const error = new TypeError("Failed to fetch dynamically imported module: /assets/new.js");
    const nextPage = makeBrowser(storage);
    expect(createChunkLoadRecovery(nextPage, () => 2_000).recover(error)).toBe(false);
    expect(createChunkLoadRecovery(nextPage, () => 400_000).recover(error)).toBe(true);
  });

  it("does not reload ordinary application errors, fetch errors or an offline tab", () => {
    const browser = makeBrowser();
    createChunkLoadRecovery(browser);
    for (const error of [new Error("Failed to fetch"), new Error("Cannot read properties of undefined")]) {
      expect(preloadError(browser, error).defaultPrevented).toBe(false);
    }
    Object.assign(browser.navigator, { onLine: false });
    expect(preloadError(browser, staleChunk).defaultPrevented).toBe(false);
    expect(browser.location.reload).not.toHaveBeenCalled();
  });

  it("leaves manual recovery available when storage cannot persist a reload guard", () => {
    const browser = makeBrowser();
    vi.mocked(browser.sessionStorage.setItem).mockImplementation(() => { throw new Error("Storage blocked"); });
    createChunkLoadRecovery(browser);
    expect(preloadError(browser, staleChunk).defaultPrevented).toBe(false);
    expect(browser.location.reload).not.toHaveBeenCalled();
  });

  it("removes its listener when disposed", () => {
    const browser = makeBrowser();
    createChunkLoadRecovery(browser).dispose();
    preloadError(browser, staleChunk);
    expect(browser.location.reload).not.toHaveBeenCalled();
  });

  it.each([
    "error loading dynamically imported module: /assets/old.js",
    "Importing a module script failed.",
    "Loading chunk 23 failed.",
    "Unable to preload CSS for /assets/old.css",
  ])("recognizes browser and stylesheet load failures: %s", (message) => {
    expect(isChunkLoadError({ message })).toBe(true);
  });
});
