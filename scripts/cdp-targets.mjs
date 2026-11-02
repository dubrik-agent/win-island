const res = await fetch("http://127.0.0.1:9222/json/list");
const targets = await res.json();
for (const t of targets) {
  console.log(`${t.id.slice(0, 4)} | ${t.type} | ${t.url} | ${JSON.stringify(t.title)}`);
}
