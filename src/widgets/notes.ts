import { api } from "../core/api";
import { debounce, h } from "../core/dom";
import { plural } from "../core/strings";
import type { WidgetDef } from "../core/widget-types";

interface NoteItem {
  id: string;
  text: string;
  done: boolean;
}

interface NotesData {
  /** Free-form page. Completely independent from the checklist. */
  text?: string;
  items?: NoteItem[];
  /** "list" — чек-лист, "text" — обычный текст. */
  mode?: NotesMode;
}

type NotesMode = "list" | "text";

const CHECK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;
const TRASH_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M6 7h12M10 7V5h4v2M8 7l1 13h6l1-13"/></svg>`;

function newId(): string {
  return `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeItems(data: NotesData | null): NoteItem[] {
  if (!data?.items?.length) return [];
  return data.items
    .filter((item) => typeof item?.text === "string")
    .map((item) => ({
      id: typeof item.id === "string" && item.id ? item.id : newId(),
      text: item.text,
      done: Boolean(item.done),
    }));
}

export const notesWidget: WidgetDef = {
  id: "notes",
  name: "Заметки",
  defaultEnabled: true,
  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 12h6M9 16h4"/></svg>`,
  mount(root, ctx) {
    const list = h("div", "notes-list");
    const counter = h("span", "", "0 пунктов");
    const savedAt = h("span", "", "");
    const meta = h("div", "notes-meta", counter, savedAt);
    const addBtn = h("button", "notes-add", "+ Новый пункт") as HTMLButtonElement;
    addBtn.type = "button";

    // Two ways to write: a checklist or a plain text page. They are stored
    // separately — editing one never rewrites the other.
    const modeList = h("button", "notes-tab", "Список") as HTMLButtonElement;
    const modeText = h("button", "notes-tab", "Текст") as HTMLButtonElement;
    for (const btn of [modeList, modeText]) {
      btn.type = "button";
      btn.setAttribute("aria-pressed", "false");
    }
    const modeBar = h("div", "notes-mode", modeList, modeText);

    const clearBtn = h("button", "notes-clear") as HTMLButtonElement;
    clearBtn.type = "button";
    clearBtn.innerHTML = `${TRASH_ICON}<span>Очистить</span>`;

    const actions = h("div", "notes-actions", addBtn, clearBtn);
    const wrap = h("div", "notes", modeBar, list, meta, actions);
    const mini = h("span", "");

    let items: NoteItem[] = [];
    let text = "";
    let miniText = "";
    let mode: NotesMode = "list";
    /** Shift turns the clear button into "delete everything" and paints it red. */
    let shiftHeld = false;

    const persist = debounce(() => {
      const clean = items
        .filter((item) => item.text.trim().length > 0 || item.done)
        .map((item) => ({ ...item, text: item.text.trim() }));
      void api.writeStore("notes", { items: clean, text, mode } satisfies NotesData);
      const now = new Date();
      savedAt.textContent = `Сохранено в ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      updateMini();
    }, 350);

    function updateMini(): void {
      const filled = items.filter((item) => item.text.trim().length > 0);
      if (mode === "text") {
        const lines = text.split("\n").filter((line) => line.trim().length > 0).length;
        counter.textContent =
          lines === 0 ? "Пусто" : `${lines} ${plural(lines, "строка", "строки", "строк")}`;
      } else {
        const done = items.filter((item) => item.done).length;
        const total = filled.length;
        counter.textContent =
          total === 0
            ? "Пусто"
            : done === 0
              ? `${total} ${plural(total, "пункт", "пункта", "пунктов")}`
              : `${done} из ${total} готово`;
      }

      updateClearState();

      const next =
        mode === "text"
          ? text.split("\n").find((line) => line.trim().length > 0) ?? ""
          : filled.find((item) => !item.done)?.text ?? "";
      const clipped = next.trim().slice(0, 16);
      if (clipped === miniText) return;
      miniText = clipped;
      if (!clipped) {
        ctx.setMini(null);
      } else {
        mini.textContent = clipped;
        ctx.setMini(mini);
      }
    }

    /** Label, disabled state and the red "delete all" look follow Shift. */
    function updateClearState(): void {
      if (mode === "text") {
        clearBtn.classList.toggle("danger", shiftHeld && text.length > 0);
        clearBtn.disabled = text.length === 0;
        clearBtn.title = "Очистить текст";
        clearBtn.querySelector("span")!.textContent = "Очистить";
        return;
      }
      const done = items.filter((item) => item.done).length;
      clearBtn.classList.toggle("danger", shiftHeld && items.length > 0);
      clearBtn.disabled = shiftHeld ? items.length === 0 : done === 0;
      clearBtn.title = shiftHeld ? "Удалить все пункты" : "Убрать выполненные";
      clearBtn.querySelector("span")!.textContent = shiftHeld ? "Удалить всё" : "Очистить";
    }

    function setShift(next: boolean): void {
      if (shiftHeld === next) return;
      shiftHeld = next;
      updateClearState();
    }

    // Shift is global here: the button must turn red before the click, so the
    // user sees what will happen.
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

    function grow(area: HTMLTextAreaElement): void {
      // A widget that is not on screen has no layout: `scrollHeight` is 0, and
      // writing that height clipped every note to its border. `onShow` does the
      // measuring once the widget is visible again.
      if (!area.isConnected || area.offsetParent === null) return;
      area.style.height = "auto";
      // `scrollHeight` excludes the border, but the box is border-box sized, so
      // adding it is what keeps a 1–2 px inner scrollbar from appearing.
      const border = area.offsetHeight - area.clientHeight;
      area.style.height = `${area.scrollHeight + border}px`;
    }

    /** Re-measure every field after the widget becomes visible. */
    function growAll(): void {
      for (const area of list.querySelectorAll<HTMLTextAreaElement>("textarea")) grow(area);
    }

    const textArea = h("textarea", "notes-text") as HTMLTextAreaElement;
    textArea.placeholder = "Пишите что угодно — обычный текст, без галочек и пунктов.";
    textArea.spellcheck = true;
    textArea.setAttribute("aria-label", "Текст заметки");
    textArea.addEventListener("input", () => {
      text = textArea.value;
      grow(textArea);
      updateMini();
      persist();
    });
    // Leaving the field is a natural commit point — no reason to keep the
    // write pending for another third of a second.
    textArea.addEventListener("blur", () => persist.flush());

    function setMode(next: NotesMode): void {
      if (next === mode) return;
      mode = next;
      persist();
      render();
      updateMini();
      ctx.requestResize();
    }

    modeList.addEventListener("click", () => setMode("list"));
    modeText.addEventListener("click", () => setMode("text"));

    function focusAtEnd(area: HTMLTextAreaElement): void {
      area.focus();
      const end = area.value.length;
      area.setSelectionRange(end, end);
    }

    function addItem(afterIndex?: number, focus = true): NoteItem {
      const item: NoteItem = { id: newId(), text: "", done: false };
      const index = afterIndex === undefined ? items.length : afterIndex + 1;
      items.splice(index, 0, item);
      render();
      if (focus) {
        const node = list.querySelector<HTMLTextAreaElement>(`[data-id="${item.id}"]`);
        if (node) focusAtEnd(node);
      }
      ctx.requestResize();
      return item;
    }

    function removeItem(id: string): void {
      const index = items.findIndex((item) => item.id === id);
      if (index < 0) return;
      const previous = items[index - 1];
      items.splice(index, 1);
      render();
      const node = previous
        ? list.querySelector<HTMLTextAreaElement>(`[data-id="${previous.id}"]`)
        : null;
      if (node) focusAtEnd(node);
      updateMini();
      persist();
      ctx.requestResize();
    }

    clearBtn.addEventListener("click", (event) => {
      const all = event.shiftKey || shiftHeld;
      if (mode === "text") {
        if (!text) return;
        text = "";
        textArea.value = "";
        textArea.focus();
      } else if (all) {
        if (items.length === 0) return;
        items = [];
        render();
      } else {
        const before = items.length;
        items = items.filter((item) => !item.done);
        if (items.length === before) return;
        render();
      }
      updateMini();
      persist();
      ctx.requestResize();
    });

    function render(): void {
      modeList.classList.toggle("active", mode === "list");
      modeText.classList.toggle("active", mode === "text");
      modeList.setAttribute("aria-pressed", String(mode === "list"));
      modeText.setAttribute("aria-pressed", String(mode === "text"));
      addBtn.hidden = mode === "text";
      list.classList.toggle("notes-list--text", mode === "text");

      list.replaceChildren();
      if (mode === "text") {
        textArea.value = text;
        list.append(textArea);
        // Long notes must show their whole page: the panel scrolls, the field
        // itself never grows an inner scrollbar.
        requestAnimationFrame(() => grow(textArea));
        return;
      }
      if (items.length === 0) {
        list.append(h("div", "notes-empty", "Пока пусто. Добавьте первый пункт — обычный или с галочкой."));
      }
      for (const item of items) {
        const check = h("button", "note-check") as HTMLButtonElement;
        check.type = "button";
        check.innerHTML = CHECK_ICON;
        check.setAttribute("role", "checkbox");
        check.setAttribute("aria-checked", String(item.done));
        check.setAttribute("aria-label", item.done ? "Снять отметку" : "Отметить выполненным");
        check.addEventListener("click", () => {
          item.done = !item.done;
          row.classList.toggle("done", item.done);
          row.dataset.done = String(item.done);
          check.setAttribute("aria-checked", String(item.done));
          check.setAttribute("aria-label", item.done ? "Снять отметку" : "Отметить выполненным");
          updateMini();
          persist();
        });

        const area = h("textarea", "note-text") as HTMLTextAreaElement;
        area.rows = 1;
        area.value = item.text;
        area.dataset.id = item.id;
        area.placeholder = "Пункт…";
        area.spellcheck = false;
        area.setAttribute("aria-label", "Текст пункта");
        area.addEventListener("input", () => {
          item.text = area.value;
          grow(area);
          updateMini();
          persist();
        });
        area.addEventListener("blur", () => persist.flush());
        area.addEventListener("keydown", (event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            addItem(items.findIndex((entry) => entry.id === item.id));
            return;
          }
          if (event.key === "Backspace" && area.value.length === 0) {
            event.preventDefault();
            removeItem(item.id);
          }
        });

        const del = h("button", "note-del") as HTMLButtonElement;
        del.type = "button";
        del.innerHTML = TRASH_ICON;
        del.title = "Удалить пункт";
        del.setAttribute("aria-label", "Удалить пункт");
        del.addEventListener("click", () => removeItem(item.id));

        const row = h("div", item.done ? "note-item done" : "note-item", check, area, del);
        row.dataset.done = String(item.done);
        list.append(row);
        requestAnimationFrame(() => grow(area));
      }
    }

    addBtn.addEventListener("click", () => addItem());

    root.append(wrap);
    render();

    void api.readStore<NotesData>("notes").then((data) => {
      items = normalizeItems(data);
      // Old versions kept one shared value. A legacy page becomes the text
      // page; the checklist starts empty instead of being rebuilt from it.
      text = typeof data?.text === "string" ? data.text : "";
      mode = data?.mode === "text" ? "text" : "list";
      render();
      updateMini();
      ctx.requestResize();
    });

    return {
      onShow: () => {
        updateMini();
        requestAnimationFrame(growAll);
      },
      unmount: () => {
        document.removeEventListener("keydown", onShiftDown);
        document.removeEventListener("keyup", onShiftUp);
        window.removeEventListener("blur", onWindowBlur);
        // The 350 ms debounce must not swallow the last keystroke.
        persist.flush();
        ctx.setMini(null);
      },
    };
  },
};
