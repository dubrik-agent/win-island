import { fmtTime, h, icon } from "../core/dom";
import type { WidgetDef } from "../core/widget-types";

const R = 64;
const CIRC = 2 * Math.PI * R;

/** One minute: the floor for presets that would go below zero, and for reset. */
const MIN_MS = 60_000;
/** 99:59 — the most four digits can express. */
const MAX_MS = (99 * 60 + 59) * 1000;

const clampMs = (ms: number): number => Math.min(MAX_MS, Math.max(0, ms));

/**
 * Four digits are read as `MMSS`: the value fills from the right like a digital
 * clock, so `0045` is 45 seconds, `145` is 1:45 and `7355` is 73:55. Seconds
 * above 59 are clamped instead of rejected (`5574` → `55:59`).
 */
function formatDigits(digits: string): string {
  const padded = digits.padStart(4, "0").slice(-4);
  const mm = padded.slice(0, 2);
  const ss = String(Math.min(59, Number(padded.slice(2)))).padStart(2, "0");
  return `${mm}:${ss}`;
}

function msFromDigits(digits: string): number {
  const padded = digits.padStart(4, "0").slice(-4);
  const mm = Number(padded.slice(0, 2));
  const ss = Math.min(59, Number(padded.slice(2)));
  return clampMs((mm * 60 + ss) * 1000);
}

function toDigits(ms: number): string {
  const totalSeconds = Math.round(clampMs(ms) / 1000);
  const mm = Math.min(99, Math.floor(totalSeconds / 60));
  const ss = totalSeconds % 60;
  return `${String(mm).padStart(2, "0")}${String(ss).padStart(2, "0")}`;
}

export const timerWidget: WidgetDef = {
  id: "timer",
  name: "Таймер",
  defaultEnabled: true,
  miniPriority: 10,
  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2"/><path d="M9 2h6"/></svg>`,
  mount(root, ctx) {
    // Starts empty: the first preset press sets the time instead of adding to
    // a value the user never asked for.
    let totalMs = 0;
    let remainingMs = 0;
    let running = false;
    let tick: number | undefined;
    let endAt = 0;
    /** Digits currently typed, without the colon. */
    let typed = "0000";
    /** True while the field holds digits that were typed but not committed. */
    let typedDirty = false;

    const ringFg = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    ringFg.setAttribute("cx", "74");
    ringFg.setAttribute("cy", "74");
    ringFg.setAttribute("r", String(R));
    ringFg.setAttribute("fill", "none");
    ringFg.setAttribute("stroke-width", "8");
    ringFg.setAttribute("class", "ring-fg");
    ringFg.style.strokeDasharray = String(CIRC);
    ringFg.style.strokeDashoffset = String(CIRC);

    const ringBg = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    ringBg.setAttribute("cx", "74");
    ringBg.setAttribute("cy", "74");
    ringBg.setAttribute("r", String(R));
    ringBg.setAttribute("fill", "none");
    ringBg.setAttribute("stroke-width", "8");
    ringBg.setAttribute("class", "ring-bg");

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "148");
    svg.setAttribute("height", "148");
    svg.setAttribute("viewBox", "0 0 148 148");
    svg.append(ringBg, ringFg);

    // Four digits, colon inserted automatically. `MM:SS`, seconds ≤ 59.
    const value = h("input", "timer-input") as HTMLInputElement;
    value.type = "text";
    value.inputMode = "numeric";
    value.autocomplete = "off";
    value.spellcheck = false;
    value.value = fmtTime(0);
    value.title = "Введите время: 4 цифры — минуты и секунды (0045 = 45 секунд)";
    value.setAttribute("aria-label", "Время таймера");

    // The "−" that appears while Shift is held, so presets read as subtraction.
    const shiftMark = h("span", "timer-shift", "−");
    shiftMark.setAttribute("aria-hidden", "true");

    const ring = h("div", "timer-ring");
    ring.append(svg, shiftMark, value);

    const presets = h("div", "timer-presets");
    for (const minutes of [1, 5, 10, 25]) {
      const btn = h("button", "btn ghost", `${minutes} мин`) as HTMLButtonElement;
      btn.type = "button";
      btn.dataset.minutes = String(minutes);
      btn.addEventListener("click", (event) => addMinutes(event.shiftKey ? -minutes : minutes));
      presets.append(btn);
    }

    const startBtn = h("button", "btn primary", "Старт") as HTMLButtonElement;
    startBtn.type = "button";
    const resetBtn = h(
      "button",
      "btn icon",
      icon(
        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>`,
      ),
    ) as HTMLButtonElement;
    resetBtn.type = "button";
    resetBtn.title = "Сброс к 1:00";
    resetBtn.setAttribute("aria-label", "Сбросить таймер к одной минуте");
    const actions = h("div", "timer-actions", startBtn, resetBtn);

    const wrap = h(
      "div",
      "timer",
      actions,
      ring,
      presets,
      h(
        "div",
        "hint timer-hint",
        "Пресеты прибавляют время, Shift — вычитают. Цифры вводятся как ММ:СС.",
      ),
    );

    startBtn.addEventListener("click", () => {
      // Typed digits must win even if the click did not blur the field first
      // (WebView2 does not always move focus to the button).
      flushInput();
      if (running) {
        pause();
        return;
      }
      if (remainingMs <= 0) remainingMs = totalMs;
      if (remainingMs <= 0) {
        ctx.toast("Сначала задайте время");
        return;
      }
      start();
    });

    resetBtn.addEventListener("click", () => {
      stop();
      totalMs = MIN_MS;
      remainingMs = MIN_MS;
      typed = toDigits(MIN_MS);
      typedDirty = false;
      render();
    });

    const miniText = h("span", "", "");
    let miniAttached = false;

    /**
     * Presets always *add* to what is on the clock; Shift subtracts. Going
     * below zero while idle lands on 1:00 (a timer that cannot be started is
     * useless); while running it simply finishes.
     */
    function addMinutes(minutes: number): void {
      const delta = minutes * 60_000;
      if (running) {
        const next = remainingMs + delta;
        if (next <= 0) {
          finish();
          return;
        }
        totalMs = clampMs(totalMs + delta);
        endAt = performance.now() + next;
        remainingMs = next;
        render();
        return;
      }
      // Presets add to what the user typed, not to a stale clock.
      flushInput();
      const next = clampMs(totalMs + delta);
      totalMs = next <= 0 ? MIN_MS : next;
      remainingMs = totalMs;
      typed = toDigits(totalMs);
      typedDirty = false;
      render();
    }

    /** Only digits reach the field; the colon is ours. */
    function onInput(): void {
      const digits = value.value.replace(/\D/g, "").slice(-4);
      typed = digits.padStart(4, "0");
      typedDirty = true;
      value.value = formatDigits(digits);
    }

    function commitInput(): void {
      const ms = msFromDigits(typed);
      stop();
      totalMs = ms;
      remainingMs = ms;
      typed = toDigits(ms);
      typedDirty = false;
      render();
    }

    /**
     * Apply whatever is in the field. Called from blur/change *and* from every
     * action that reads the clock, so a lost blur event can never leave the
     * timer running with the previous value.
     */
    function flushInput(): void {
      if (typedDirty) commitInput();
    }

    value.addEventListener("focus", () => {
      if (running) pause();
      value.select();
    });
    value.addEventListener("input", onInput);
    value.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        flushInput();
        value.blur();
      } else if (event.key === "Escape") {
        event.preventDefault();
        typed = toDigits(remainingMs);
        typedDirty = false;
        value.value = fmtTime(remainingMs);
        value.blur();
      }
    });
    // `blur` covers a click elsewhere, `change` covers Enter and other
    // commit paths that never take focus away. Both only commit real edits:
    // tabbing through the field must not touch a running or paused timer.
    value.addEventListener("blur", () => flushInput());
    value.addEventListener("change", () => flushInput());

    // Shift turns every preset into subtraction; show it before the click.
    function setShift(next: boolean): void {
      if (wrap.dataset.shift === String(next)) return;
      wrap.dataset.shift = String(next);
    }
    const onShiftDown = (event: KeyboardEvent): void => {
      if (event.key === "Shift") setShift(true);
    };
    const onShiftUp = (event: KeyboardEvent): void => {
      if (event.key === "Shift") setShift(false);
    };
    const onWindowBlur = (): void => setShift(false);
    document.addEventListener("keydown", onShiftDown);
    document.addEventListener("keyup", onShiftUp);
    window.addEventListener("blur", onWindowBlur);

    function render(): void {
      // Never overwrite digits the user is still typing; otherwise the clock
      // must paint even while the field has focus (typed → Старт without a
      // blur used to leave a frozen number on screen).
      if (document.activeElement !== value || !typedDirty) {
        value.value = fmtTime(remainingMs);
      }
      // Keep the digit buffer in step with the clock, so a later blur does not
      // re-commit a stale value (that reset a paused timer to its start time).
      if (!typedDirty) typed = toDigits(remainingMs);
      const progress = totalMs > 0 ? remainingMs / totalMs : 0;
      ringFg.style.strokeDashoffset = String(CIRC * (1 - Math.min(1, Math.max(0, progress))));
      startBtn.textContent = running
        ? "Пауза"
        : remainingMs > 0 && remainingMs < totalMs
          ? "Продолжить"
          : "Старт";
      startBtn.disabled = !running && remainingMs <= 0 && totalMs <= 0;
      // The pill shows a running (or paused) countdown. A finished timer must
      // not leave a frozen "00:00" next to the clock.
      if (running || (remainingMs > 0 && remainingMs < totalMs)) {
        miniText.textContent = fmtTime(remainingMs);
        if (!miniAttached) {
          ctx.setMini(miniText);
          miniAttached = true;
        }
      } else if (miniAttached) {
        ctx.setMini(null);
        miniAttached = false;
      }
    }

    function start(): void {
      if (running) return;
      running = true;
      endAt = performance.now() + remainingMs;
      window.clearInterval(tick);
      tick = window.setInterval(onTick, 200);
      render();
    }

    function pause(): void {
      if (!running) return;
      remainingMs = Math.max(0, endAt - performance.now());
      running = false;
      window.clearInterval(tick);
      render();
    }

    function stop(): void {
      running = false;
      window.clearInterval(tick);
    }

    function finish(): void {
      stop();
      remainingMs = 0;
      render();
      ctx.chime();
      ctx.toast("Таймер завершён");
    }

    function onTick(): void {
      remainingMs = Math.max(0, endAt - performance.now());
      if (remainingMs <= 0) {
        finish();
        return;
      }
      render();
    }

    root.append(wrap);
    wrap.dataset.shift = "false";
    render();

    return {
      unmount: () => {
        stop();
        document.removeEventListener("keydown", onShiftDown);
        document.removeEventListener("keyup", onShiftUp);
        window.removeEventListener("blur", onWindowBlur);
        ctx.setMini(null);
      },
    };
  },
};
