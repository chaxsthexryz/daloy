import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

export interface PillStyle {
  top: number;
  left: number;
  width: number;
  height: number;
  opacity: number;
}

export interface RectLike {
  top: number;
  left: number;
  width: number;
  height: number;
}

export const HIDDEN_PILL: PillStyle = { top: 0, left: 0, width: 0, height: 0, opacity: 0 };

/** Reads the user's prefers-reduced-motion setting safely in both browser and SSR contexts. */
export function prefersReducedMotion(): boolean {
  return typeof globalThis.matchMedia === "function" && globalThis.matchMedia(REDUCED_QUERY).matches;
}

/** Subscribes to changes in prefers-reduced-motion and returns an unsubscribe function. */
export function subscribeReducedMotion(onChange: (reduced: boolean) => void): () => void {
  if (typeof globalThis.matchMedia !== "function") return () => undefined;
  const media = globalThis.matchMedia(REDUCED_QUERY);
  const handler = (event: MediaQueryListEvent) => onChange(event.matches);
  media.addEventListener("change", handler);
  return () => media.removeEventListener("change", handler);
}

/** Cubic ease-out interpolation clamped to [0, 1] and rounded for integer KPI counters. */
export function interpolateCount(from: number, to: number, progress: number): number {
  if (progress <= 0) return from;
  if (progress >= 1) return to;
  const eased = 1 - (1 - progress) ** 3;
  return Math.round(from + (to - from) * eased);
}

/** Computes a sliding pill's position and size relative to its container's bounding box. */
export function measurePillRect(
  containerRect: Pick<RectLike, "top" | "left">,
  itemRect: RectLike,
): PillStyle {
  return {
    top: itemRect.top - containerRect.top,
    left: itemRect.left - containerRect.left,
    width: itemRect.width,
    height: itemRect.height,
    opacity: 1,
  };
}

export interface CountUpOptions {
  from: number;
  to: number;
  durationMs: number;
  reducedMotion: boolean;
  now: () => number;
  requestFrame: (callback: (timestamp: number) => void) => number;
  cancelFrame: (id: number) => void;
  onValue: (value: number) => void;
}

/** Schedules a requestAnimationFrame count-up, or emits the final value immediately under reduced motion. */
export function startCountUp(options: CountUpOptions): () => void {
  const { from, to, durationMs, reducedMotion, now, requestFrame, cancelFrame, onValue } = options;
  if (reducedMotion || durationMs <= 0 || from === to) {
    onValue(to);
    return () => undefined;
  }
  const start = now();
  let frameId = 0;
  let active = true;
  const tick = () => {
    if (!active) return;
    const progress = (now() - start) / durationMs;
    if (progress >= 1) {
      onValue(to);
      return;
    }
    onValue(interpolateCount(from, to, progress));
    frameId = requestFrame(tick);
  };
  frameId = requestFrame(tick);
  return () => {
    active = false;
    cancelFrame(frameId);
  };
}

/** Tracks whether the device prefers reduced motion. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => prefersReducedMotion());
  useEffect(() => {
    setReduced(prefersReducedMotion());
    return subscribeReducedMotion(setReduced);
  }, []);
  return reduced;
}

/** Counts smoothly from the previous value to `target`, snapping immediately under reduced motion. */
export function useCountUp(target: number, durationMs = 420): number {
  const reducedMotion = usePrefersReducedMotion();
  const [value, setValue] = useState(target);
  const currentRef = useRef(target);
  currentRef.current = value;

  useEffect(() => {
    if (reducedMotion || durationMs <= 0 || typeof requestAnimationFrame !== "function") {
      setValue(target);
      return;
    }
    return startCountUp({
      from: currentRef.current,
      to: target,
      durationMs,
      reducedMotion,
      now: () => performance.now(),
      requestFrame: (cb) => requestAnimationFrame(cb),
      cancelFrame: (id) => cancelAnimationFrame(id),
      onValue: setValue,
    });
  }, [target, durationMs, reducedMotion]);

  return reducedMotion ? target : value;
}

/** Tracks the geometry of a sliding hover/focus pill inside a navigation or segmented container. */
export function useSlidingPill<T extends HTMLElement = HTMLElement>(): {
  containerRef: RefObject<T | null>;
  pillStyle: PillStyle;
  onItemEnter: (item: HTMLElement | null) => void;
  onContainerLeave: () => void;
} {
  const containerRef = useRef<T | null>(null);
  const [pillStyle, setPillStyle] = useState<PillStyle>(HIDDEN_PILL);

  const onItemEnter = useCallback((item: HTMLElement | null) => {
    const container = containerRef.current;
    if (!container || !item) return;
    setPillStyle(measurePillRect(container.getBoundingClientRect(), item.getBoundingClientRect()));
  }, []);

  const onContainerLeave = useCallback(() => {
    setPillStyle((prev) => (prev.opacity === 0 ? prev : { ...prev, opacity: 0 }));
  }, []);

  return { containerRef, pillStyle, onItemEnter, onContainerLeave };
}
