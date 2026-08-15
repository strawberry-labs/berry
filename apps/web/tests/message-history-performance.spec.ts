import { expect, test } from "@playwright/test";

test("keeps a real 10,000-message transcript within the rendering budget", async ({ page }) => {
  await page.addInitScript(() => {
    const NativeResizeObserver = window.ResizeObserver;
    let activeObserverCount = 0;
    const activeObservers = new Set<CountingResizeObserver>();
    const observedTargets = new WeakMap<CountingResizeObserver, Set<Element>>();
    class CountingResizeObserver extends NativeResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        super(callback);
        activeObservers.add(this);
        observedTargets.set(this, new Set());
        activeObserverCount = activeObservers.size;
      }
      observe(target: Element, options?: ResizeObserverOptions) {
        observedTargets.get(this)?.add(target);
        super.observe(target, options);
      }
      unobserve(target: Element) {
        observedTargets.get(this)?.delete(target);
        super.unobserve(target);
      }
      disconnect() {
        observedTargets.get(this)?.clear();
        activeObservers.delete(this);
        activeObserverCount = activeObservers.size;
        super.disconnect();
      }
    }
    window.ResizeObserver = CountingResizeObserver;
    Object.defineProperty(window, "__berryHistoryObserverCount", {
      configurable: true,
      get: () => [...activeObservers].filter((observer) => [...(observedTargets.get(observer) ?? [])].some((target) => (target as HTMLElement).dataset.historyKey)).length,
    });
  });
  await page.goto("/?benchmark=message-history");
  await expect(page.getByTestId("message-history-benchmark")).toBeVisible();
  await expect(page.locator('[data-history-window="true"]')).toBeVisible();

  const metrics = await page.evaluate(async () => {
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const viewport = document.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]');
    const historyWindow = document.querySelector<HTMLElement>('[data-history-window="true"]');
    if (!viewport || !historyWindow) throw new Error("History benchmark did not mount its viewport");
    const heap = () => {
      const value = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
      return typeof value === "number" ? value : null;
    };
    await frame();
    const heapBefore = heap();
    const scrollStart = performance.now();
    for (let index = 0; index < 20; index += 1) {
      viewport.scrollTop = (viewport.scrollHeight - viewport.clientHeight) * (index / 19);
      viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
      await frame();
    }
    const scrollMs = performance.now() - scrollStart;
    const updateStart = performance.now();
    (document.querySelector<HTMLButtonElement>('[data-testid="benchmark-update"]'))?.click();
    await frame();
    await frame();
    const updateMs = performance.now() - updateStart;
    const heapAfter = heap();
    return {
      scrollMs,
      updateMs,
      mountedRows: historyWindow.querySelectorAll("[data-history-key]").length,
      measuredRows: Number(historyWindow.dataset.historyMounted ?? 0),
      observerCount: Number((window as Window & { __berryHistoryObserverCount?: number }).__berryHistoryObserverCount ?? 0),
      markerCount: document.querySelectorAll("[data-conversation-marker]").length,
      heapGrowthBytes: heapBefore !== null && heapAfter !== null ? heapAfter - heapBefore : null,
      totalRows: Number(document.querySelector<HTMLElement>('[data-testid="message-history-benchmark"]')?.dataset.benchmarkTotalRows ?? 0),
    };
  });

  expect(metrics.totalRows).toBe(10_000);
  expect(metrics.mountedRows).toBeLessThanOrEqual(18);
  expect(metrics.measuredRows).toBeLessThanOrEqual(18);
  expect(metrics.observerCount).toBeLessThanOrEqual(2);
  expect(metrics.markerCount).toBeGreaterThan(0);
  expect(metrics.markerCount).toBeLessThanOrEqual(100);
  expect(metrics.scrollMs).toBeLessThan(1_000);
  expect(metrics.updateMs).toBeLessThan(250);
  if (metrics.heapGrowthBytes !== null) expect(metrics.heapGrowthBytes).toBeLessThan(32 * 1024 * 1024);
});

test("preserves the viewport while prepending an older variable-height page", async ({ page }) => {
  await page.goto("/?benchmark=message-history");
  await expect(page.getByRole("button", { name: "Load older messages" })).toBeVisible();
  const viewport = page.locator('[data-slot="message-scroller-viewport"]');
  await viewport.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(page.locator('[data-user-anchor="benchmark-message-0"]')).toBeVisible();
  const before = await viewport.evaluate((element) => {
    const anchor = document.querySelector<HTMLElement>('[data-user-anchor="benchmark-message-0"]');
    return { top: anchor?.getBoundingClientRect().top ?? null, scrollTop: element.scrollTop, height: element.scrollHeight };
  });
  expect(before.top).not.toBeNull();
  await page.getByRole("button", { name: "Load older messages" }).click();
  await expect(page.getByRole("button", { name: "Load older messages" })).toHaveCount(0);
  await expect(page.getByTestId("message-history-benchmark")).toHaveAttribute("data-benchmark-older-loaded", "true");
  await page.waitForFunction(() => {
    const viewport = document.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]');
    return Boolean(viewport && viewport.scrollTop > 0 && viewport.scrollHeight > viewport.clientHeight);
  });
  await expect(page.locator('[data-user-anchor="benchmark-message-0"]')).toBeVisible();
  const after = await viewport.evaluate((element) => {
    const anchor = document.querySelector<HTMLElement>('[data-user-anchor="benchmark-message-0"]');
    return { top: anchor?.getBoundingClientRect().top ?? null, scrollTop: element.scrollTop, height: element.scrollHeight };
  });
  expect(after.height).toBeGreaterThan(before.height);
  expect(after.top).not.toBeNull();
  expect(Math.abs(after.top! - before.top!)).toBeLessThanOrEqual(8);
  expect(after.scrollTop).toBeGreaterThan(0);
});
