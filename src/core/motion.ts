/**
 * The OS switch «Уменьшить движение» (Windows: Параметры → Специальные
 * возможности → Визуальные эффекты) must win over the in-app animation setting:
 * a user who turned it off for motion sickness does not expect an app to
 * override that choice.
 */
const QUERY = "(prefers-reduced-motion: reduce)";

function media(): MediaQueryList | null {
  if (typeof window === "undefined" || !window.matchMedia) return null;
  return window.matchMedia(QUERY);
}

/** True when the system asks for as little motion as possible. */
export function prefersReducedMotion(): boolean {
  return media()?.matches ?? false;
}

/** True when animations should actually run (app setting AND system switch). */
export function motionAllowed(appAnimations: boolean): boolean {
  return appAnimations && !prefersReducedMotion();
}

/** Notify when the system switch changes while the app is running. */
export function onReducedMotionChange(listener: (reduced: boolean) => void): () => void {
  const list = media();
  if (!list) return () => undefined;
  const handler = (event: MediaQueryListEvent): void => listener(event.matches);
  list.addEventListener("change", handler);
  return () => list.removeEventListener("change", handler);
}
