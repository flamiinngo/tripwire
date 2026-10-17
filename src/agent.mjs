// Tripwire agent: test-runs an unfamiliar repo inside a CreateOS sandbox and
// reports whether it does anything unexpected (reads files outside its folder,
// or tries to contact servers it doesn't need).
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { CreateosSandboxClient } from "@nodeops-createos/sandbox";
import { chat, extractCode } from "./llm.mjs";
import { BUILTIN_ANALYZER } from "./analyzer.mjs";

const REPO = "/work/repo";
const TW = "/opt/tripwire";
const MARKER = "/root/tripwire-test-marker.txt";
const CALIBRATION = "/root/tripwire-calibration.txt";
const CALIBRATION_IP = "192.0.2.1";
const NPM_ONLY = ["registry.npmjs.org:443"];
const CLONE_HOSTS = ["github.com:443", "codeload.github.com:443", "gitlab.com:443", ...NPM_ONLY];
const MAX_FIX_ATTEMPTS = 3;

// Places any install normally touches: system files, npm's own cache, the project itself.
const EXPECTED_PREFIXES = [
  REPO, "/usr/", "/lib", "/bin/", "/sbin/", "/proc/", "/sys/", "/dev/", "/etc/", "/tmp/",
  "/run/", "/var/", "/opt/", "/root/.npm", "/root/.cache/", "/root/.config/", "/root/.node",
  "/root/node_modules", "/root/package.json", "/root/.local/", "/root/.asdf/", "/root/.tool-versions",
];
const isAncestorLookup = (p) => /^(\/work)?\/(node_modules|package\.json|\.npmrc|\.git)/.test(p) || p === "/work" || p === "/";

// Every sandbox still alive, across all scans, so the server can clean up on Ctrl+C.
const live = new Set();
export async function destroyAllLive() {
  await Promise.race([Promise.allSettled([...live].map((s) => s.destroy())), new Promise((r) => setTimeout(r, 15_000))]);
}

export async function scan(source, emit = () => {}, { lanes = true, keepEvidence = false } = {}) {
  const t0 = Date.now();
  const step = (msg, extra = {}) => emit({ type: "step", msg, t: (Date.now() - t0) / 1000, ...extra });
  const client = new CreateosSandboxClient({
    baseUrl: process.env.CREATEOS_SANDBOX_BASE_URL || "https://api-eu.sb.createos.sh",
    apiKey: process.env.CREATEOS_SANDBOX_API_KEY,
  });
  const isLocal = !/^https?:\/\//.test(source);
  const sandboxes = [];
  const track = sandboxes.push.bind(sandboxes);
  sandboxes.push = (...xs) => { xs.forEach((x) => live.add(x)); return track(...xs); };
  const kept = [];

  try {
    step("Creating an isolated CreateOS sandbox");
    const sb = await client.createSandbox({
      shape: "s-1vcpu-1gb", rootfs: "devbox:1", egress: isLocal ? NPM_ONLY : CLONE_HOSTS,
    });
    sandboxes.push(sb);
    step(`Sandbox ${sb.id} is running`, { sandbox: sb.id });

    await run(sb, `mkdir -p ${REPO} ${TW} && echo "Tripwire test marker - not real data" > ${MARKER} && echo calibration > ${CALIBRATION}`);
    if (isLocal) {
      step(`Uploading ${source}`);
      await uploadDir(sb, source, REPO);
    } else {
      step(`Cloning ${source}`);
      const r = await run(sb, `git clone --depth 1 ${shellQuote(source)} ${REPO}`, 120_000);
      if (r.exit_code !== 0) throw new Error("git clone failed: " + r.stderr.slice(-300));
    }

    // Lock the network down: only the npm registry is reachable from here on.
    await sb.setEgress(NPM_ONLY);
    step("Network locked: only registry.npmjs.org is allowed", { egress: NPM_ONLY });

    const pkg = JSON.parse((await run(sb, `cat ${REPO}/package.json`)).stdout || "{}");
    const scripts = pkg.scripts || {};
    step(`Project "${pkg.name || "unknown"}" — scripts: ${Object.keys(scripts).join(", ") || "none"}`, { scripts });

    const analyzer = await buildAnalyzer(sb, step, emit);
    const expectedIps = new Set((await run(sb, "getent ahosts registry.npmjs.org | awk '{print $1}' | sort -u")).stdout.split(/\s+/).filter(Boolean));

    step("Running npm install while watching every file opened and connection attempted");
    const install = await traced(sb, "install", "npm install --no-audit --no-fund", 300_000);
    emit({ type: "output", lane: "install", text: tail(install.stdout + install.stderr) });
    const lanesOut = [{ lane: "install", sandbox: sb.id, ...install, findings: classify(await analyze(sb, analyzer, "install"), expectedIps) }];
    step(`Install finished (exit ${install.exit_code}) — ${countOf(lanesOut[0].findings)}`);

    const extra = ["start", "test"].filter((s) => scripts[s]);
    if (lanes && extra.length) {
      step(`Snapshotting the sandbox and forking it to try ${extra.map((s) => "npm " + s).join(" and ")} in parallel`);
      await sb.pause();
      await sb.waitUntilPaused({ timeoutMs: 180_000 });
      const runLane = async (box, name, isFork) => {
        step(`${isFork ? "Fork" : "Sandbox"} ${box.id}: running npm ${name}`, { sandbox: box.id });
        const r = await traced(box, name, `timeout 25 npm ${name}`, 60_000);
        emit({ type: "output", lane: name, text: tail(r.stdout + r.stderr) });
        const findings = classify(await analyze(box, analyzer, name), expectedIps);
        if (isFork && (findings.files.length || findings.connections.length)) {
          // Freeze this fork so its exact state can be inspected later.
          await box.pause().catch(() => {});
          kept.push(box.id);
          step(`Fork ${box.id} behaved unexpectedly — paused to preserve the evidence`);
        }
        return { lane: name, sandbox: box.id, ...r, findings };
      };
      // Request forks one at a time (parallel requests start slowly), then run the lanes side by side.
      let previous = Promise.resolve();
      const results = await Promise.all(extra.map(async (name) => {
        try {
          const ready = previous.then(() => forkWithRetry(sb, sandboxes, step));
          previous = ready.catch(() => {});
          return await runLane(await ready, name, true);
        } catch (e) {
          step(`Skipped npm ${name}: the fork couldn't start (${e.message.slice(0, 70)})`, { ok: false });
          return null;
        }
      }));
      lanesOut.push(...results.filter(Boolean));
    }

    const report = await buildReport(source, pkg, lanesOut, analyzer, kept);
    report.seconds = Math.round((Date.now() - t0) / 1000);
    emit({ type: "report", report });
    return report;
  } catch (e) {
    emit({ type: "error", msg: e.message });
    throw e;
  } finally {
    // Destroy in parallel; don't let a slow destroy call hold up the result.
    const doomed = sandboxes.filter((s) => !(keepEvidence && kept.includes(s.id)));
    sandboxes.forEach((s) => live.delete(s));
    await Promise.race([
      Promise.allSettled(doomed.map((s) => s.destroy())),
      new Promise((r) => setTimeout(r, 30_000)),
    ]);
    step("Sandboxes cleaned up");
  }
}

// --- the self-coding loop ---------------------------------------------------
// The agent asks the LLM to write the trace parser, runs it against a known
// calibration trace, and feeds any error back until the parser passes.
async function buildAnalyzer(sb, step, emit) {
  step("Recording a calibration trace with known activity");
  await run(sb, `cd /tmp && strace -f -qq -e trace=openat,connect,execve -s 300 -o ${TW}/calibration.trace bash -c 'for i in 1 2 3; do (cat ${CALIBRATION} >/dev/null; ls /tmp >/dev/null) & done; curl -s -m 2 http://${CALIBRATION_IP}/ >/dev/null & wait; true'`, 30_000);
  // Several processes run at once (like a real install), so the log contains interleaved
  // "<unfinished ...>" / "<... resumed>" lines that a first-draft parser often gets wrong.
  const trace = `${TW}/calibration.trace`;
  const sample = (await run(sb, `{ grep -m 4 execve ${trace}; grep -m 3 'unfinished' ${trace}; grep -m 3 'resumed' ${trace}; grep -m 2 'AF_INET' ${trace}; grep -m 2 'AF_UNIX' ${trace}; grep -m 2 'calibration.txt' ${trace}; } | sort -n -s -k1,1`)).stdout;

  const messages = analyzerMessages(sample);

  for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS && !process.env.TRIPWIRE_NO_AI; attempt++) {
    let code;
    try {
      step(`Asking the AI to write the trace analyzer (attempt ${attempt})`);
      // First draft is fast; when fixing a failed draft, let the model think it through.
      const fixing = attempt > 1;
      const { text, model } = await chat(messages, fixing
        ? { maxTokens: 12_000, timeoutMs: 100_000, deadlineMs: 120_000, think: true }
        : { maxTokens: 3000, timeoutMs: 40_000, deadlineMs: 90_000 });
      code = extractCode(text, "python");
      emit({ type: "code", attempt, model, code });
    } catch (e) {
      step(`AI unavailable (${e.message.slice(0, 80)}) — using the built-in analyzer`);
      break;
    }
    await sb.files.upload(`${TW}/analyze_ai.py`, code);
    const r = await run(sb, `python3 ${TW}/analyze_ai.py ${TW}/calibration.trace`, 30_000);
    const problem = checkCalibration(r);
    if (!problem) {
      step(`AI-written analyzer passed its calibration test on attempt ${attempt}`, { ok: true });
      return { path: `${TW}/analyze_ai.py`, author: "ai", attempts: attempt };
    }
    step(`Analyzer failed its test: ${problem.slice(0, 160)} — sending the error and the relevant log lines back to fix it`, { ok: false });
    // Give the model the evidence a person would look at: the raw lines it should have matched.
    const evidence = (await run(sb, `grep -E 'connect.*${CALIBRATION_IP}|tripwire-calibration' ${trace} | head -6; pid=$(grep -m1 'connect.*${CALIBRATION_IP}' ${trace} | grep -o '^[0-9]*'); grep "^$pid " ${trace} | grep -v openat | head -8`)).stdout;
    messages.push({ role: "assistant", content: "```python\n" + code + "```" });
    messages.push({ role: "user", content: `Running it on the real log failed:\n${problem}\n\nYour output (truncated): ${r.stdout.slice(0, 600)}\n\nThese are the raw log lines it should have handled:\n${evidence}\nFix the script. Reply with the full corrected script in one python code block.` });
  }
  step("Using Tripwire's built-in analyzer instead");
  await sb.files.upload(`${TW}/analyze_builtin.py`, BUILTIN_ANALYZER);
  return { path: `${TW}/analyze_builtin.py`, author: "builtin", attempts: MAX_FIX_ATTEMPTS };
}

export const analyzerMessages = (sample) => [
    { role: "system", content: "You write small, correct Python 3 scripts. Reply with one ```python code block only." },
    { role: "user", content: `Write a Python 3 script (standard library only) that parses an strace log produced by
\`strace -f -qq -e trace=openat,connect,execve -s 300 -o FILE\`. The log path is sys.argv[1].
Each line starts with a PID followed by one or more spaces. Lines may be split into "<unfinished ...>" and "<... resumed>" parts.

Print ONE JSON object to stdout:
{"files": [{"path": str, "pid": int, "command": str}],
 "connections": [{"ip": str, "port": int, "pid": int, "command": str}]}

- files: every path passed to openat (absolute paths only, de-duplicated by path+pid).
- connections: every connect() to AF_INET or AF_INET6 (skip AF_UNIX).
- command: the argv of the most recent successful execve for that pid joined by spaces;
  if the pid never called execve, use the command of its parent (the pid whose clone/fork
  produced it is unknown, so fall back to the most recent execve seen before the pid first appears).

Representative lines from the real log (note the split "<unfinished ...>"/"resumed" lines and the AF_INET connect):
${sample}` },
];

export function checkCalibration(r) {
  if (r.exit_code !== 0) return `exit code ${r.exit_code}\n${r.stderr.slice(-1200)}`;
  let out;
  try { out = JSON.parse(r.stdout); } catch (e) { return `stdout is not valid JSON (${e.message}): ${r.stdout.slice(0, 300)}`; }
  if (!Array.isArray(out.files) || !Array.isArray(out.connections)) return `JSON must have "files" and "connections" arrays, got keys: ${Object.keys(out)}`;
  if (!out.files.some((f) => f.path === CALIBRATION)) return `expected a files entry with path ${CALIBRATION}, but it is missing`;
  const c = out.connections.find((x) => x.ip === CALIBRATION_IP);
  if (!c) return `expected a connections entry with ip ${CALIBRATION_IP} (port 80), but it is missing`;
  if (Number(c.port) !== 80) return `connection to ${CALIBRATION_IP} should have port 80, got ${c.port}`;
  if (!String(c.command || "").includes("curl")) return `the connection to ${CALIBRATION_IP} was made by curl, but its command is ${JSON.stringify(c.command)}`;
  if (out.files.some((f) => /resumed|unfinished/.test(f.path))) return `a files entry has a broken path containing "resumed"/"unfinished" — split lines were not joined`;
  if (!out.files.find((f) => f.path === CALIBRATION)?.command?.includes("cat")) return `the files entry for ${CALIBRATION} should have command containing "cat"`;
  return null;
}

async function analyze(sb, analyzer, lane) {
  const r = await run(sb, `python3 ${analyzer.path} ${TW}/${lane}.trace`, 60_000);
  try { return JSON.parse(r.stdout); } catch { return { files: [], connections: [] }; }
}

// Apply Tripwire's policy to the raw parse: what would a normal project never do?
function classify(raw, expectedIps) {
  const files = new Map();
  for (const f of raw.files || []) {
    const p = String(f.path || "");
    if (!p.startsWith("/") || isAncestorLookup(p) || EXPECTED_PREFIXES.some((x) => p.startsWith(x))) continue;
    if (p.startsWith(TW) || p === CALIBRATION) continue;
    if (!files.has(p)) files.set(p, { path: p, command: f.command || "", marker: p === MARKER });
  }
  const conns = new Map();
  for (const c of raw.connections || []) {
    const ip = String(c.ip || "");
    const port = Number(c.port);
    if (port === 53 || expectedIps.has(ip) || ip.startsWith("127.") || ip === "::1" || ip === CALIBRATION_IP) continue;
    const key = `${ip}:${port}`;
    if (!conns.has(key)) conns.set(key, { ip, port, command: c.command || "", blocked: true });
  }
  return { files: [...files.values()], connections: [...conns.values()] };
}

async function buildReport(source, pkg, lanes, analyzer, kept) {
  const files = lanes.flatMap((l) => l.findings.files.map((f) => ({ ...f, lane: l.lane })));
  const connections = lanes.flatMap((l) => l.findings.connections.map((c) => ({ ...c, lane: l.lane })));
  const homeReads = files.filter((f) => f.path.startsWith("/root/") || f.path.startsWith("/home/"));
  const verdict = connections.length || homeReads.length ? "red" : files.length || lanes[0].exit_code !== 0 ? "yellow" : "green";
  const facts = { project: pkg.name, scripts: pkg.scripts, verdict, files, connections, exitCodes: Object.fromEntries(lanes.map((l) => [l.lane, l.exit_code])) };

  let summary;
  try {
    const { text } = await chat([
      { role: "system", content: "You explain sandbox test-run results to developers in plain, calm English. Describe what the project did, not what its author intended. No markdown headings. 3-5 short sentences." },
      { role: "user", content: `Tripwire ran this repo's npm scripts in an isolated sandbox with the network locked to the npm registry, and recorded every file opened and connection attempted. Explain what was found and what the developer should do next. A failing npm test is normally just the project's own test result; don't connect it to the findings. The file ${MARKER} is a test file Tripwire planted in the home folder; a normal project has no reason to open it.\n\n${JSON.stringify(facts, null, 2)}` },
    ], { maxTokens: 600, timeoutMs: 30_000, deadlineMs: 45_000 });
    summary = text.trim();
  } catch {
    summary = verdict === "green"
      ? "Nothing unexpected happened: the project only touched its own folder and normal system files, and made no outside connections."
      : `Tripwire saw ${files.length} unexpected file access(es) and ${connections.length} blocked connection attempt(s). Read the evidence below before running this project on your own machine.`;
  }

  return {
    source, project: pkg.name || "unknown", verdict, summary,
    files, connections, keptForEvidence: kept,
    lanes: lanes.map((l) => ({ lane: l.lane, sandbox: l.sandbox, exitCode: l.exit_code, output: tail(l.stdout + l.stderr, 1500) })),
    analyzer: { author: analyzer.author, attempts: analyzer.attempts },
  };
}

// --- helpers -----------------------------------------------------------------
// The account caps how many sandboxes run at once; a just-destroyed one can hold a slot briefly.
async function forkWithRetry(sb, sandboxes, step) {
  for (let i = 1; ; i++) {
    try {
      const f = await sb.fork({ egress: NPM_ONLY });
      sandboxes.push(f);
      await f.waitUntilRunning({ timeoutMs: 120_000 });
      return f;
    } catch (e) {
      if (i >= 4 || !/429|quota/i.test(e.message)) throw e;
      step(`Sandbox limit reached — waiting for a free slot (try ${i} of 3)`);
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
}

async function traced(sb, lane, cmd, timeoutMs) {
  return run(sb, `cd ${REPO} && strace -f -qq -e trace=openat,connect,execve -s 300 -o ${TW}/${lane}.trace ${cmd}`, timeoutMs);
}

async function run(sb, script, timeoutMs = 60_000) {
  const { result } = await sb.runCommand("bash", ["-lc", script], { timeoutMs });
  return result;
}

async function uploadDir(sb, dir, dest) {
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath ?? entry.path, entry.name);
    const rel = relative(dir, full).split("\\").join("/");
    if (rel.startsWith("node_modules/") || rel.startsWith(".git/")) continue;
    await run(sb, `mkdir -p "$(dirname ${shellQuote(`${dest}/${rel}`)})"`);
    await sb.files.upload(`${dest}/${rel}`, await readFile(full));
  }
}

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const tail = (s, n = 3000) => (s.length > n ? "…" + s.slice(-n) : s);
const countOf = (f) => `${f.files.length} unexpected file access(es), ${f.connections.length} blocked connection(s)`;
