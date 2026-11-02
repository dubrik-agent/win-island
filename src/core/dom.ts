export type Child = Node | string | number | null | undefined | false;

/** Tiny DOM helper — keeps widget code readable without a framework. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

/** Parses a trusted static SVG string into an element. */
export function icon(markup: string): SVGElement {
  const wrap = document.createElement("div");
  wrap.innerHTML = markup.trim();
  const svg = wrap.firstElementChild;
  if (!(svg instanceof SVGElement)) throw new Error("bad icon markup");
  return svg;
}

export function fmtTime(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function fmtBytes(bytes: number): string {
  if (!bytes) return "0 ГБ";
  const gb = bytes / 1024 ** 3;
  return gb >= 10 ? `${gb.toFixed(0)} ГБ` : `${gb.toFixed(1)} ГБ`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export type Debounced<T extends unknown[]> = ((...args: T) => void) & {
  /** Run the pending call right now (unmount, window close). */
  flush: () => void;
  /** Drop the pending call without running it. */
  cancel: () => void;
};

/**
 * Trailing debounce with an escape hatch. Editors save 350 ms after the last
 * keystroke; without `flush()` a quit or a disabled widget would throw that
 * last edit away.
 */
export function debounce<T extends unknown[]>(
  fn: (...args: T) => void,
  ms: number,
): Debounced<T> {
  let timer: number | undefined;
  let pending: T | null = null;
  const run = (): void => {
    timer = undefined;
    if (!pending) return;
    const args = pending;
    pending = null;
    fn(...args);
  };
  const debounced = ((...args: T) => {
    pending = args;
    window.clearTimeout(timer);
    timer = window.setTimeout(run, ms);
  }) as Debounced<T>;
  debounced.flush = () => {
    window.clearTimeout(timer);
    run();
  };
  debounced.cancel = () => {
    window.clearTimeout(timer);
    timer = undefined;
    pending = null;
  };
  return debounced;
}
