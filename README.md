# ⚡ Tripwire

**Test-run an unfamiliar repo in a locked-down cloud sandbox before it ever touches your laptop.**

Built for the CreateOS × Stripe "Build Agents That Run Code" hackathon.

## The problem

Developers run strangers' code all the time: a take-home test from a recruiter, an open-source project
you want to build on, a starter template from a tutorial. `npm install` runs that code's install scripts
**on your machine, with your files and your network**, before you've read a line of it.

Most of the time it's fine. When it isn't, you find out too late.

## What Tripwire does

Paste a repo link. Tripwire:

1. **Creates a fresh CreateOS sandbox** — an isolated cloud machine, not your laptop.
2. **Locks the network** with the sandbox's egress allowlist: only `registry.npmjs.org` is reachable.
   Any other connection is blocked — and recorded.
3. **Places a test marker file** in the sandbox's home folder. A normal project has no reason to open it.
4. **Runs `npm install` under `strace`**, recording every file opened and every connection attempted.
5. **Snapshots the sandbox and forks it** to run `npm start` and `npm test` in parallel, each watched the same way.
   If a fork behaves unexpectedly, Tripwire **pauses it** so its exact state is kept as evidence.
6. **Writes its own analyzer.** The AI writes a Python script to parse the trace, the agent runs it in the
   sandbox against a calibration trace with known activity, and if it fails, the error goes back to the AI
   to fix — until it passes. (A built-in analyzer is the fallback.)
7. **Reports back** in plain English:

| Verdict | Meaning |
|---|---|
| 🟢 Looks clean | Only touched its own folder and normal system files. No outside connections. |
| 🟡 Worth a look | Opened files outside its folder, or failed to install. |
| 🔴 Behaves unexpectedly | Opened files in your home folder, or tried to contact a server it doesn't need. |

…with the evidence: which file, which server, which command did it, and during which step.

## Sponsor tools

| Tool | How Tripwire uses it |
|---|---|
| **CreateOS Sandbox** | Isolated run (`createSandbox`), network allowlist as the core control (`setEgress`), `pause` + `fork` to try entry points in parallel from the same installed state, pausing a fork to keep evidence, `files.upload`, `runCommand`. |
| **Stripe Projects** | Provisioned every service (CreateOS, OpenRouter) and manages all keys, including the Gemini key — `stripe projects env --pull` writes `.env`. No keys in code. |
| **Gemini + OpenRouter** (keys in Stripe Projects) | The LLM that writes and fixes the trace analyzer, and explains the result in plain English. Gemini first; OpenRouter free models as fallback. |

## Run it

```bash
npm install
stripe projects env --pull          # writes .env with the CreateOS, OpenRouter and Gemini keys
npm start                           # open http://localhost:3000
# or from the terminal:
npm run scan -- https://github.com/owner/repo
npm run scan                        # scans the bundled demo repo
```

If a run is interrupted, `npm run cleanup` destroys any leftover sandboxes.

## The demo repo

`demo/jobtest-repo` plays a "take-home test from a recruiter". It is **harmless on purpose**: its install
step opens only the test marker file Tripwire creates, and tries to reach `192.0.2.10` — a
documentation-only address (RFC 5737) that nothing answers, and the sandbox blocks anyway. It exists so
the demo has something to catch.

## Layout

```
src/agent.mjs     the agent: sandbox, network lock, tracing, fork lanes, self-fixing analyzer, report
src/analyzer.mjs  built-in fallback analyzer
src/llm.mjs       OpenRouter client with free-model fallback
src/server.mjs    web UI server (live progress over Server-Sent Events)
src/cli.mjs       terminal runner
public/index.html web UI
demo/jobtest-repo harmless demo fixture
```

## Limits (honest)

- Node/npm projects today; the same approach works for `pip install`, `cargo build`, etc.
- A project could behave differently when it detects a sandbox. Tripwire raises confidence; it isn't a guarantee.
