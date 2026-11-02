import { h } from "./dom";
import type { SettingsStore } from "./settings-store";
import { playSound } from "./sound";

export interface AlarmItem {
  id: string;
  text: string;
  /** HH:MM the reminder was set for. */
  time?: string;
}

export interface AlarmHooks {
  /** Show the panel so the alarm is visible even while collapsed. */
  expand: () => void;
  /** Un-hide the native window if auto-hide or the hotkey hid it. */
  show: () => void;
  requestResize: () => void;
  /** Keep the panel open while the alarm is waiting for a click. */
  hold: (held: boolean) => void;
}

const BELL_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 1 0-12 0c0 6-2.2 7.2-2.2 7.2h16.4S18 14 18 8"/><path d="M10.4 20a2 2 0 0 0 3.2 0"/></svg>`;

const REPEAT_MS = 4000;

/**
 * Reminder alarms live outside the widget: they must survive a tab switch, a
 * collapse or a hidden window. The sound repeats — and the panel refuses to
 * collapse — until the user presses «Остановить».
 */
export class AlarmCenter {
  private items: AlarmItem[] = [];
  private timer = 0;
  private off: () => void;

  constructor(
    private readonly host: HTMLElement,
    private readonly settings: SettingsStore,
    private readonly hooks: AlarmHooks,
  ) {
    this.off = settings.subscribe(() => this.syncMode());
    this.syncMode();
  }

  get active(): boolean {
    return this.items.length > 0;
  }

  /** Register a fired reminder and start ringing. */
  trigger(item: AlarmItem): void {
    // The same reminder can only be pending once.
    this.items = this.items.filter((entry) => entry.id !== item.id).concat(item);
    this.paint();
    this.hooks.expand();
    this.hooks.show();
    this.syncMode();
    this.syncHold();
    this.ring();
    this.hooks.requestResize();
  }

  /** Explicit user action: silence this alarm and show the next one, if any. */
  stop(id: string): void {
    const before = this.items.length;
    this.items = this.items.filter((entry) => entry.id !== id);
    if (this.items.length === before) return;
    this.paint();
    this.syncMode();
    this.syncHold();
    this.hooks.requestResize();
    if (this.items.length) this.ring();
  }

  stopAll(): void {
    if (this.items.length === 0) return;
    this.items = [];
    this.paint();
    this.syncMode();
    this.syncHold();
    this.hooks.requestResize();
  }

  dispose(): void {
    this.off();
    this.clearTimer();
  }

  private syncMode(): void {
    if (!this.settings.value.reminderAlarm) {
      this.clearTimer();
      this.syncHold();
    } else if (this.items.length && !this.timer) {
      this.startTimer();
    }
  }

  private syncHold(): void {
    // Only a looping alarm keeps the panel pinned open; a single chime must
    // not block the island for the rest of the day.
    this.hooks.hold(this.items.length > 0 && this.settings.value.reminderAlarm);
  }

  private ring(): void {
    if (this.items.length === 0) return;
    const s = this.settings.value;
    void playSound(s.reminderSound, s.reminderVolume);
  }

  private startTimer(): void {
    this.clearTimer();
    this.timer = window.setInterval(() => {
      if (!this.settings.value.reminderAlarm || this.items.length === 0) {
        this.clearTimer();
        return;
      }
      this.ring();
    }, REPEAT_MS);
  }

  private clearTimer(): void {
    if (!this.timer) return;
    window.clearInterval(this.timer);
    this.timer = 0;
  }

  private paint(): void {
    if (this.items.length === 0) {
      this.host.hidden = true;
      this.host.replaceChildren();
      return;
    }

    const [item, ...rest] = this.items;
    const icon = h("span", "alarm-icon");
    icon.innerHTML = BELL_ICON;
    icon.setAttribute("aria-hidden", "true");

    const title = h("div", "alarm-title", item.time ? `Напоминание · ${item.time}` : "Напоминание");
    if (rest.length > 0) title.append(h("span", "alarm-more", `+${rest.length}`));
    const body = h(
      "div",
      "alarm-body",
      title,
      h("div", "alarm-text", item.text || "Без текста"),
    );

    const stop = h("button", "alarm-stop") as HTMLButtonElement;
    stop.type = "button";
    stop.textContent = "Остановить";
    stop.title = rest.length ? "Остановить это напоминание" : "Остановить";
    stop.addEventListener("click", () => this.stop(item.id));

    this.host.replaceChildren(h("div", "alarm-bar", icon, body, stop));
    this.host.hidden = false;
  }
}
