import { api } from "../core/api";
import { fmtBytes, h } from "../core/dom";
import type { WidgetDef } from "../core/widget-types";

interface Metric {
  root: HTMLElement;
  value: HTMLElement;
  fill: HTMLElement;
  sub: HTMLElement;
}

/** Volumes are read every 10 s: enumerating them can wake a sleeping drive. */
const DISK_INTERVAL = 10_000;
const TICK = 1500;
/** Collapsed island: the pill only needs a fresh CPU number now and then. */
const IDLE_TICK = 6000;

function metric(label: string): Metric {
  const value = h("b", "", "—");
  const head = h("div", "metric-head", h("span", "", label), value);
  const fill = h("i");
  const bar = h("div", "bar", fill);
  const sub = h("div", "metric-sub", "");
  const root = h("div", "", head, bar, sub);
  return { root, value, fill, sub };
}

function line(label: string): { root: HTMLElement; value: HTMLElement } {
  const value = h("b", "", "—");
  const root = h("div", "metric-line", h("span", "", label), value);
  return { root, value };
}

/** `2 д 4 ч 12 м` — short enough for one row. */
function formatUptime(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (days > 0) return `${days} д ${hours} ч ${minutes} м`;
  if (hours > 0) return `${hours} ч ${minutes} м`;
  return `${minutes} м`;
}

export const sysmonWidget: WidgetDef = {
  id: "sysmon",
  name: "Система",
  defaultEnabled: true,
  miniPriority: 30,
  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h3l2-5 4 10 2.5-5H21"/></svg>`,
  mount(root, ctx) {
    const metrics = h("div", "metrics");
    const mini = h("span", "", "—");
    let timer: number | undefined;
    let busy = false;
    let attached = false;
    let signature = "";
    /** Last time the drives were read (`DISK_INTERVAL` throttles it). */
    let disksAt = 0;
    let cpu: Metric | null = null;
    let ram: Metric | null = null;
    let uptime: { root: HTMLElement; value: HTMLElement } | null = null;
    const disks = new Map<string, Metric>();

    const wanted = (): string => {
      const s = ctx.settings.value;
      return `${s.sysCpu}|${s.sysRam}|${s.sysDisks}|${s.sysUptime}`;
    };

    /** Rebuild the list when the user toggles a metric in settings. */
    function build(): void {
      signature = wanted();
      disksAt = 0;
      metrics.replaceChildren();
      cpu = null;
      ram = null;
      uptime = null;
      disks.clear();
      const s = ctx.settings.value;
      if (s.sysCpu) {
        cpu = metric("Процессор");
        metrics.append(cpu.root);
      }
      if (s.sysRam) {
        ram = metric("Память");
        metrics.append(ram.root);
      }
      if (s.sysUptime) {
        uptime = line("Время работы");
        metrics.append(uptime.root);
      }
      if (s.sysDisks) {
        // Rows appear with the first poll: drive letters are only known then.
        metrics.append(h("div", "metric-divider", "Диски"));
      }
      ctx.requestResize();
    }

    function diskMetric(name: string): Metric {
      let existing = disks.get(name);
      if (existing) return existing;
      existing = metric(`Диск ${name}`);
      disks.set(name, existing);
      metrics.append(existing.root);
      return existing;
    }

    const poll = async (): Promise<void> => {
      if (busy) return;
      busy = true;
      try {
        const stats = await api.stats();
        const cpuValue = Math.round(stats.cpu);
        if (cpu) {
          cpu.value.textContent = `${cpuValue}%`;
          cpu.fill.style.width = `${Math.min(100, cpuValue)}%`;
          cpu.fill.style.background = tint(cpuValue);
          cpu.sub.textContent = cpuValue > 85 ? "Высокая нагрузка" : "Норма";
        }

        if (ram) {
          const usedPct = stats.ramTotal ? (stats.ramUsed / stats.ramTotal) * 100 : 0;
          ram.value.textContent = `${fmtBytes(stats.ramUsed)} / ${fmtBytes(stats.ramTotal)}`;
          ram.fill.style.width = `${Math.min(100, usedPct)}%`;
          ram.fill.style.background = tint(usedPct);
          ram.sub.textContent = `${Math.round(usedPct)}% занято`;
        }

        if (ctx.settings.value.sysDisks) await pollDisks();

        if (uptime) uptime.value.textContent = formatUptime(stats.uptimeSecs ?? 0);

        const miniValue = ctx.settings.value.sysCpu
          ? `${cpuValue}%`
          : ctx.settings.value.sysRam && stats.ramTotal
            ? `${Math.round((stats.ramUsed / stats.ramTotal) * 100)}%`
            : "";
        if (miniValue) {
          mini.textContent = miniValue;
          if (!attached) {
            ctx.setMini(mini);
            attached = true;
          }
        } else if (attached) {
          ctx.setMini(null);
          attached = false;
        }
      } catch {
        if (cpu) cpu.value.textContent = "н/д";
      } finally {
        busy = false;
      }
    };

    /**
     * Volume enumeration wakes every drive (a sleeping USB stick takes ~1 s), so
     * it runs on its own slow schedule instead of every CPU tick.
     */
    async function pollDisks(): Promise<void> {
      const now = performance.now();
      if (now - disksAt < DISK_INTERVAL) return;
      disksAt = now;
      const list = await api.disks();
      const seen = new Set<string>();
      for (const disk of list ?? []) {
        seen.add(disk.name);
        const row = diskMetric(disk.name);
        const used = Math.max(0, disk.total - disk.free);
        const usedPct = disk.total ? (used / disk.total) * 100 : 0;
        row.value.textContent = `${fmtBytes(disk.free)} свободно`;
        row.fill.style.width = `${Math.min(100, usedPct)}%`;
        row.fill.style.background = tint(usedPct);
        row.sub.textContent = `${fmtBytes(used)} из ${fmtBytes(disk.total)}`;
      }
      // A drive was unplugged: drop its row.
      for (const [name, row] of disks) {
        if (!seen.has(name)) {
          row.root.remove();
          disks.delete(name);
        }
      }
      if (disks.size === 0) {
        if (!metrics.querySelector(".metric-empty")) {
          metrics.append(h("div", "metric-empty", "Диски не найдены"));
        }
      } else {
        metrics.querySelector<HTMLElement>(".metric-empty")?.remove();
      }
    }

    const stop = (): void => {
      window.clearInterval(timer);
      timer = undefined;
    };

    let currentRate: number | null = null;

    /**
     * Three speeds instead of "always on": the active tab polls fast, a
     * collapsed island polls slowly (the CPU number stays in the pill), and an
     * expanded panel showing another tab does not poll at all.
     */
    const setRate = (interval: number | null): void => {
      if (interval === null) {
        currentRate = null;
        stop();
        return;
      }
      if (timer !== undefined && currentRate === interval) return;
      stop();
      currentRate = interval;
      void poll();
      timer = window.setInterval(() => void poll(), interval);
    };

    const unsubscribe = ctx.settings.subscribe(() => {
      if (wanted() !== signature) build();
    });

    root.append(metrics);
    build();

    return {
      onShow: () => setRate(TICK),
      onHide: () => setRate(null),
      onCollapse: () => setRate(IDLE_TICK),
      onExpand: () => setRate(TICK),
      unmount: () => {
        stop();
        unsubscribe();
        ctx.setMini(null);
      },
    };
  },
};

function tint(percent: number): string {
  if (percent > 85) return "#ff6b6b";
  if (percent > 65) return "#ffc86b";
  return "var(--accent)";
}
