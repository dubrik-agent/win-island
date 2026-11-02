import { convertFileSrc } from "@tauri-apps/api/core";
import { api, type PathInfo } from "../core/api";
import { h, icon } from "../core/dom";
import { playUiSound } from "../core/sound";
import type { WidgetDef } from "../core/widget-types";

const LIMIT = 20;
const STORE = "shelf";

/** Filled by this widget, used by main.ts for native drag & drop. */
export const shelfBridge: {
  add?: (paths: string[]) => void;
  highlight?: (on: boolean) => void;
} = {};

const folderMarkup = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.2l2 2.3h7.8a2 2 0 0 1 2 2v7.7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg>`;
const fileMarkup = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z"/><path d="M13.5 3.5V9H19"/></svg>`;
const imageMarkup = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2.4"/><circle cx="8.6" cy="9.4" r="1.5"/><path d="M4.5 17.5l4.6-4.6 3.2 3.2 2.4-2.4 4.4 4.4"/></svg>`;
const audioMarkup = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17V6.4l9.5-1.6v10.4"/><circle cx="6.5" cy="17.4" r="2.5"/><circle cx="16" cy="15.4" r="2.5"/></svg>`;
const videoMarkup = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5.5" width="13" height="13" rx="2.4"/><path d="M16 10.5l4.5-2.6v8.2L16 13.5"/></svg>`;
const archiveMarkup = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2.4"/><path d="M10 4.5h4M10 8h4M10.5 11.5h3M11 15h2"/></svg>`;
const codeMarkup = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 7.5L4.5 12 9 16.5M15 7.5L19.5 12 15 16.5"/></svg>`;

const COPY_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/></svg>`;
const REVEAL_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.5a2 2 0 0 1 2-2h3l2 2.2h7.8a2 2 0 0 1 2 2v7.6a2 2 0 0 1-2 2h-12.8a2 2 0 0 1-2-2z"/><path d="M12 11v4.5M9.8 13.3L12 15.5l2.2-2.2"/></svg>`;
const REMOVE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>`;

const KIND_BY_EXT: Record<string, string> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  svg: "image",
  ico: "image",
  heic: "image",
  avif: "image",
  mp4: "video",
  mkv: "video",
  avi: "video",
  mov: "video",
  webm: "video",
  m4v: "video",
  mp3: "audio",
  flac: "audio",
  wav: "audio",
  ogg: "audio",
  m4a: "audio",
  aac: "audio",
  wma: "audio",
  zip: "archive",
  rar: "archive",
  "7z": "archive",
  tar: "archive",
  gz: "archive",
  js: "code",
  ts: "code",
  json: "code",
  html: "code",
  css: "code",
  rs: "code",
  py: "code",
  tsx: "code",
  exe: "app",
  lnk: "app",
  msix: "app",
  pdf: "doc",
  doc: "doc",
  docx: "doc",
  txt: "doc",
  md: "doc",
  rtf: "doc",
};

function markupFor(kind: string): string {
  if (kind === "image") return imageMarkup;
  if (kind === "audio") return audioMarkup;
  if (kind === "video") return videoMarkup;
  if (kind === "archive") return archiveMarkup;
  if (kind === "code") return codeMarkup;
  return fileMarkup;
}

function kindOf(item: PathInfo): string {
  return item.isDir ? "folder" : (KIND_BY_EXT[item.ext] ?? "file");
}

function bytes(size: number): string {
  if (!size) return "";
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function statusText(item: PathInfo): string {
  if (item.isDir) return "Папка";
  const size = bytes(item.size);
  const ext = item.ext ? item.ext.toUpperCase() : "Файл";
  return size ? `${ext} · ${size}` : ext;
}

function fallbackInfo(path: string): PathInfo {
  const name = path.split(/[\\/]/).pop() || path;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return { path, name, ext, isDir: false, size: 0 };
}

export const shelfWidget: WidgetDef = {
  id: "shelf",
  name: "Полка",
  defaultEnabled: true,
  miniPriority: 5,
  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8.5h16"/><path d="M5.5 8.5v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9"/><path d="M8.5 5.5h7"/><path d="M4 8.5l1.3-2.2a1.6 1.6 0 0 1 1.4-.8h9.6a1.6 1.6 0 0 1 1.4.8L19 8.5"/></svg>`,
  mount(root, ctx) {
    let items: PathInfo[] = [];
    let writing = 0;

    const countBadge = h("span", "shelf-count", "");
    const heading = h("div", "shelf-heading", "Полка", countBadge);

    const pasteBtn = h("button", "chip-btn", icon(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="4.5" width="10" height="16" rx="2"/><path d="M9.5 4.5V3.4h5v1.1"/><path d="M10 10h4M10 13.5h4"/></svg>`));
    pasteBtn.title = "Вставить файлы из буфера";
    pasteBtn.setAttribute("aria-label", "Вставить файлы из буфера");

    const clearBtn = h("button", "chip-btn", icon(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 7h15"/><path d="M9.5 7V5.2h5V7"/><path d="M6.5 7l.8 11.2a1.8 1.8 0 0 0 1.8 1.6h5.8a1.8 1.8 0 0 0 1.8-1.6L17.5 7"/></svg>`));
    clearBtn.title = "Очистить полку";
    clearBtn.setAttribute("aria-label", "Очистить полку");

    const tools = h("div", "shelf-tools", pasteBtn, clearBtn);
    const head = h("div", "shelf-head", heading, tools);
    const hint = h("div", "shelf-hint", "Перетащите файлы в островок или вставьте из буфера");
    const list = h("div", "shelf-list");
    const card = h("div", "shelf", head, hint, list);
    root.append(card);

    const miniText = h("span", "", "");
    const mini = h("span", "mini-shelf", miniText);

    function syncMini(): void {
      if (items.length === 0) {
        ctx.setMini(null);
        return;
      }
      miniText.textContent = String(items.length);
      ctx.setMini(mini);
    }

    function persist(): void {
      const snapshot = items.map((item) => item.path);
      window.clearTimeout(writing);
      writing = window.setTimeout(() => {
        void api.writeStore(STORE, { paths: snapshot });
      }, 120);
    }

    /** The three per-file actions, shared by the list row and the grid tile. */
    function rowTools(item: PathInfo): HTMLElement {
      const copyBtn = h("button", "row-btn", icon(COPY_ICON));
      copyBtn.title = "Скопировать файл";
      copyBtn.setAttribute("aria-label", "Скопировать файл");
      const revealBtn = h("button", "row-btn", icon(REVEAL_ICON));
      revealBtn.title = "Показать в папке";
      revealBtn.setAttribute("aria-label", "Показать в папке");
      const removeBtn = h("button", "row-btn", icon(REMOVE_ICON));
      removeBtn.title = "Убрать с полки";
      removeBtn.setAttribute("aria-label", "Убрать с полки");

      copyBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        void api
          .copyFiles([item.path])
          .then(() => ctx.toast(`Скопировано: ${item.name}`))
          .catch(() => ctx.toast("Не удалось скопировать файл"));
      });
      revealBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        void api
          .revealPath(item.path)
          .then(() => ctx.toast("Открыл папку с файлом"))
          .catch(() => ctx.toast("Файл не найден — возможно, его переместили"));
      });
      removeBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        items = items.filter((other) => other.path !== item.path);
        render();
        persist();
      });

      return h("div", "shelf-row-tools", copyBtn, revealBtn, removeBtn);
    }

    /**
     * Real Explorer drag-out: after a 6 px move the native OLE drag takes over,
     * so the file can be dropped into Explorer, a mail client, an upload zone…
     *
     * One delegated handler for the whole list: per-row `window` listeners
     * piled up on every re-render (20 rows × 2 listeners × N renders).
     */
    let dragCandidate: { item: PathInfo; x: number; y: number } | null = null;
    let draggedPath = "";

    list.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if ((event.target as HTMLElement).closest(".shelf-row-tools")) return;
      const el = (event.target as HTMLElement).closest<HTMLElement>("[data-path]");
      const item = el ? items.find((entry) => entry.path === el.dataset.path) : undefined;
      if (!item) return;
      dragCandidate = { item, x: event.clientX, y: event.clientY };
      draggedPath = "";
    });

    list.addEventListener("pointermove", (event) => {
      if (!dragCandidate) return;
      if (Math.hypot(event.clientX - dragCandidate.x, event.clientY - dragCandidate.y) < 6) return;
      const { item } = dragCandidate;
      dragCandidate = null;
      draggedPath = item.path;
      void api.startFileDrag(item.path).catch((err) => {
        // The button was released before the OLE loop started: nothing to do.
        if (String(err).includes("drag-cancelled")) return;
        ctx.toast("Не удалось перетащить файл");
      });
    });

    const cancelDrag = (): void => {
      dragCandidate = null;
    };
    window.addEventListener("pointerup", cancelDrag, true);

    /** A row click right after a drag must not also open the file. */
    const wasDragged = (path: string): boolean => draggedPath === path;

    /**
     * Rows and tiles are clickable surfaces, so they must also be reachable and
     * activatable from the keyboard — a mouse-only widget feels broken to anyone
     * who tabs through the panel.
     */
    function bindOpen(el: HTMLElement, item: PathInfo): void {
      el.tabIndex = 0;
      el.setAttribute("role", "button");
      el.setAttribute("aria-label", `${item.name} — открыть`);
      const open = (): void => {
        if (wasDragged(item.path)) return;
        void api.openPath(item.path).catch(() => ctx.toast("Файл не открылся"));
      };
      el.addEventListener("click", open);
      el.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        // Let the inner action buttons handle their own keys.
        if ((event.target as HTMLElement).closest(".shelf-row-tools")) return;
        event.preventDefault();
        open();
      });
    }

    function bindDragOut(el: HTMLElement, item: PathInfo): void {
      el.dataset.path = item.path;
      el.draggable = false;
      el.addEventListener("dragstart", (event) => event.preventDefault());
    }

    function badgeFor(item: PathInfo): HTMLElement {
      const kind = kindOf(item);
      const badge = h("div", "shelf-badge");
      badge.dataset.kind = kind;
      badge.append(icon(item.isDir ? folderMarkup : markupFor(kind)));
      return badge;
    }

    function thumbnail(item: PathInfo): HTMLElement {
      const kind = kindOf(item);
      if (api.available && kind === "image") {
        const img = h("img", "shelf-thumb") as HTMLImageElement;
        img.src = convertFileSrc(item.path);
        img.alt = "";
        img.loading = "lazy";
        img.draggable = false;
        // A broken or unsupported file must not leave an empty hole in the
        // grid: fall back to the same icon the list view uses.
        img.addEventListener("error", () => img.replaceWith(badgeFor(item)), { once: true });
        return img;
      }
      if (api.available && kind === "video") {
        const video = h("video", "shelf-thumb") as HTMLVideoElement;
        // `#t=0.1` asks the decoder for a real frame instead of a black box.
        video.src = `${convertFileSrc(item.path)}#t=0.1`;
        video.muted = true;
        video.preload = "metadata";
        video.playsInline = true;
        video.draggable = false;
        video.addEventListener("error", () => video.replaceWith(badgeFor(item)), { once: true });
        return video;
      }
      return badgeFor(item);
    }

    function renderList(): void {
      for (const item of items) {
        const name = h("div", "shelf-name", h("b", "", item.name), h("span", "", statusText(item)));
        const label = h("div", "shelf-label", name);
        label.title = item.path;

        const row = h("div", "shelf-row", badgeFor(item), label, rowTools(item));
        bindDragOut(row, item);
        bindOpen(row, item);
        list.append(row);
      }
    }

    function renderGrid(): void {
      for (const item of items) {
        const media = h("div", "shelf-tile-media", thumbnail(item));
        const name = h("div", "shelf-tile-name", item.name);
        name.title = item.path;
        const sub = h("div", "shelf-tile-sub", statusText(item));
        const tile = h("div", "shelf-tile", media, h("div", "shelf-tile-meta", name, sub), rowTools(item));
        bindDragOut(tile, item);
        bindOpen(tile, item);
        list.append(tile);
      }
    }

    function render(): void {
      list.replaceChildren();
      const view = ctx.settings.value.shelfView === "grid" ? "grid" : "list";
      list.className = `shelf-list shelf-list--${view}`;
      card.classList.toggle("is-empty", items.length === 0);
      hint.hidden = items.length > 0;
      countBadge.textContent = items.length ? String(items.length) : "";

      if (view === "grid") renderGrid();
      else renderList();

      syncMini();
      ctx.requestResize();
    }

    async function setPaths(paths: string[]): Promise<void> {
      const unique = [...new Set(paths.filter(Boolean))].slice(0, LIMIT);
      if (!api.available) {
        items = unique.map(fallbackInfo);
        render();
        persist();
        return;
      }
      try {
        const described = await api.describePaths(unique);
        items = described;
      } catch {
        items = unique.map(fallbackInfo);
      }
      render();
      persist();
    }

    async function add(paths: string[]): Promise<void> {
      if (!paths.length) return;
      const merged = [...items.map((item) => item.path), ...paths];
      await setPaths(merged);
      playUiSound(
        "drop",
        ctx.settings.value.uiSounds,
        ctx.settings.value.uiSoundVolume,
      );
      ctx.toast(paths.length === 1 ? "Файл добавлен на полку" : `Добавлено файлов: ${paths.length}`);
    }

    pasteBtn.addEventListener("click", () => {
      void api
        .clipboardFiles()
        .then((paths) => {
          if (!paths.length) {
            ctx.toast("В буфере нет файлов");
            return;
          }
          return add(paths);
        })
        .catch(() => ctx.toast("Буфер обмена недоступен"));
    });

    clearBtn.addEventListener("click", () => {
      if (!items.length) return;
      items = [];
      render();
      persist();
      ctx.toast("Полка очищена");
    });

    shelfBridge.add = (paths) => {
      void add(paths);
    };
    shelfBridge.highlight = (on) => card.classList.toggle("dropping", on);

    async function restore(): Promise<void> {
      const saved = await api.readStore<{ paths?: string[] }>(STORE);
      const paths = saved?.paths ?? [];
      if (!paths.length) {
        render();
        return;
      }
      // Files dropped while the store was still loading must survive: keep the
      // saved order, then append whatever arrived in the meantime.
      const live = items.map((item) => item.path);
      await setPaths([...paths, ...live]);
    }

    void restore();

    // Switching list ⇄ previews in the settings window repaints immediately.
    let lastView = ctx.settings.value.shelfView;
    const unsubscribe = ctx.settings.subscribe((next) => {
      if (next.shelfView === lastView) return;
      lastView = next.shelfView;
      render();
    });

    return {
      onShow: () => {
        if (items.length) void setPaths(items.map((item) => item.path));
      },
      unmount: () => {
        unsubscribe();
        window.removeEventListener("pointerup", cancelDrag, true);
        ctx.setMini(null);
        shelfBridge.add = undefined;
        shelfBridge.highlight = undefined;
      },
    };
  },
};
