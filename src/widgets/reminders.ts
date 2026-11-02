import { api } from "../core/api";
import { h } from "../core/dom";
import { BUTTON } from "../core/strings";
import type { WidgetDef } from "../core/widget-types";

interface Reminder {
  id: string;
  time: string; // HH:MM
  text: string;
  firedOn?: string; // YYYY-MM-DD
}

const todayKey = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const pad = (n: number): string => String(n).padStart(2, "0");

/**
 * `9`, `930`, `09:30` → `09:30`. Anything that cannot be a time falls back to
 * `fallback`, so the field is never left in a half-typed state.
 */
function normalizeTime(raw: string, fallback: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 4);
  if (!digits) return fallback;
  const padded = digits.padStart(4, "0");
  const hours = Math.min(23, Number(padded.slice(0, 2)));
  const minutes = Math.min(59, Number(padded.slice(2)));
  return `${pad(hours)}:${pad(minutes)}`;
}

export const remindersWidget: WidgetDef = {
  id: "reminders",
  name: "Напоминания",
  defaultEnabled: true,
  miniPriority: 20,
  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 1 0-12 0c0 6-2.2 7.2-2.2 7.2h16.4S18 14 18 8"/><path d="M10.4 20a2 2 0 0 0 3.2 0"/></svg>`,
  mount(root, ctx) {
    let items: Reminder[] = [];
    let loaded = false;

    const timeInput = h("input", "input rem-time-input") as HTMLInputElement;
    // A plain text field instead of `input[type=time]`: WebView2 renders the
    // native picker as a white OS popup that ignores the dark theme.
    timeInput.type = "text";
    timeInput.inputMode = "numeric";
    timeInput.maxLength = 5;
    timeInput.autocomplete = "off";
    timeInput.spellcheck = false;
    timeInput.placeholder = "ЧЧ:ММ";
    timeInput.setAttribute("aria-label", "Время напоминания");
    const soon = new Date(Date.now() + 5 * 60_000);
    const defaultTime = `${pad(soon.getHours())}:${pad(soon.getMinutes())}`;
    timeInput.value = defaultTime;
    timeInput.addEventListener("focus", () => timeInput.select());
    timeInput.addEventListener("blur", () => {
      timeInput.value = normalizeTime(timeInput.value, defaultTime);
    });

    const textInput = h("input", "input") as HTMLInputElement;
    textInput.placeholder = "О чём напомнить?";
    textInput.style.flex = "1 1 auto";
    textInput.setAttribute("aria-label", "Текст напоминания");

    const addBtn = h("button", "btn primary", "＋");
    addBtn.title = "Добавить (Enter)";
    addBtn.setAttribute("aria-label", "Добавить напоминание");

    const addRow = h("div", "rem-add", timeInput, textInput, addBtn);
    const list = h("div", "rem-list");
    const mini = h("span", "", "");
    let miniAttached = false;

    const save = (): void => {
      void api.writeStore("reminders", items);
      renderMini();
    };

    const renderMini = (): void => {
      const upcoming = items
        .filter((item) => item.firedOn !== todayKey())
        .sort((a, b) => a.time.localeCompare(b.time))[0];
      if (!upcoming) {
        if (miniAttached) {
          ctx.setMini(null);
          miniAttached = false;
        }
        return;
      }
      mini.textContent = upcoming.time;
      if (!miniAttached) {
        ctx.setMini(mini);
        miniAttached = true;
      }
    };

    const renderList = (): void => {
      list.replaceChildren();
      const sorted = [...items].sort((a, b) => a.time.localeCompare(b.time));
      if (sorted.length === 0) {
        list.append(h("div", "empty", "Напоминаний пока нет"));
      }
      for (const item of sorted) {
        const isDue = item.firedOn === todayKey();
        const del = h("button", "rem-del");
        del.title = BUTTON.delete;
        del.setAttribute("aria-label", `Удалить напоминание «${item.text}»`);
        del.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
        del.addEventListener("click", () => {
          items = items.filter((x) => x.id !== item.id);
          save();
          renderList();
          ctx.requestResize();
        });

        const row = h(
          "div",
          `rem-item${isDue ? " due" : ""}`,
          h("span", "rem-time", item.time),
          h("span", "rem-text", item.text),
          del,
        );
        list.append(row);
      }
      renderMini();
      ctx.requestResize();
    };

    const add = (): void => {
      const time = normalizeTime(timeInput.value, defaultTime);
      timeInput.value = time;
      const text = textInput.value.trim();
      if (!time || !text) return;
      items.push({ id: crypto.randomUUID(), time, text });
      textInput.value = "";
      save();
      renderList();
    };

    addBtn.addEventListener("click", add);
    textInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") add();
    });

    const tick = window.setInterval(() => {
      if (!loaded) return;
      const now = new Date();
      const current = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
      let changed = false;
      for (const item of items) {
        if (item.time === current && item.firedOn !== todayKey()) {
          item.firedOn = todayKey();
          changed = true;
          // A persistent alarm: it rings and keeps the panel open until the
          // user presses «Остановить» in the banner above the tabs.
          ctx.alarm({ id: item.id, text: item.text, time: item.time });
        }
      }
      if (changed) {
        save();
        renderList();
      }
    }, 1000);

    void api.readStore<Reminder[]>("reminders").then((saved) => {
      items = Array.isArray(saved) ? saved : [];
      loaded = true;
      renderList();
    });

    root.append(addRow, list);
    renderList();

    return {
      unmount: () => {
        window.clearInterval(tick);
        if (miniAttached) ctx.setMini(null);
      },
    };
  },
};
