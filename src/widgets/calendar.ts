import { api } from "../core/api";
import { debounce, h } from "../core/dom";
import { BUTTON, plural } from "../core/strings";
import type { WidgetDef } from "../core/widget-types";

interface Plan {
  id: string;
  /** Local date key: YYYY-MM-DD. */
  date: string;
  /** HH:MM, or an empty string for "no particular time". */
  time: string;
  text: string;
  done: boolean;
  /** High-priority plans always sit on top and are drawn larger. */
  priority?: "high" | "normal";
}

interface CalendarData {
  plans?: Plan[];
}

const MONTHS = [
  "Январь",
  "Февраль",
  "Март",
  "Апрель",
  "Май",
  "Июнь",
  "Июль",
  "Август",
  "Сентябрь",
  "Октябрь",
  "Ноябрь",
  "Декабрь",
];

const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

const CHECK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;
const TRASH_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M6 7h12M10 7V5h4v2M8 7l1 13h6l1-13"/></svg>`;
const CHEVRON = (dir: "left" | "right"): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M${dir === "left" ? 15 : 9} 5l${dir === "left" ? -6 : 6} 7l${dir === "left" ? 6 : -6} 7"/></svg>`;
const PLUS_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><path d="M12 5.5v13M5.5 12h13"/></svg>`;
const FLAG_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6 21V4"/><path d="M6 4h11l-2.2 3.6L17 11H6"/></svg>`;

const pad = (n: number): string => String(n).padStart(2, "0");

function dateKey(year: number, month: number, day: number): string {
  return `${year}-${pad(month + 1)}-${pad(day)}`;
}

function todayKey(): string {
  const now = new Date();
  return dateKey(now.getFullYear(), now.getMonth(), now.getDate());
}

function nextSlot(): string {
  const now = new Date();
  const minutes = Math.ceil((now.getMinutes() + 1) / 15) * 15;
  const hours = now.getHours() + Math.floor(minutes / 60);
  return `${pad(hours % 24)}:${pad(minutes % 60)}`;
}

/**
 * Accepts what people actually type — "9", "930", "09:30", "9.30" — and
 * returns HH:MM. `null` when the text cannot be a time. A plain text field
 * replaces `input[type=time]`: WebView2 renders the native picker as a white
 * OS popup over the dark panel, and its clock glyph is unstyleable.
 */
function parseTime(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length <= 2) {
    const hours = Number(digits);
    return hours <= 23 ? `${pad(hours)}:00` : null;
  }
  const value = digits.padStart(4, "0").slice(-4);
  const hours = Number(value.slice(0, 2));
  const minutes = Number(value.slice(2));
  if (hours > 23 || minutes > 59) return null;
  return `${pad(hours)}:${pad(minutes)}`;
}

function dayTitle(key: string): string {
  const [year, month, day] = key.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const same = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  const long = date.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
  if (key === todayKey()) return `Сегодня · ${long}`;
  if (same(date, tomorrow)) return `Завтра · ${long}`;
  const weekday = date.toLocaleDateString("ru-RU", { weekday: "long" });
  return `${long}, ${weekday}`;
}

export const calendarWidget: WidgetDef = {
  id: "calendar",
  name: "Календарь",
  defaultEnabled: true,
  miniPriority: 30,
  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M8 3.5V7M16 3.5V7M3.5 10h17"/><circle cx="8.2" cy="14" r="0.9" fill="currentColor" stroke="none"/><circle cx="12" cy="14" r="0.9" fill="currentColor" stroke="none"/><circle cx="15.8" cy="14" r="0.9" fill="currentColor" stroke="none"/></svg>`,
  mount(root, ctx) {
    let plans: Plan[] = [];
    let selected = todayKey();
    const initial = selected.split("-").map(Number);
    let viewYear = initial[0];
    let viewMonth = initial[1] - 1;
    let loaded = false;

    // --- shell -------------------------------------------------------------
    const monthEl = h("span", "cal-month");
    const yearEl = h("span", "cal-year");
    const title = h("div", "cal-title", monthEl, yearEl);
    const prev = h("button", "cal-nav-btn");
    const next = h("button", "cal-nav-btn");
    prev.innerHTML = CHEVRON("left");
    next.innerHTML = CHEVRON("right");
    const todayBtn = h("button", "cal-today-btn", BUTTON.today);
    prev.title = "Предыдущий месяц";
    next.title = "Следующий месяц";
    todayBtn.title = "К текущей дате";

    const head = h(
      "div",
      "cal-head",
      title,
      h("div", "cal-nav", prev, todayBtn, next),
    );

    const week = h("div", "cal-week", ...WEEKDAYS.map((label) => h("span", "", label)));
    const grid = h("div", "cal-grid");
    const dayTitleEl = h("span", "cal-day-title");
    const dayCount = h("span", "cal-day-count");
    const dayHead = h("div", "cal-day-head", dayTitleEl, dayCount);
    const list = h("div", "cal-list");

    const timeInput = h("input", "input cal-new-time") as HTMLInputElement;
    timeInput.type = "text";
    timeInput.inputMode = "numeric";
    timeInput.maxLength = 5;
    timeInput.autocomplete = "off";
    timeInput.value = nextSlot();
    timeInput.placeholder = "—:—";
    timeInput.title = "Время ЧЧ:ММ. Очистите поле, чтобы создать задачу без времени";
    timeInput.setAttribute("aria-label", "Время новой задачи");
    timeInput.spellcheck = false;
    timeInput.addEventListener("focus", () => timeInput.select());
    timeInput.addEventListener("blur", () => {
      // An empty field is a valid choice: the plan simply has no time.
      timeInput.value = timeInput.value.trim() ? parseTime(timeInput.value) ?? nextSlot() : "";
    });
    const textInput = h("input", "input cal-new-text") as HTMLInputElement;
    textInput.placeholder = "Что запланировано?";
    textInput.setAttribute("aria-label", "Описание новой задачи");

    let newPriority: "high" | "normal" = "normal";
    const prioBtn = h("button", "cal-prio") as HTMLButtonElement;
    prioBtn.type = "button";
    prioBtn.innerHTML = FLAG_ICON;
    prioBtn.setAttribute("aria-label", "Высокий приоритет новой задачи");
    const setPriority = (next: "high" | "normal"): void => {
      newPriority = next;
      prioBtn.classList.toggle("active", next === "high");
      prioBtn.setAttribute("aria-pressed", String(next === "high"));
      prioBtn.title =
        next === "high" ? "Высокий приоритет — нажмите для обычного" : "Сделать важной";
    };
    setPriority("normal");
    prioBtn.addEventListener("click", () => setPriority(newPriority === "high" ? "normal" : "high"));

    const addBtn = h("button", "cal-add-btn") as HTMLButtonElement;
    addBtn.type = "button";
    addBtn.innerHTML = PLUS_ICON;
    addBtn.title = "Добавить план (Enter)";
    addBtn.setAttribute("aria-label", "Добавить задачу");
    const addRow = h("div", "cal-add", prioBtn, timeInput, textInput, addBtn);

    const mini = h("span", "");
    let miniText = "";

    const wrap = h(
      "div",
      "cal",
      head,
      week,
      grid,
      h("div", "cal-day", dayHead, list, addRow),
    );

    // --- data --------------------------------------------------------------
    const persist = debounce(() => {
      void api.writeStore("calendar", { plans } satisfies CalendarData);
      renderMini();
    }, 300);

    const saveNow = (): void => {
      void api.writeStore("calendar", { plans } satisfies CalendarData);
      renderMini();
    };

    const isHigh = (plan: Plan): boolean => plan.priority === "high";
    /** High priority first, then by time; plans without a time go last. */
    const order = (a: Plan, b: Plan): number => {
      if (isHigh(a) !== isHigh(b)) return isHigh(a) ? -1 : 1;
      const ta = a.time || "99:99";
      const tb = b.time || "99:99";
      return ta.localeCompare(tb) || a.text.localeCompare(b.text);
    };

    const plansOn = (key: string): Plan[] =>
      plans.filter((plan) => plan.date === key).sort(order);

    const hasPlans = (key: string): boolean => plans.some((plan) => plan.date === key);

    function renderMini(): void {
      const key = todayKey();
      const now = `${pad(new Date().getHours())}:${pad(new Date().getMinutes())}`;
      const upcoming = plans.filter((plan) => plan.date === key && !plan.done).sort(order);
      // A high-priority item without a time still deserves the pill, but an
      // upcoming high-priority task with a time is the most useful hint.
      const pick =
        upcoming.find((plan) => isHigh(plan) && plan.time && plan.time >= now) ??
        upcoming.find((plan) => isHigh(plan) && !plan.time) ??
        upcoming.find((plan) => plan.time && plan.time >= now) ??
        upcoming[upcoming.length - 1];
      const next = pick
        ? `${pick.time ? `${pick.time} ` : ""}${pick.text}`.trim().slice(0, 18)
        : "";
      if (next === miniText) return;
      miniText = next;
      if (!next) {
        ctx.setMini(null);
      } else {
        mini.textContent = next;
        ctx.setMini(mini);
      }
    }

    // --- month grid --------------------------------------------------------
    const isViewingThisMonth = (): boolean => {
      const now = new Date();
      return viewYear === now.getFullYear() && viewMonth === now.getMonth();
    };

    function renderGrid(): void {
      monthEl.textContent = MONTHS[viewMonth];
      yearEl.textContent = String(viewYear);
      grid.replaceChildren();

      const first = new Date(viewYear, viewMonth, 1);
      const offset = (first.getDay() + 6) % 7; // Monday-first
      const start = new Date(viewYear, viewMonth, 1 - offset);
      const today = todayKey();

      for (let index = 0; index < 42; index += 1) {
        const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
        const key = dateKey(date.getFullYear(), date.getMonth(), date.getDate());
        const outside = date.getMonth() !== viewMonth;
        const weekend = date.getDay() === 0 || date.getDay() === 6;
        const planned = hasPlans(key);
        const cell = h("button", "cal-cell") as HTMLButtonElement;
        cell.type = "button";
        cell.dataset.date = key;
        cell.textContent = String(date.getDate());
        cell.classList.toggle("outside", outside);
        cell.classList.toggle("weekend", weekend);
        cell.classList.toggle("today", key === today);
        // An outside day is only a preview of the neighbouring month: the
        // selected day of another month must not look picked here.
        cell.classList.toggle("selected", key === selected && !outside);
        cell.classList.toggle("has-plan", planned);
        cell.setAttribute(
          "aria-label",
          `${date.toLocaleDateString("ru-RU", {
            day: "numeric",
            month: "long",
          })}${planned ? ", есть планы" : ""}`,
        );
        cell.setAttribute("aria-pressed", String(key === selected && !outside));
        cell.addEventListener("click", () => selectDate(key));
        grid.append(cell);
      }
      todayBtn.disabled = selected === today && isViewingThisMonth();
    }

    function selectDate(key: string): void {
      selected = key;
      const [year, month] = key.split("-").map(Number);
      const monthChanged = year !== viewYear || month - 1 !== viewMonth;
      viewYear = year;
      viewMonth = month - 1;
      if (monthChanged) renderGrid();
      else {
        for (const cell of grid.querySelectorAll<HTMLElement>(".cal-cell")) {
          const isSelected = cell.dataset.date === key;
          cell.classList.toggle("selected", isSelected);
          cell.setAttribute("aria-pressed", String(isSelected));
        }
        todayBtn.disabled = key === todayKey() && isViewingThisMonth();
      }
      if (key === todayKey()) timeInput.value = nextSlot();
      renderPlans();
    }

    // --- day plans ---------------------------------------------------------
    function renderPlans(): void {
      // Time order, always: a completed plan keeps its place instead of
      // jumping to the bottom under the cursor.
      const dayPlans = plansOn(selected);
      dayTitleEl.textContent = dayTitle(selected);
      dayCount.textContent =
        dayPlans.length === 0
          ? ""
          : `${dayPlans.length} ${plural(dayPlans.length, "план", "плана", "планов")}`;
      dayCount.hidden = dayPlans.length === 0;
      list.replaceChildren();
      list.classList.toggle("empty", dayPlans.length === 0);

      if (dayPlans.length === 0) {
        list.append(h("div", "cal-empty", "Свободный день — добавьте план ниже."));
      }

      for (const plan of dayPlans) {
        const flag = h("button", "cal-flag") as HTMLButtonElement;
        flag.type = "button";
        flag.innerHTML = FLAG_ICON;
        flag.classList.toggle("active", isHigh(plan));
        flag.title = isHigh(plan) ? "Обычный приоритет" : "Высокий приоритет";
        flag.setAttribute("aria-pressed", String(isHigh(plan)));
        flag.setAttribute("aria-label", "Приоритет задачи");

        const check = h("button", "cal-check") as HTMLButtonElement;
        check.type = "button";
        check.innerHTML = CHECK_ICON;
        check.setAttribute("role", "checkbox");
        check.setAttribute("aria-checked", String(plan.done));
        check.setAttribute("aria-label", plan.done ? "Снять отметку" : "Отметить выполненным");

        const text = h("input", "cal-item-text") as HTMLInputElement;
        text.value = plan.text;
        text.placeholder = "Описание";
        text.spellcheck = false;

        const time = h("input", "cal-item-time") as HTMLInputElement;
        time.type = "text";
        time.inputMode = "numeric";
        time.maxLength = 5;
        time.autocomplete = "off";
        time.value = plan.time;
        time.placeholder = "—:—";
        time.spellcheck = false;
        time.setAttribute("aria-label", "Время");
        time.title = "Время ЧЧ:ММ. Очистите поле, чтобы убрать время";

        const del = h("button", "cal-del") as HTMLButtonElement;
        del.type = "button";
        del.innerHTML = TRASH_ICON;
        del.title = "Удалить план";

        const classes = ["cal-item"];
        if (plan.done) classes.push("done");
        if (isHigh(plan)) classes.push("high");
        const row = h("div", classes.join(" "), flag, check, time, text, del);
        row.dataset.plan = plan.id;

        flag.addEventListener("click", () => {
          plan.priority = isHigh(plan) ? "normal" : "high";
          saveNow();
          renderPlans();
        });

        check.addEventListener("click", () => {
          plan.done = !plan.done;
          row.classList.toggle("done", plan.done);
          check.setAttribute("aria-checked", String(plan.done));
          check.setAttribute("aria-label", plan.done ? "Снять отметку" : "Отметить выполненным");
          persist();
        });

        text.addEventListener("input", () => {
          plan.text = text.value;
          persist();
        });
        text.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            text.blur();
            textInput.focus();
          }
        });

        time.addEventListener("focus", () => time.select());
        time.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            time.blur();
          }
        });
        time.addEventListener("change", () => {
          const raw = time.value.trim();
          const parsed = raw ? parseTime(raw) : "";
          if (parsed === null) {
            time.value = plan.time;
            return;
          }
          time.value = parsed;
          if (parsed === plan.time) return;
          plan.time = parsed;
          saveNow();
          renderPlans();
        });
        time.addEventListener("blur", () => {
          if (time.value !== plan.time) time.value = plan.time;
        });

        del.addEventListener("click", () => {
          plans = plans.filter((entry) => entry.id !== plan.id);
          saveNow();
          renderGrid();
          renderPlans();
          ctx.requestResize();
        });

        list.append(row);
      }
      ctx.requestResize();
    }

    // --- add ---------------------------------------------------------------
    function add(): void {
      const text = textInput.value.trim();
      if (!text) {
        textInput.focus();
        return;
      }
      const rawTime = timeInput.value.trim();
      const time = rawTime ? parseTime(rawTime) ?? nextSlot() : "";
      timeInput.value = time;
      plans.push({
        id: crypto.randomUUID(),
        date: selected,
        time,
        text,
        done: false,
        priority: newPriority,
      });
      textInput.value = "";
      // The next task starts as normal again unless the flag is pressed anew.
      setPriority("normal");
      saveNow();
      renderGrid();
      renderPlans();
      textInput.focus();
    }

    addBtn.addEventListener("click", add);
    textInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") add();
    });

    prev.addEventListener("click", () => {
      viewMonth -= 1;
      if (viewMonth < 0) {
        viewMonth = 11;
        viewYear -= 1;
      }
      renderGrid();
    });

    next.addEventListener("click", () => {
      viewMonth += 1;
      if (viewMonth > 11) {
        viewMonth = 0;
        viewYear += 1;
      }
      renderGrid();
    });

    todayBtn.addEventListener("click", () => selectDate(todayKey()));

    // Re-evaluate the mini indicator as time passes. `renderMini()` exits early
    // when the text did not change, so this is cheap and the pill stops
    // advertising a plan the moment its time has passed.
    const timer = window.setInterval(() => {
      if (!loaded) return;
      if (selected === todayKey()) {
        // Keep "today" highlighted after midnight.
        const cells = grid.querySelectorAll<HTMLElement>(".cal-cell.today");
        if (cells.length === 0) renderGrid();
      }
      renderMini();
    }, 30_000);

    root.append(wrap);
    renderGrid();
    renderPlans();
    renderMini();

    void api.readStore<CalendarData>("calendar").then((data) => {
      plans = Array.isArray(data?.plans) ? data.plans : [];
      loaded = true;
      renderGrid();
      renderPlans();
      renderMini();
    });

    return {
      onShow: () => {
        renderMini();
      },
      unmount: () => {
        window.clearInterval(timer);
        // A plan edited 300 ms before the widget was disabled must still land.
        persist.flush();
        ctx.setMini(null);
      },
    };
  },
};
