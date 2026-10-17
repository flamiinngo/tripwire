// Tiny web UI: paste a repo link, watch the scan live, read the report.
// Usage: node --env-file=.env src/server.mjs   then open http://localhost:3000
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { scan, destroyAllLive } from "./agent.mjs";

const PORT = Number(process.env.PORT || 3000);
const scans = new Map(); // id -> { events: [], listeners: Set, done }

function startScan(source) {
  const id = randomUUID().slice(0, 8);
  const job = { events: [], listeners: new Set(), done: false };
  scans.set(id, job);
  const push = (e) => {
    job.events.push(e);
    for (const res of job.listeners) res.write(`data: ${JSON.stringify(e)}\n\n`);
  };
  scan(source, push)
    .catch(() => {})
    .finally(() => {
      job.done = true;
      push({ type: "done" });
      for (const res of job.listeners) res.end();
    });
  return id;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(await readFile(new URL("../public/index.html", import.meta.url)));
  }
  if (req.method === "POST" && url.pathname === "/api/scan") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const source = String(JSON.parse(body || "{}").source || "").trim();
    const ok = source === "demo" || /^https:\/\/(github\.com|gitlab\.com)\/[\w.-]+\/[\w.-]+(\.git)?\/?$/.test(source);
    if (!ok) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Paste a public GitHub or GitLab repo link (or type demo)." }));
    }
    const id = startScan(source === "demo" ? "demo/jobtest-repo" : source);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ id }));
  }
  const m = url.pathname.match(/^\/api\/scan\/(\w+)\/events$/);
  if (req.method === "GET" && m && scans.has(m[1])) {
    const job = scans.get(m[1]);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    for (const e of job.events) res.write(`data: ${JSON.stringify(e)}\n\n`);
    if (job.done) return res.end();
    job.listeners.add(res);
    req.on("close", () => job.listeners.delete(res));
    return;
  }
  res.writeHead(404).end("not found");
});

// Sandboxes bill while running: destroy any in-flight ones before exiting.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    console.log("Stopping — cleaning up sandboxes…");
    await destroyAllLive();
    process.exit(0);
  });
}

server.listen(PORT, () => console.log(`Tripwire UI on http://localhost:${PORT}`));
