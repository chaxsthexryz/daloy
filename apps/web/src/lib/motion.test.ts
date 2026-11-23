import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HIDDEN_PILL,
  interpolateCount,
  measurePillRect,
  prefersReducedMotion,
  startCountUp,
  subscribeReducedMotion,
  useCountUp,
  usePrefersReducedMotion,
  useSlidingPill,
} from "./motion";

const originalMatchMedia = globalThis.matchMedia;

afterEach(() => {
  if (originalMatchMedia) globalThis.matchMedia = originalMatchMedia;
  else delete (globalThis as { matchMedia?: typeof matchMedia }).matchMedia;
  vi.restoreAllMocks();
});

function mockMatchMedia(matches: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const mql = {
    matches,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => true,
  } as unknown as MediaQueryList;
  globalThis.matchMedia = vi.fn(() => mql);
  return {
    fire(next: boolean) {
      (mql as { matches: boolean }).matches = next;
      for (const listener of listeners) listener({ matches: next } as MediaQueryListEvent);
    },
    listenerCount: () => listeners.size,
  };
}

describe("interpolateCount", () => {
  it("clamps at 0 and 1 and eases smoothly in between", () => {
    expect(interpolateCount(10, 50, -0.5)).toBe(10);
    expect(interpolateCount(10, 50, 0)).toBe(10);
    expect(interpolateCount(10, 50, 1)).toBe(50);
    expect(interpolateCount(10, 50, 1.5)).toBe(50);
    // Cubic ease-out at 0.5 is 1 - 0.125 = 0.875 => 10 + 40 * 0.875 = 45
    expect(interpolateCount(10, 50, 0.5)).toBe(45);
  });
});

describe("measurePillRect", () => {
  it("computes coordinates relative to the container and sets opacity to 1", () => {
    expect(
      measurePillRect({ top: 100, left: 20 }, { top: 148, left: 30, width: 208, height: 36 }),
    ).toEqual({ top: 48, left: 10, width: 208, height: 36, opacity: 1 });
  });
});

describe("reduced motion helpers", () => {
  it("returns false when matchMedia is unavailable and reads matches when present", () => {
    delete (globalThis as { matchMedia?: typeof matchMedia }).matchMedia;
    expect(prefersReducedMotion()).toBe(false);

    mockMatchMedia(true);
    expect(prefersReducedMotion()).toBe(true);
  });

  it("subscribes to matchMedia changes and unsubscribes cleanly", () => {
    const mock = mockMatchMedia(false);
    const seen: boolean[] = [];
    const off = subscribeReducedMotion((reduced) => seen.push(reduced));
    expect(mock.listenerCount()).toBe(1);

    mock.fire(true);
    mock.fire(false);
    expect(seen).toEqual([true, false]);

    off();
    expect(mock.listenerCount()).toBe(0);
  });
});

describe("startCountUp", () => {
  it("jumps immediately to target when reduced motion is enabled or duration is zero", () => {
    const values: number[] = [];
    const requestFrame = vi.fn(() => 1);
    const cancelFrame = vi.fn();

    startCountUp({
      from: 0,
      to: 42,
      durationMs: 400,
      reducedMotion: true,
      now: () => 0,
      requestFrame,
      cancelFrame,
      onValue: (v) => values.push(v),
    });
    startCountUp({
      from: 0,
      to: 15,
      durationMs: 0,
      reducedMotion: false,
      now: () => 0,
      requestFrame,
      cancelFrame,
      onValue: (v) => values.push(v),
    });

    expect(values).toEqual([42, 15]);
    expect(requestFrame).not.toHaveBeenCalled();
  });

  it("interpolates frames toward target and cancels pending frame on cleanup", () => {
    let time = 1000;
    let nextId = 1;
    const queue: Array<(ts: number) => void> = [];
    const values: number[] = [];
    const cancelFrame = vi.fn();

    const stop = startCountUp({
      from: 0,
      to: 100,
      durationMs: 400,
      reducedMotion: false,
      now: () => time,
      requestFrame: (cb) => {
        queue.push(cb);
        return nextId++;
      },
      cancelFrame,
      onValue: (v) => values.push(v),
    });

    expect(queue).toHaveLength(1);
    time = 1200;
    queue.shift()!(1200);
    expect(values.at(-1)).toBe(88);
    expect(queue).toHaveLength(1);

    stop();
    expect(cancelFrame).toHaveBeenCalledWith(2);

    // A fresh animation completes cleanly at durationMs.
    const doneValues: number[] = [];
    const doneQueue: Array<(ts: number) => void> = [];
    time = 2000;
    startCountUp({
      from: 0,
      to: 25,
      durationMs: 200,
      reducedMotion: false,
      now: () => time,
      requestFrame: (cb) => {
        doneQueue.push(cb);
        return doneQueue.length;
      },
      cancelFrame,
      onValue: (v) => doneValues.push(v),
    });
    time = 2250;
    doneQueue.shift()!(2250);
    expect(doneValues).toEqual([25]);
    expect(doneQueue).toHaveLength(0);
  });
});

describe("React motion hooks in initial render", () => {
  it("renders initial count and reduced-motion state without errors", () => {
    mockMatchMedia(true);
    function Sample() {
      const reduced = usePrefersReducedMotion();
      const count = useCountUp(24);
      const pill = useSlidingPill();
      return createElement("div", {
        "data-reduced": String(reduced),
        "data-count": String(count),
        "data-pill-opacity": String(pill.pillStyle.opacity),
      });
    }
    const html = renderToStaticMarkup(createElement(Sample));
    expect(html).toContain('data-reduced="true"');
    expect(html).toContain('data-count="24"');
    expect(html).toContain(`data-pill-opacity="${HIDDEN_PILL.opacity}"`);
  });
});
