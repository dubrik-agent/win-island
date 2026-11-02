import { api } from "../core/api";
import { h, icon } from "../core/dom";
import type { WidgetDef } from "../core/widget-types";

/** Native clipboard first: the web API needs a focused window. */
async function copyText(text: string): Promise<boolean> {
  if (api.available) {
    try {
      await api.copyText(text);
      return true;
    } catch {
      // fall through to the browser clipboard
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

const KEYS: Array<{ label: string; value: string; cls?: string }> = [
  { label: "C", value: "clear", cls: "op" },
  { label: "(", value: "(", cls: "op" },
  { label: ")", value: ")", cls: "op" },
  { label: "⌫", value: "back", cls: "op" },
  { label: "7", value: "7" },
  { label: "8", value: "8" },
  { label: "9", value: "9" },
  { label: "÷", value: "/", cls: "op" },
  { label: "4", value: "4" },
  { label: "5", value: "5" },
  { label: "6", value: "6" },
  { label: "×", value: "*", cls: "op" },
  { label: "1", value: "1" },
  { label: "2", value: "2" },
  { label: "3", value: "3" },
  { label: "−", value: "-", cls: "op" },
  { label: "0", value: "0" },
  { label: ".", value: "." },
  { label: "=", value: "equals", cls: "eq" },
  { label: "+", value: "+", cls: "op" },
];

/** Why an expression has no number yet — the display explains it in words. */
type EvalResult =
  | { ok: true; value: number }
  | { ok: false; reason: "empty" | "incomplete" | "div0" };

const incomplete: EvalResult = { ok: false, reason: "incomplete" };

/** Recursive descent evaluator — no eval(), no surprises. */
function evaluate(src: string): EvalResult {
  const s = src.replace(/\s+/g, "");
  if (!s) return { ok: false, reason: "empty" };
  let i = 0;
  let div0 = false;
  const peek = () => s[i];

  const parseExpr = (): number => {
    let value = parseTerm();
    while (peek() === "+" || peek() === "-") {
      const op = s[i++];
      const rhs = parseTerm();
      value = op === "+" ? value + rhs : value - rhs;
    }
    return value;
  };

  const parseTerm = (): number => {
    let value = parseFactor();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = s[i++];
      const rhs = parseFactor();
      if (op === "*") value *= rhs;
      else if (op === "/") {
        if (rhs === 0) div0 = true;
        value /= rhs;
      } else {
        // `x % 0` is NaN just like `x / 0`; both deserve the same message
        // instead of an endless "…".
        if (rhs === 0) div0 = true;
        value %= rhs;
      }
    }
    return value;
  };

  const parseFactor = (): number => {
    const ch = peek();
    if (ch === "-") {
      i++;
      return -parseFactor();
    }
    if (ch === "+") {
      i++;
      return parseFactor();
    }
    if (ch === "(") {
      i++;
      const inner = parseExpr();
      if (peek() !== ")") throw new Error("unclosed");
      i++;
      return inner;
    }
    const start = i;
    while (i < s.length && /[0-9.]/.test(s[i])) i++;
    if (start === i) throw new Error("expected number");
    const num = Number(s.slice(start, i));
    if (!Number.isFinite(num)) throw new Error("bad number");
    return num;
  };

  try {
    const value = parseExpr();
    if (i !== s.length) return incomplete;
    if (div0) return { ok: false, reason: "div0" };
    if (!Number.isFinite(value)) return incomplete;
    return { ok: true, value };
  } catch {
    return incomplete;
  }
}

function format(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e12) return String(value);
  const text = value.toPrecision(10).replace(/\.?0+$/, "");
  return text.length > 14 ? value.toExponential(6) : text;
}

export const calculatorWidget: WidgetDef = {
  id: "calc",
  name: "Калькулятор",
  defaultEnabled: true,
  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 7h8"/><path d="M8 11h.01M12 11h.01M16 11h.01M8 15h.01M12 15h.01M16 15h.01M8 19h.01M12 19h.01M16 19h.01"/></svg>`,
  mount(root, ctx) {
    let expression = "";
    let lastResult: number | null = null;

    const exprEl = h("div", "calc-expr", "");
    const valueEl = h("div", "calc-value", "0");
    const copyBtn = h(
      "button",
      "calc-copy",
      icon(
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="3"/><path d="M15 5.5A2.5 2.5 0 0 0 12.5 3H6a3 3 0 0 0-3 3v6.5A2.5 2.5 0 0 0 5.5 15"/></svg>',
      ),
    ) as HTMLButtonElement;
    copyBtn.type = "button";
    copyBtn.title = "Скопировать результат (Ctrl+C)";
    copyBtn.setAttribute("aria-label", "Скопировать результат");
    const display = h("div", "calc-display", exprEl, valueEl, copyBtn);
    const grid = h("div", "calc-grid");

    /** The number the user is looking at, formatted exactly as shown. */
    const currentValue = (): string => {
      const result = evaluate(expression);
      return result.ok ? format(result.value) : "";
    };

    async function copyResult(): Promise<void> {
      const text = currentValue();
      if (!text) {
        ctx.toast("Нет результата для копирования");
        return;
      }
      let ok = await copyText(text);
      ctx.toast(ok ? `Скопировано: ${text}` : "Не удалось скопировать");
      if (!ok) return;
      copyBtn.classList.add("done");
      window.setTimeout(() => copyBtn.classList.remove("done"), 900);
    }

    function refresh(): void {
      exprEl.textContent = expression || " ";
      const result = evaluate(expression);
      if (result.ok) {
        valueEl.textContent = format(result.value);
        valueEl.style.opacity = "1";
      } else if (result.reason === "div0") {
        valueEl.textContent = "деление на 0";
        valueEl.style.opacity = "0.75";
      } else {
        valueEl.textContent = result.reason === "empty" ? "0" : "…";
        valueEl.style.opacity = result.reason === "empty" ? "1" : "0.55";
      }
      copyBtn.disabled = !result.ok;
      ctx.requestResize();
    }

    function press(value: string): void {
      if (value === "clear") {
        expression = "";
        lastResult = null;
      } else if (value === "back") {
        expression = expression.slice(0, -1);
      } else if (value === "equals") {
        const result = evaluate(expression);
        if (result.ok) {
          lastResult = result.value;
          expression = format(result.value);
        }
      } else {
        // after "=" pressing a digit starts a new expression, an operator continues
        if (lastResult !== null) {
          if (/[0-9.]/.test(value)) expression = "";
          lastResult = null;
        }
        expression += value;
      }
      refresh();
    }

    for (const key of KEYS) {
      const btn = h("button", `calc-key${key.cls ? ` ${key.cls}` : ""}`, key.label);
      btn.addEventListener("click", () => press(key.value));
      grid.append(btn);
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (!root.classList.contains("active")) return;
      const key = event.key;
      // Ctrl+C copies the number on screen (unless the user selected text).
      if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === "c") {
        if (window.getSelection()?.toString()) return;
        event.preventDefault();
        void copyResult();
        return;
      }
      if (/^[0-9.+\-*/%()]$/.test(key)) press(key === "*" ? "*" : key);
      else if (key === "Enter" || key === "=") press("equals");
      else if (key === "Backspace") press("back");
      else if (key === "Delete") press("clear");
      else return;
      event.preventDefault();
    };
    document.addEventListener("keydown", onKeyDown);

    copyBtn.addEventListener("click", () => void copyResult());
    valueEl.addEventListener("click", () => void copyResult());

    root.append(display, grid);
    refresh();

    return {
      unmount: () => document.removeEventListener("keydown", onKeyDown),
    };
  },
};
