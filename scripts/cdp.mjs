// Minimal CDP driver for the dev WebView2 window.
// Usage:
//   node scripts/cdp.mjs eval "document.title"
//   node scripts/cdp.mjs shot out.png
//   node scripts/cdp.mjs eval-file expr.js
import { readFile, writeFile } from "node:fs/promises";

const PORT = process.env.CDP_PORT || 9222;
const [, , command, arg] = process.argv;

async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error(`ws error: ${e.message ?? e.type}`));
  });
}

let nextId = 1;
function send(ws, method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const onMessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== id) return;
      ws.removeEventListener("message", onMessage);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const targets = await listTargets();
// Two windows share the dev server: pick the island by default, the settings
// window with CDP_TARGET=settings (it sets a distinct document title).
const wantSettings = process.env.CDP_TARGET === "settings";
const isSettings = (t) => t.title.includes("Настройки");
const isIsland = (t) => t.url.includes("localhost:1420") && !isSettings(t);
const page =
  targets.find((t) => t.type === "page" && (wantSettings ? isSettings(t) : isIsland(t))) ??
  targets.find((t) => t.type === "page");
if (!page) {
  console.error("no page target", JSON.stringify(targets));
  process.exit(1);
}

const ws = await connect(page.webSocketDebuggerUrl);

if (command === "eval" || command === "eval-file") {
  let expression = command === "eval" ? arg : await readFile(arg, "utf8");
  if (process.argv[4]) expression = expression.replace(/__WIDGET__/g, process.argv[4]);
  const result = await send(ws, "Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    console.error("EXCEPTION", JSON.stringify(result.exceptionDetails, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(result.result?.value ?? null, null, 2));
} else if (command === "shot") {
  // CDP_DPR=2 renders at 2× for crisp docs/README images. The CSS viewport is
  // unchanged, so the window does not resize.
  const dpr = Number(process.env.CDP_DPR || 0);
  if (dpr > 0) {
    const size = await send(ws, "Runtime.evaluate", {
      expression: "({ w: innerWidth, h: innerHeight })",
      returnByValue: true,
    });
    const { w, h } = size.result.value;
    await send(ws, "Emulation.setDeviceMetricsOverride", {
      width: w,
      height: h,
      deviceScaleFactor: dpr,
      mobile: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const { data } = await send(ws, "Page.captureScreenshot", { format: "png", fromSurface: true });
  if (dpr > 0) await send(ws, "Emulation.clearDeviceMetricsOverride");
  await writeFile(arg ?? "shot.png", Buffer.from(data, "base64"));
  console.log(arg ?? "shot.png");
} else {
  console.error("usage: cdp.mjs eval <expr> | eval-file <file> | shot <file>");
  process.exit(1);
}
ws.close();
