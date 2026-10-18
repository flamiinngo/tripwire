<p align="center">
  <img src="public/logo.svg" width="64" height="64" alt="Tripwire logo">
</p>

<h1 align="center">Tripwire</h1>

<p align="center">
  Run unfamiliar code somewhere safe first.<br>
  Tripwire installs a repo in an isolated, network-locked sandbox and tells you exactly what it touched.
</p>

<p align="center"><a href="https://youtu.be/6__olBhH7Co"><b>Watch the demo</b></a></p>

---

## Why

Developers run strangers' code all the time: a take-home test from a recruiter, an open-source project
you want to build on, a starter template from a tutorial. `npm install` executes that project's install
scripts on your machine, with your files and your network, before you've read a line of it.

Usually that's fine. When it isn't, you find out too late. Fake take-home assignments that run harmful
code at install time are a well-documented way of targeting developers.

Tripwire gives you a second machine to try it on first.

## How it works

Paste a repository link. Tripwire:

1. **Creates a fresh CreateOS sandbox.** Every repo gets its own isolated machine.
2. **Locks the network.** The sandbox's egress allowlist permits only `registry.npmjs.org`. Every other
   connection is blocked, and the attempt is recorded.
3. **Plants a test file** in the sandbox's home folder. A normal project has no reason to open it.
4. **Writes its own analyzer.** The agent asks the model to write a Python parser for the trace, runs it
   in the sandbox against a calibration trace with known activity, and if the output is wrong, sends
   the error and the relevant log lines back to be fixed. It retries until the parser passes, and falls
   back to a built-in parser if it can't.
5. **Traces the install.** `npm install` runs under `strace`, recording every file opened and every
   connection attempted.
6. **Forks in parallel.** The installed sandbox is paused and forked, so `npm start` and `npm test` run
   side by side from the same state. A fork that behaves unexpectedly is paused to preserve the evidence.
7. **Reports back** with a verdict, a plain-English explanation, and the evidence: which file or address,
   which command was responsible, and during which step.

| Verdict | Meaning |
|---|---|
| **Looks clean** | Touched only its own folder and normal system files. No outside connections. |
| **Worth a closer look** | Opened files outside its folder, or failed to install. |
| **Behaves unexpectedly** | Opened files in the home folder, or tried to reach a server it doesn't need. |

## Built with

| | |
|---|---|
| **CreateOS Sandbox** | Isolation (`createSandbox`), network control as the core mechanism (`setEgress`), `pause` and `fork` to run entry points in parallel from one installed state, pausing a fork to keep evidence. |
| **Stripe Projects** | Provisions every service and manages every key. `stripe projects env --pull` writes `.env`; nothing secret lives in the code. |
| **Gemini, with OpenRouter as fallback** | Writes and repairs the trace analyzer, and explains the result. Both keys are managed through Stripe Projects. |

## Run it locally

```bash
npm install
stripe projects env --pull     # writes .env with the CreateOS, Gemini and OpenRouter keys
npm start                      # open http://localhost:3000
```

From the terminal:

```bash
npm run scan -- https://github.com/owner/repo
npm run scan                   # scans the bundled sample
```

Sandboxes are billed while they run. Tripwire destroys them when a scan ends and when the server is
stopped with Ctrl+C. If a run is ever interrupted, `npm run cleanup` removes anything left behind.

## The sample repo

`demo/jobtest-repo` plays the part of a take-home test. It is harmless by design: its install step opens
only the test file Tripwire plants, and tries to reach `192.0.2.10`, an address reserved for
documentation (RFC 5737) that nothing answers and the sandbox blocks regardless. It exists so the demo
has something to find.

## Project layout

```
src/agent.mjs      the agent: sandbox, network lock, tracing, forks, self-repairing analyzer, report
src/analyzer.mjs   built-in fallback analyzer
src/llm.mjs        model client (Gemini first, OpenRouter fallback)
src/server.mjs     web server, streams progress over Server-Sent Events
src/cli.mjs        terminal runner
public/            web interface, How it works page, and logo
demo/jobtest-repo  harmless sample project
```

## Tested on

- **The sample take-home test** — flagged as *Behaves unexpectedly*: it opened the planted file and tried to reach a blocked address, both traced to `scripts/setup-env.js`.
- **[lukeed/kleur](https://github.com/lukeed/kleur)**, a widely used open-source package — *Looks clean* in 37 seconds, with no false alarms.

## What's next

- Python, Rust and Go projects, using the same sandbox and tracing for `pip install`, `cargo build` and `go build`.
- A GitHub check that runs Tripwire on every pull request that changes dependencies or install scripts.

