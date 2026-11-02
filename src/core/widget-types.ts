import type { SettingsStore } from "./settings-store";

export interface WidgetContext {
  settings: SettingsStore;
  /** Short message above the island (does not steal focus). */
  toast: (message: string) => void;
  /** Compact representation shown inside the collapsed pill. Pass null to clear. */
  setMini: (node: HTMLElement | null) => void;
  /** Expand the island (optionally switching to another widget). */
  expand: () => void;
  collapse: () => void;
  /** Ask the host to re-measure and animate the panel height. */
  requestResize: () => void;
  chime: () => void;
  /** Persistent alarm: rings until the user presses «Остановить». */
  alarm: (item: { id: string; text: string; time?: string }) => void;
}

export interface WidgetHooks {
  onShow?: () => void;
  onHide?: () => void;
  /** The island collapsed: stop animation loops, the widget stays mounted. */
  onCollapse?: () => void;
  /** The island expanded again and this widget is the active one. */
  onExpand?: () => void;
  unmount?: () => void;
}

export interface WidgetDef {
  id: string;
  name: string;
  /** Trusted inline SVG markup, 24x24 stroke icon. */
  icon: string;
  defaultEnabled?: boolean;
  /** Settings widget and similar cannot be disabled. */
  alwaysEnabled?: boolean;
  /** Lower numbers win the limited space inside the collapsed pill. */
  miniPriority?: number;
  mount: (root: HTMLElement, ctx: WidgetContext) => WidgetHooks | void;
}

export interface WidgetState {
  enabled: string[];
  active: string;
  /** User-defined tab order (widget ids). Missing ids keep their default place. */
  order?: string[];
}
