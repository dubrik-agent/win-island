import { api, type MediaSnapshot } from "../core/api";
import { h, icon } from "../core/dom";
import { TEXT } from "../core/strings";
import type { WidgetDef } from "../core/widget-types";

const ART_MAX = 24;
const POLL_ACTIVE = 1000;
const POLL_IDLE = 4000;

const playMarkup = `<svg viewBox="0 0 24 24" fill="none"><path d="M8.5 5.6a1 1 0 0 1 1.52-.85l8.6 5.7a1 1 0 0 1 0 1.7l-8.6 5.7a1 1 0 0 1-1.52-.85z" fill="currentColor"/></svg>`;
const pauseMarkup = `<svg viewBox="0 0 24 24" fill="none"><rect x="7" y="5" width="3.6" height="14" rx="1.6" fill="currentColor"/><rect x="13.4" y="5" width="3.6" height="14" rx="1.6" fill="currentColor"/></svg>`;
const prevMarkup = `<svg viewBox="0 0 24 24" fill="none"><path d="M20 6.6a.9.9 0 0 0-1.37-.76l-7.1 4.9a.9.9 0 0 0 0 1.5l7.1 4.9A.9.9 0 0 0 20 16.4z" fill="currentColor"/><rect x="4.6" y="5.6" width="2.2" height="12.8" rx="1.1" fill="currentColor"/></svg>`;
const nextMarkup = `<svg viewBox="0 0 24 24" fill="none"><path d="M4 6.6a.9.9 0 0 1 1.37-.76l7.1 4.9a.9.9 0 0 1 0 1.5l-7.1 4.9A.9.9 0 0 1 4 16.4z" fill="currentColor"/><rect x="17.2" y="5.6" width="2.2" height="12.8" rx="1.1" fill="currentColor"/></svg>`;
const noteMarkup = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V6.2l10-1.7v11.2"/><circle cx="6.4" cy="18" r="2.7"/><circle cx="16.4" cy="15.7" r="2.7"/></svg>`;
const volumeMarkup = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4.2 9.4h3.1L12 5.6v12.8L7.3 14.6H4.2z" fill="currentColor" stroke="none"/><path d="M15.4 9.3a3.9 3.9 0 0 1 0 5.4"/><path d="M18 6.9a7.2 7.2 0 0 1 0 10.2"/></svg>`;
const mutedMarkup = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4.2 9.4h3.1L12 5.6v12.8L7.3 14.6H4.2z" fill="currentColor" stroke="none"/><path d="M15.6 9.7l5 4.6M20.6 9.7l-5 4.6"/></svg>`;

function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export const mediaWidget: WidgetDef = {
  id: "media",
  name: "Музыка",
  defaultEnabled: true,
  miniPriority: 0,
  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V6.2l10-1.7v11.2"/><circle cx="6.4" cy="18" r="2.6"/><circle cx="16.4" cy="15.7" r="2.6"/></svg>`,
  mount(root, ctx) {
    let snapshot: MediaSnapshot | null = null;
    let pollTimer = 0;
    let raf = 0;
    let visible = false;
    let seeking = false;
    let seekPreview = 0;
    let basePosition = 0;
    let sampledAt = 0;
    let seekGuardUntil = 0;
    let artKey = "";
    let artGeneration = 0;
    let sourcesKey = "";
    let volumeState: { level: number; muted: boolean } | null = null;
    let volumeFor = "";
    let volumeAt = 0;
    let volumeLoading = false;
    const artCache = new Map<string, string | null>();

    // --- cover -------------------------------------------------------------
    const coverImg = document.createElement("img");
    coverImg.alt = "";
    coverImg.decoding = "async";
    coverImg.draggable = false;
    const coverNote = icon(noteMarkup);
    coverNote.classList.add("media-cover-note");
    const cover = h("div", "media-cover");
    cover.append(coverImg, coverNote);

    // --- text --------------------------------------------------------------
    const appLabel = h("div", "media-app", "Медиа");
    const titleEl = h("div", "media-title", "Ничего не играет");
    const artistEl = h("div", "media-artist", "Включите музыку в любом плеере");
    const eq = h("div", "eq");
    for (let i = 0; i < 4; i += 1) eq.append(h("i"));
    eq.title = "Играет";

    const info = h("div", "media-info", appLabel, h("div", "media-lines", titleEl, artistEl), eq);
    const top = h("div", "media-top", cover, info);

    // --- seek --------------------------------------------------------------
    const current = h("span", "media-time", "0:00");
    const total = h("span", "media-time", "0:00");
    const fill = h("div", "seek-fill");
    const thumb = h("div", "seek-thumb");
    const track = h("div", "seek-track", fill, thumb);
    const seek = h("div", "seek", current, track, total);
    track.setAttribute("role", "slider");
    track.tabIndex = 0;
    track.setAttribute("aria-label", "Позиция трека");

    // --- controls ----------------------------------------------------------
    const prevBtn = h("button", "media-btn", icon(prevMarkup));
    prevBtn.title = "Предыдущий трек";
    prevBtn.setAttribute("aria-label", "Предыдущий трек");
    const playBtn = h("button", "media-btn play", icon(playMarkup));
    playBtn.title = "Играть / пауза";
    playBtn.setAttribute("aria-label", "Играть или пауза");
    const nextBtn = h("button", "media-btn", icon(nextMarkup));
    nextBtn.title = "Следующий трек";
    nextBtn.setAttribute("aria-label", "Следующий трек");
    const controls = h("div", "media-controls", prevBtn, playBtn, nextBtn);

    const sources = h("div", "media-sources");

    // --- per-app volume ----------------------------------------------------
    const muteBtn = h("button", "media-btn mute", icon(volumeMarkup));
    muteBtn.title = "Выключить звук";
    muteBtn.setAttribute("aria-label", "Выключить звук");
    const volumeRange = document.createElement("input");
    volumeRange.type = "range";
    volumeRange.min = "0";
    volumeRange.max = "100";
    volumeRange.step = "1";
    volumeRange.className = "volume-range";
    volumeRange.setAttribute("aria-label", "Громкость приложения");
    const volumePct = h("span", "volume-pct", "—");
    const volume = h("div", "media-volume", muteBtn, volumeRange, volumePct);
    volume.hidden = true;

    const card = h("div", "media", top, seek, controls, sources, volume);
    root.append(card);

    // --- mini (shown inside the collapsed pill) ----------------------------
    const miniImg = document.createElement("img");
    miniImg.className = "mini-art";
    miniImg.alt = "";
    const miniTitle = h("span", "", "");
    const mini = h("span", "mini-media", miniImg, miniTitle);

    // -----------------------------------------------------------------------

    function position(): number {
      if (!snapshot) return 0;
      const raw = seeking
        ? seekPreview
        : basePosition + (snapshot.playing ? performance.now() - sampledAt : 0);
      return Math.max(0, Math.min(snapshot.durationMs || raw, raw));
    }

    function paintProgress(): void {
      const duration = snapshot?.durationMs ?? 0;
      const pos = position();
      const ratio = duration > 0 ? Math.min(1, pos / duration) : 0;
      fill.style.transform = `scaleX(${ratio.toFixed(4)})`;
      thumb.style.left = `${(ratio * 100).toFixed(3)}%`;
      current.textContent = clock(pos);
      total.textContent = duration > 0 ? clock(duration) : "--:--";
      track.classList.toggle("disabled", !snapshot?.canSeek || duration <= 0);
      // Keep the accessibility value in sync with the painted one.
      track.setAttribute("aria-valuemin", "0");
      track.setAttribute("aria-valuemax", String(Math.round(duration / 1000)));
      track.setAttribute("aria-valuenow", String(Math.round(pos / 1000)));
      track.setAttribute(
        "aria-valuetext",
        duration > 0 ? `${clock(pos)} из ${clock(duration)}` : "Нет трека",
      );
    }

    function frame(): void {
      raf = 0;
      if (!visible || !snapshot?.playing) return;
      paintProgress();
      raf = requestAnimationFrame(frame);
    }

    function startFrames(): void {
      if (!raf && visible && snapshot?.playing) raf = requestAnimationFrame(frame);
    }

    function stopFrames(): void {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    }

    function setArtwork(url: string | null): void {
      if (url) {
        coverImg.src = url;
        coverImg.classList.remove("empty");
        cover.classList.add("has-art");
      } else {
        coverImg.removeAttribute("src");
        coverImg.classList.add("empty");
        cover.classList.remove("has-art");
      }
      if (url) {
        miniImg.src = url;
        miniImg.classList.remove("empty");
      } else {
        miniImg.removeAttribute("src");
        miniImg.classList.add("empty");
      }
    }

    async function loadArt(key: string): Promise<void> {
      if (!key) {
        artKey = "";
        setArtwork(null);
        return;
      }
      if (key === artKey) return;
      artKey = key;
      const generation = ++artGeneration;
      const cached = artCache.get(key);
      if (cached !== undefined) {
        setArtwork(cached);
        return;
      }
      try {
        const url = await api.mediaArt();
        if (artCache.size > ART_MAX) artCache.clear();
        artCache.set(key, url);
        if (generation === artGeneration && artKey === key) setArtwork(url);
      } catch {
        /* the player may have moved on — next poll retries */
      }
    }

    function paintVolume(): void {
      const state = volumeState;
      const wasHidden = volume.hidden;
      volume.hidden = !state;
      if (wasHidden !== volume.hidden) ctx.requestResize();
      if (!state) return;
      volumeRange.value = String(state.level);
      volumeRange.style.setProperty("--level", `${state.level}%`);
      volumePct.textContent = state.muted ? "выкл" : `${state.level}%`;
      volumeRange.setAttribute(
        "aria-valuetext",
        state.muted ? "звук выключен" : `${state.level}%`,
      );
      volume.classList.toggle("muted", state.muted);
      muteBtn.replaceChildren(icon(state.muted ? mutedMarkup : volumeMarkup));
      muteBtn.title = state.muted ? "Включить звук" : "Выключить звук";
      muteBtn.setAttribute("aria-label", muteBtn.title);
    }

    /**
     * Read the level of the active app's mixer session. Cached per app and
     * refreshed every few seconds so changes made in the Windows mixer show up.
     */
    async function loadVolume(force = false): Promise<void> {
      if (!snapshot?.active) {
        volumeState = null;
        volumeFor = "";
        paintVolume();
        return;
      }
      const id = snapshot.appId;
      if (!force && id === volumeFor && volumeState && Date.now() - volumeAt < 5000) return;
      if (volumeLoading) return;
      volumeLoading = true;
      try {
        const next = await api.mediaVolume(id);
        volumeFor = id;
        volumeState = next;
        volumeAt = Date.now();
        paintVolume();
      } catch {
        /* the session may be gone; the next poll retries */
      } finally {
        volumeLoading = false;
      }
    }

    function renderSources(snap: MediaSnapshot): void {
      const key = `${snap.appId}|${snap.sources
        .map((s) => `${s.id}:${s.playing ? 1 : 0}:${s.title}`)
        .join("|")}`;
      if (key === sourcesKey) return;
      sourcesKey = key;
      sources.replaceChildren();
      if (snap.sources.length < 2) {
        sources.classList.add("empty");
        ctx.requestResize();
        return;
      }
      sources.classList.remove("empty");
      for (const source of snap.sources) {
        const dot = h("span", source.playing ? "source-dot on" : "source-dot");
        const text = h(
          "span",
          "source-text",
          h("span", "source-app", source.app),
          h("span", "source-title", source.title || TEXT.untitled),
        );
        const main = h("button", "source-main", dot, text) as HTMLButtonElement;
        main.type = "button";
        main.title = `Слушать: ${source.app}`;
        main.classList.toggle("active", source.id === snap.appId);
        main.addEventListener("click", () => {
          if (source.id === snap.appId) return;
          void api
            .mediaSelect(source.id)
            .then(() => refresh(true))
            .catch(() => ctx.toast("Не удалось переключить источник"));
        });

        // Every session gets its own transport button: pausing a video must
        // not pause the music, and vice versa.
        const toggle = h(
          "button",
          "source-play",
          icon(source.playing ? pauseMarkup : playMarkup),
        ) as HTMLButtonElement;
        toggle.type = "button";
        toggle.title = source.playing ? "Пауза" : "Играть";
        toggle.setAttribute("aria-label", `${toggle.title}: ${source.app}`);
        toggle.addEventListener("click", () => {
          toggle.disabled = true;
          void api
            .mediaControlSource(source.id, "toggle")
            .then(() => setTimeout(() => refresh(true), 220))
            .catch(() => undefined)
            .finally(() => {
              toggle.disabled = false;
            });
        });

        sources.append(
          h("div", source.id === snap.appId ? "source-row active" : "source-row", main, toggle),
        );
      }
      ctx.requestResize();
    }

    function renderEmpty(): void {
      root.classList.add("is-empty");
      appLabel.textContent = "Медиа";
      titleEl.textContent = "Ничего не играет";
      artistEl.textContent = "Включите музыку в любом плеере";
      eq.classList.remove("on");
      controls.classList.add("disabled");
      seek.classList.add("disabled");
      sources.classList.add("empty");
      sources.replaceChildren();
      sourcesKey = "";
      volumeState = null;
      volumeFor = "";
      paintVolume();
      fill.style.transform = "scaleX(0)";
      thumb.style.left = "0%";
      current.textContent = "0:00";
      total.textContent = "--:--";
      ctx.setMini(null);
      void loadArt("");
      stopFrames();
      ctx.requestResize();
    }

    function render(snap: MediaSnapshot): void {
      snapshot = snap;
      sampledAt = performance.now();
      basePosition = snap.positionMs;
      if (!seeking) seekPreview = snap.positionMs;

      if (!snap.active) {
        renderEmpty();
        return;
      }

      root.classList.remove("is-empty");
      controls.classList.remove("disabled");
      seek.classList.remove("disabled");
      appLabel.textContent = snap.playing ? `Играет · ${snap.app}` : snap.app;
      titleEl.textContent = snap.title || snap.artist || TEXT.untitled;
      artistEl.textContent = [snap.artist, snap.album].filter(Boolean).join(" · ") || "Неизвестный исполнитель";
      eq.classList.toggle("on", snap.playing);

      fill.style.transform = "scaleX(0)";
      paintProgress();
      startFrames();

      playBtn.replaceChildren(icon(snap.playing ? pauseMarkup : playMarkup));
      prevBtn.disabled = !snap.canPrev;
      nextBtn.disabled = !snap.canNext;
      playBtn.disabled = !snap.active;
      root.classList.toggle("playing", snap.playing);

      renderSources(snap);
      void loadVolume();
      miniTitle.textContent = snap.title || snap.artist || snap.app;
      ctx.setMini(mini);
      void loadArt(snap.artKey);
    }

    async function refresh(force = false): Promise<void> {
      if (!api.available) return;
      try {
        const next = await api.mediaState();
        // Players publish their position lazily: trust the local clock for a
        // moment after a seek instead of snapping back to a stale value.
        if (!force && performance.now() < seekGuardUntil) return;
        if (!force && snapshot && sameState(snapshot, next)) {
          // Nothing changed: keep the local clock, only resync slowly.
          sampledAt = performance.now();
          basePosition = next.positionMs;
          if (!seeking) seekPreview = next.positionMs;
          return;
        }
        render(next);
      } catch (err) {
        console.warn("media poll failed", err);
      }
    }

    function sameState(a: MediaSnapshot, b: MediaSnapshot): boolean {
      return (
        a.active === b.active &&
        a.playing === b.playing &&
        a.title === b.title &&
        a.artist === b.artist &&
        a.album === b.album &&
        a.appId === b.appId &&
        a.artKey === b.artKey &&
        a.durationMs === b.durationMs &&
        a.canNext === b.canNext &&
        a.canPrev === b.canPrev &&
        a.canSeek === b.canSeek &&
        Math.abs(a.positionMs - b.positionMs) < 1200 &&
        a.sources.map((s) => s.id).join("|") === b.sources.map((s) => s.id).join("|")
      );
    }

    // --- seek dragging -----------------------------------------------------
    function seekTo(clientX: number): void {
      if (!snapshot || !snapshot.canSeek || snapshot.durationMs <= 0) return;
      const rect = track.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      seekPreview = ratio * snapshot.durationMs;
      paintProgress();
    }

    track.addEventListener("pointerdown", (event) => {
      if (!snapshot?.canSeek) return;
      event.preventDefault();
      seeking = true;
      track.classList.add("dragging");
      track.setPointerCapture(event.pointerId);
      seekTo(event.clientX);
    });
    track.addEventListener("pointermove", (event) => {
      if (seeking) seekTo(event.clientX);
    });
    const finishSeek = (): void => {
      if (!seeking) return;
      seeking = false;
      track.classList.remove("dragging");
      const target = Math.round(seekPreview);
      basePosition = target;
      sampledAt = performance.now();
      seekGuardUntil = sampledAt + 1200;
      if (snapshot) {
        snapshot.positionMs = target;
      }
      paintProgress();
      void api.mediaControl("seek", target).catch(() => undefined);
      startFrames();
    };
    track.addEventListener("pointerup", finishSeek);
    track.addEventListener("pointercancel", () => {
      seeking = false;
      track.classList.remove("dragging");
      paintProgress();
    });

    // Keyboard seek: 5 s per press, 15 s with Shift, Home/End jump to the ends.
    track.addEventListener("keydown", (event) => {
      if (!snapshot?.canSeek || snapshot.durationMs <= 0) return;
      const step = (event.shiftKey ? 15 : 5) * 1000;
      let target: number | null = null;
      if (event.key === "ArrowRight" || event.key === "ArrowUp") target = position() + step;
      else if (event.key === "ArrowLeft" || event.key === "ArrowDown") target = position() - step;
      else if (event.key === "Home") target = 0;
      else if (event.key === "End") target = snapshot.durationMs;
      if (target === null) return;
      event.preventDefault();
      const clamped = Math.max(0, Math.min(snapshot.durationMs, target));
      basePosition = clamped;
      sampledAt = performance.now();
      seekGuardUntil = sampledAt + 1200;
      snapshot.positionMs = clamped;
      paintProgress();
      void api.mediaControl("seek", Math.round(clamped)).catch(() => undefined);
    });

    // --- transport ---------------------------------------------------------
    playBtn.addEventListener("click", () => {
      void api
        .mediaControl("toggle")
        .then(() => refresh(true))
        .catch(() => ctx.toast("Не удалось управлять плеером"));
    });
    nextBtn.addEventListener("click", () => {
      void api
        .mediaControl("next")
        .then(() => setTimeout(() => refresh(true), 220))
        .catch(() => ctx.toast("Не удалось переключить трек"));
    });
    prevBtn.addEventListener("click", () => {
      void api
        .mediaControl("prev")
        .then(() => setTimeout(() => refresh(true), 220))
        .catch(() => ctx.toast("Не удалось переключить трек"));
    });

    // --- volume ------------------------------------------------------------
    volumeRange.addEventListener("input", () => {
      if (!volumeState) return;
      const level = Number(volumeRange.value);
      volumeState.level = level;
      volumeState.muted = false;
      volumeRange.style.setProperty("--level", `${level}%`);
      volumeRange.setAttribute("aria-valuetext", `${level}%`);
      volumePct.textContent = `${level}%`;
      volume.classList.remove("muted");
      muteBtn.replaceChildren(icon(volumeMarkup));
      muteBtn.title = "Выключить звук";
      muteBtn.setAttribute("aria-label", muteBtn.title);
    });
    volumeRange.addEventListener("change", () => {
      if (!snapshot?.active) return;
      const level = Number(volumeRange.value);
      const id = snapshot.appId;
      if (volumeState?.muted) {
        volumeState.muted = false;
        void api.mediaSetMute(id, false).catch(() => undefined);
      }
      void api.mediaSetVolume(id, level).catch(() => undefined);
      volumeAt = Date.now();
    });
    muteBtn.addEventListener("click", () => {
      if (!snapshot?.active || !volumeState) return;
      volumeState.muted = !volumeState.muted;
      volumeAt = Date.now();
      paintVolume();
      void api.mediaSetMute(snapshot.appId, volumeState.muted).catch(() => undefined);
    });

    function schedule(ms: number): void {
      window.clearInterval(pollTimer);
      pollTimer = window.setInterval(() => void refresh(), ms);
    }

    void refresh(true);
    schedule(POLL_IDLE);
    renderEmpty();

    return {
      onShow: () => {
        visible = true;
        schedule(POLL_ACTIVE);
        startFrames();
        void refresh(true);
      },
      onHide: () => {
        visible = false;
        stopFrames();
        schedule(POLL_IDLE);
      },
      onCollapse: () => {
        // The island is a thin line: no need to paint the seek bar 60×/s.
        visible = false;
        stopFrames();
        schedule(POLL_IDLE);
      },
      onExpand: () => {
        visible = true;
        schedule(POLL_ACTIVE);
        startFrames();
        void refresh(true);
      },
      unmount: () => {
        visible = false;
        window.clearInterval(pollTimer);
        stopFrames();
        ctx.setMini(null);
      },
    };
  },
};
