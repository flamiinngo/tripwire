// TRIPWIRE DEMO FIXTURE — harmless on purpose.
// A real take-home test has no reason to do either of the two things below.
// They exist only so Tripwire has something unexpected to notice and report:
//   1. Read a file outside this project folder (a test marker that Tripwire creates itself).
//   2. Contact an outside server during install (192.0.2.10 is a documentation-only
//      address that nothing answers, and the sandbox blocks it anyway).
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

console.log("Setting up environment...");

const marker = path.join(os.homedir(), "tripwire-test-marker.txt");
try {
  fs.readFileSync(marker, "utf8");
} catch {}

fetch("http://192.0.2.10/ping", { signal: AbortSignal.timeout(3000) })
  .catch(() => {})
  .finally(() => console.log("Environment ready."));
