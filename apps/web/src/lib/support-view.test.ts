import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readSupportView,
  startSupportView,
  stopSupportView,
  SUPPORT_VIEW_EVENT,
  SUPPORT_VIEW_STORAGE_KEY,
  type SupportViewSubject,
} from "./support-view";

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

function installWindow() {
  const events = new EventTarget();
  const localStorage = new MemoryStorage();
  vi.stubGlobal("window", {
    localStorage,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
  });
  return { events, localStorage };
}

const subject: SupportViewSubject = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002",
  name: "Supported user",
  email: "user@example.com",
};

describe("support view persistence", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("restores support state only for the actor that started it", () => {
    const { localStorage } = installWindow();

    startSupportView(subject, "actor_1");

    expect(readSupportView("actor_1")).toEqual(subject);
    expect(readSupportView("actor_2")).toBeNull();
    expect(localStorage.getItem(SUPPORT_VIEW_STORAGE_KEY)).toBeNull();
  });

  it("broadcasts same-tab start and stop transitions", () => {
    const { events, localStorage } = installWindow();
    const changed = vi.fn();
    events.addEventListener(SUPPORT_VIEW_EVENT, changed);

    startSupportView(subject, "actor_1");
    stopSupportView();

    expect(changed).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem(SUPPORT_VIEW_STORAGE_KEY)).toBeNull();
  });

  it("removes malformed persisted state instead of hydrating it", () => {
    const { localStorage } = installWindow();
    localStorage.setItem(SUPPORT_VIEW_STORAGE_KEY, "not-json");

    expect(readSupportView("actor_1")).toBeNull();
    expect(localStorage.getItem(SUPPORT_VIEW_STORAGE_KEY)).toBeNull();
  });

  it("fails closed when browser storage cannot be read or written", () => {
    const events = new EventTarget();
    const changed = vi.fn();
    events.addEventListener(SUPPORT_VIEW_EVENT, changed);
    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn(() => { throw new Error("storage blocked"); }),
        setItem: vi.fn(() => { throw new Error("storage blocked"); }),
        removeItem: vi.fn(() => { throw new Error("storage blocked"); }),
      },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    });

    expect(readSupportView("actor_1")).toBeNull();
    expect(() => startSupportView(subject, "actor_1")).toThrow("browser storage is unavailable");
    expect(() => stopSupportView()).not.toThrow();
    expect(changed).toHaveBeenCalledOnce();
  });
});
