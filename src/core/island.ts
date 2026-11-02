import { api } from "./api";
import { escapeTopLayer } from "./escape";
import { motionAllowed, onReducedMotionChange } from "./motion";
import { playUiSound } from "./sound";
import type { SettingsStore } from "./settings-store";

const STAGE_PAD = 24;
const BOTTOM_PAD = 20;

/** The clickable island rectangle in viewport CSS px. */
interface HitRect {
  x: number;
  y: number;
  w: number;
  h: number;
  radius: number;
}

/** Keep user-provided geometry inside sane bounds. */
const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/**
 * The single morphing surface. Everything (line/pill ↔ panel) animates inside
 * one element; the native window is resized to match so clicks never land on a
 * huge invisible rectangle.
 */
export class Island {
  expanded = false;
  private held = false;
  private hoverTimer = 0;
  private leaveTimer = 0;
  private shrinkTimer = 0;
  private resizeRaf = 0;
  private refreshTimer = 0;
  private hitSender: ((force?: boolean) => void) | null = null;
  private lastBounds = "";
  /** Signature of the settings `apply()` already painted. */
  private appliedKey = "";
  private appliedTheme = "";
  private resizeTimer = 0;
  /** No shell re-measure until this timestamp: the morph is still in flight. */
  private morphUntil = 0;
  /**
   * While the panel morphs, the native region must cover the *final* rectangle:
   * `SetWindowRgn` clips painting too, so a region that follows the animated
   * size in small steps visibly chops the panel mid-flight (that was the
   * "broken" animation). One big region at the start, one exact region at the
   * end — nothing in between.
   */
  private animRect: HitRect | null = null;
  private animUntil = 0;
  private animClear = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly panel: HTMLElement,
    private readonly settings: SettingsStore,
    private readonly hooks: { onExpandChange?: (expanded: boolean) => void } = {},
  ) {
    this.bind();
    this.settings.subscribe((s) => this.apply(s));
    this.apply(this.settings.value);
    // The OS motion switch can flip while the app runs.
    onReducedMotionChange(() => this.apply(undefined, true));
  }

  /** Collapsed shape: a thin line (default) or the classic pill. */
  private get mode(): "line" | "pill" {
    return this.settings.value.collapsedMode === "pill" ? "pill" : "line";
  }

  /** Height of the header row (clock, mini indicators). */
  private headHeight(): number {
    return clamp(this.settings.value.pillHeight, 26, 48);
  }

  private panelWidth(): number {
    return clamp(this.settings.value.panelWidth, 340, 620);
  }

  /**
   * Layout height that still fits the monitor work area. The island is drawn
   * with `transform: scale()`, so the layout budget grows as the scale drops.
   */
  private availableHeight(): number {
    const scale = clamp(this.settings.value.scale || 1, 0.5, 2);
    const top = window.screenY || 0;
    const avail = (window.screen.availHeight || 800) - top;
    return Math.max(240, avail / scale);
  }

  /** `#panel` never gets taller than this (layout px), the rest scrolls. */
  private panelMaxHeight(): number {
    return Math.max(160, this.availableHeight() - this.headHeight() - 16);
  }

  private collapsedSize(): { w: number; h: number } {
    const s = this.settings.value;
    if (this.mode === "line") {
      return {
        w: clamp(s.lineWidth, 60, 320),
        h: clamp(s.lineHeight, 3, 18),
      };
    }
    return {
      w: clamp(s.pillWidth, 160, 360),
      h: clamp(s.pillHeight, 26, 48),
    };
  }

  private bind(): void {
    this.watchHitRect();

    // Work area / DPI changes (taskbar, monitor switch) must re-fit the panel
    // *and* the native region; `apply()` alone keeps the stale bounds cache.
    window.addEventListener("resize", () => this.refresh());
    // Coming back from sleep the window can be on a screen that no longer
    // exists; the webview becomes visible again at that point.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.refresh();
    });

    this.root.addEventListener("mouseenter", () => {
      window.clearTimeout(this.leaveTimer);
      const s = this.settings.value;
      if (s.expandTrigger === "click") return;
      window.clearTimeout(this.hoverTimer);
      this.hoverTimer = window.setTimeout(() => this.expand(), s.hoverDelayMs);
    });

    this.root.addEventListener("mouseleave", () => {
      window.clearTimeout(this.hoverTimer);
      this.leaveTimer = window.setTimeout(() => {
        if (!this.root.matches(":hover")) this.collapse();
      }, 420);
    });

    this.root.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      if (!target.closest("#pill")) return;
      if (target.closest("button.tab") || target.closest(".mini")) return;
      const s = this.settings.value;
      if (s.expandTrigger === "hover") return;
      event.stopPropagation();
      this.toggle();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !this.expanded) return;
      // An inline editor or the hotkey recorder already consumed this Esc;
      // a registered layer (popover) gets the next chance. Only when nobody
      // wants the key does the island collapse.
      if (event.defaultPrevented || escapeTopLayer()) return;
      this.collapse();
    });

    document.getElementById("stage")?.addEventListener("mousedown", (event) => {
      if (event.target === document.getElementById("stage") && this.expanded) this.collapse();
    });

    document.getElementById("pill-expand")?.addEventListener("click", (event) => {
      event.stopPropagation();
      this.toggle();
    });
  }

  /** Feed the island rect to the native window so margins pass clicks through. */
  private watchHitRect(): void {
    if (!api.available) return;
    let timer = 0;
    let lastKey = "";
    const send = (force = false): void => {
      timer = 0;
      const rect = this.currentHitRect();
      const key = [
        Math.round(rect.x),
        Math.round(rect.y),
        Math.round(rect.w),
        Math.round(rect.h),
        Math.round(rect.radius),
      ].join(",");
      // A DPI change keeps the CSS rect but needs a new physical region.
      if (!force && key === lastKey) return;
      lastKey = key;
      void api
        .setHitRect(rect.x, rect.y, rect.w, rect.h, rect.radius)
        .catch(() => undefined);
    };
    this.hitSender = send;
    // One update per 60 ms was a main-thread round trip per frame and made the
    // morph stutter; now the region is sent when the layout actually settles.
    const schedule = (): void => {
      if (timer) return;
      timer = window.setTimeout(send, 60);
    };
    new ResizeObserver(schedule).observe(this.root);
    window.addEventListener("resize", schedule);
    send();
  }

  /** Rect the OS should treat as the island right now. */
  private currentHitRect(): HitRect {
    if (this.animRect && performance.now() < this.animUntil) return this.animRect;
    const s = this.settings.value;
    const scale = clamp(s.scale || 1, 0.5, 2);
    const live = this.root.getBoundingClientRect();
    return {
      x: live.left,
      y: live.top,
      w: live.width,
      h: live.height,
      radius: this.expanded
        ? clamp(s.panelRadius, 0, 36) * scale
        : Math.min(live.width, live.height) / 2,
    };
  }

  /** Width of the native window after `syncBounds` grows it for `width` CSS px. */
  private viewportWidthFor(width: number): number {
    const scale = clamp(this.settings.value.scale || 1, 0.5, 2);
    return Math.ceil(width * Math.max(1, scale)) + STAGE_PAD * 2;
  }

  /**
   * Hold the region at `rect` until the CSS transition ends. The island is
   * centred horizontally and pinned to the top edge of its window, so the final
   * rectangle can be computed before the window finishes resizing.
   */
  private animateRegion(rect: HitRect, duration: number): void {
    window.clearTimeout(this.animClear);
    this.animRect = rect;
    this.animUntil = performance.now() + duration;
    this.hitSender?.(true);
    this.animClear = window.setTimeout(() => {
      this.animRect = null;
      this.hitSender?.(true);
    }, duration + 60);
  }

  /** Final rectangle of the open panel (used while it grows). */
  private expandedHitRect(): HitRect {
    const s = this.settings.value;
    const scale = clamp(s.scale || 1, 0.5, 2);
    const width = this.panelWidth();
    const w = width * scale;
    const h = this.targetHeight() * scale;
    return {
      x: this.viewportWidthFor(width) / 2 - w / 2,
      y: this.root.getBoundingClientRect().top,
      w,
      h,
      radius: clamp(s.panelRadius, 0, 36) * scale,
    };
  }

  private animDuration(): number {
    return motionAllowed(this.settings.value.animations)
      ? this.settings.value.animationMs
      : 0;
  }

  apply(s = this.settings.value, force = false): void {
    // `patch()` fires on every slider frame; repainting fifteen custom
    // properties (and re-laying out the panel) for a value the island does not
    // even use is what made dragging feel heavy.
    const key = [
      s.theme,
      s.accent,
      s.opacity,
      s.scale,
      s.shadow,
      s.animations,
      s.animationMs,
      s.collapsedMode,
      s.lineWidth,
      s.lineHeight,
      s.pillWidth,
      s.pillHeight,
      s.panelWidth,
      s.panelRadius,
    ].join("|");
    if (!force && key === this.appliedKey) {
      void this.syncBounds();
      return;
    }
    this.appliedKey = key;

    this.root.dataset.theme = s.theme;
    // Mirror to localStorage for the pre-paint script in index.html.
    if (this.appliedTheme !== s.theme || force) {
      this.appliedTheme = s.theme;
      try {
        localStorage.setItem("wi.theme", s.theme);
        localStorage.setItem("wi.accent", s.accent);
      } catch {
        /* private mode */
      }
    }
    // Light-toned themes share the neutral "ink on paper" overrides; the
    // palette itself comes from the per-theme variable block in the CSS.
    const light = s.theme === "light" || s.theme === "sand";
    this.root.dataset.tone = light ? "light" : "dark";
    // Native form controls (selects, sliders) follow the app theme too.
    document.documentElement.style.colorScheme = light ? "light" : "dark";
    this.root.dataset.mode = this.mode;
    // Shadow off means no extra padding around the native region either.
    this.root.dataset.shadow = s.shadow ? "on" : "off";
    // The system «уменьшить движение» switch overrides the app setting.
    this.root.dataset.anim = motionAllowed(s.animations) ? "on" : "off";
    this.root.style.setProperty(
      "--anim",
      motionAllowed(s.animations) ? `${s.animationMs}ms` : "0ms",
    );
    this.root.style.setProperty("--accent", s.accent);
    this.root.style.setProperty("--head-h", `${this.headHeight()}px`);
    this.root.style.setProperty("--panel-w", `${this.panelWidth()}px`);
    this.root.style.setProperty("--r-collapsed", `${this.collapsedSize().h / 2}px`);
    this.root.style.setProperty("--r-expanded", `${clamp(s.panelRadius, 0, 36)}px`);
    this.root.style.setProperty("--panel-max", `${Math.round(this.panelMaxHeight())}px`);
    this.root.style.transform = `scale(${s.scale})`;
    this.root.style.transformOrigin = "top center";
    this.root.style.background = surfaceFor(s);

    if (!this.expanded) {
      const { w, h } = this.collapsedSize();
      this.root.style.width = `${w}px`;
      this.root.style.height = `${h}px`;
    } else {
      // Scale / width / screen changes must re-fit the open panel too.
      this.root.style.width = `${this.panelWidth()}px`;
      this.root.style.height = `${this.targetHeight()}px`;
    }
    void this.syncBounds();
  }

  expand(): void {
    window.clearTimeout(this.hoverTimer);
    window.clearTimeout(this.leaveTimer);
    window.clearTimeout(this.shrinkTimer);
    if (this.expanded) return;
    this.expanded = true;
    const width = this.panelWidth();
    const height = this.targetHeight();
    const duration = this.animDuration();
    this.morphUntil = performance.now() + duration + 40;
    // 1. Grow the native window *first*. Painting the panel into a window that
    //    is still collapsed crops it for a frame or two — that is what made the
    //    morph look torn. The resize resolves in about one frame.
    void this.syncBounds().then(() => {
      if (!this.expanded) return;
      // 2. Then let the CSS transition run inside a window that is already big
      //    enough, and hold the native region at the final rectangle.
      this.root.dataset.state = "expanded";
      this.root.style.width = `${width}px`;
      this.root.style.height = `${height}px`;
      this.animateRegion(this.expandedHitRect(), duration);
      document.getElementById("pill-expand")?.setAttribute("aria-expanded", "true");
    });
    this.hooks.onExpandChange?.(true);
    playUiSound("expand", this.settings.value.uiSounds, this.settings.value.uiSoundVolume);
  }

  collapse(): void {
    window.clearTimeout(this.hoverTimer);
    window.clearTimeout(this.leaveTimer);
    // A ringing alarm pins the panel open until the user stops it.
    if (!this.expanded || this.held) return;
    const duration = this.animDuration();
    this.morphUntil = performance.now() + duration + 40;
    const scale = clamp(this.settings.value.scale || 1, 0.5, 2);
    const live = this.root.getBoundingClientRect();
    // Keep the full panel clickable/clipped-free until it has shrunk.
    this.animateRegion(
      {
        x: live.left,
        y: live.top,
        w: live.width,
        h: live.height,
        radius: clamp(this.settings.value.panelRadius, 0, 36) * scale,
      },
      duration,
    );
    this.expanded = false;
    this.root.dataset.state = "collapsed";
    document.getElementById("pill-expand")?.setAttribute("aria-expanded", "false");
    const { w, h } = this.collapsedSize();
    this.root.style.width = `${w}px`;
    this.root.style.height = `${h}px`;
    this.hooks.onExpandChange?.(false);
    playUiSound("collapse", this.settings.value.uiSounds, this.settings.value.uiSoundVolume);
    const delay = duration + 60;
    window.clearTimeout(this.shrinkTimer);
    this.shrinkTimer = window.setTimeout(() => void this.syncBounds(), delay);
  }

  toggle(): void {
    if (this.expanded) this.collapse();
    else this.expand();
  }

  /** Pin the panel open (a ringing alarm needs an answer). */
  hold(held: boolean): void {
    this.held = held;
  }

  /**
   * The screen layout changed (undock, sleep, Windows scaling) or the system
   * asked us to re-measure: forget every cached size and push the geometry to
   * the native window again, including the rounded region.
   */
  refresh(): void {
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = 0;
      this.lastBounds = "";
      this.appliedKey = "";
      this.apply(undefined, true);
      this.hitSender?.(true);
    }, 120);
  }

  /** Re-measure the active widget and animate height if needed. */
  requestResize(): void {
    if (!this.expanded) return;
    // Several widgets ask for a resize in the same tick (settings rebuild,
    // media rows, notes mode): measure once per frame instead of each time.
    if (this.resizeRaf) return;
    this.resizeRaf = requestAnimationFrame(() => {
      this.resizeRaf = 0;
      if (!this.expanded) return;
      const left = this.morphUntil - performance.now();
      if (left > 0) {
        // The shell is still opening or folding: measuring now would fight the
        // morph and produce a second, stuttering animation.
        window.clearTimeout(this.resizeTimer);
        this.resizeTimer = window.setTimeout(() => this.requestResize(), left + 20);
        return;
      }
      const height = this.targetHeight();
      const before = this.root.getBoundingClientRect();
      // Widgets ask for a resize on every content change; most of them do not
      // change the panel height at all. Re-setting the same window region costs
      // a synchronous native call, so skip it.
      if (Math.abs(height - before.height) < 0.5) return;
      this.root.style.height = `${height}px`;
      const after = this.expandedHitRect();
      const duration = this.animDuration();
      if (after.h >= before.height) {
        // Growing: the window must be big before the panel is drawn.
        void this.syncBounds();
        this.animateRegion(after, duration);
      } else {
        // Shrinking: the window stays big until the CSS transition is over,
        // otherwise it would crop the panel from the bottom mid-flight.
        this.animateRegion(
          {
            x: before.left,
            y: before.top,
            w: before.width,
            h: before.height,
            radius: after.radius,
          },
          duration,
        );
        window.clearTimeout(this.shrinkTimer);
        this.shrinkTimer = window.setTimeout(() => void this.syncBounds(), duration + 60);
      }
    });
  }

  private targetHeight(): number {
    return this.headHeight() + Math.min(this.panel.offsetHeight, this.panelMaxHeight());
  }

  private async syncBounds(): Promise<void> {
    const s = this.settings.value;
    const collapsed = this.collapsedSize();
    const w = this.expanded ? this.panelWidth() : collapsed.w;
    const h = this.expanded ? this.targetHeight() : collapsed.h;
    const key = `${s.scale}:${w}:${h}`;
    if (key === this.lastBounds) return;
    this.lastBounds = key;
    // The island is drawn with a CSS scale, so its *layout* box keeps the
    // unscaled width: below 100 % the panel must still fit the viewport,
    // above 100 % the visual box is the bigger one.
    const width = Math.ceil(w * Math.max(1, s.scale)) + STAGE_PAD * 2;
    const height = Math.ceil(h * s.scale) + BOTTOM_PAD;
    await api.setBounds(width, height).catch(() => undefined);
  }
}

function surfaceFor(s: { theme: string; opacity: number }): string {
  // Every named theme paints an opaque surface: text over a see-through panel
  // was unreadable. Transparency is a feature of the glass theme only.
  if (s.theme === "dark") return "rgb(9, 9, 11)";
  if (s.theme === "light") return "rgb(250, 250, 252)";
  if (s.theme === "midnight") return "rgb(11, 13, 22)";
  if (s.theme === "sand") return "rgb(243, 238, 228)";
  return `rgba(11, 11, 14, ${s.opacity.toFixed(2)})`;
}
