// Usage: node --env-file=.env src/cli.mjs <git-url | local-folder>   (default: the demo repo)
import { scan } from "./agent.mjs";

const source = process.argv[2] || "demo/jobtest-repo";
const report = await scan(source, (e) => {
  if (e.type === "step") console.log(`[${e.t.toFixed(1)}s] ${e.msg}`);
  else if (e.type === "code") console.log(`--- AI-written analyzer (attempt ${e.attempt}, ${e.model}) ---\n${e.code.split("\n").slice(0, 12).join("\n")}\n  …`);
  else if (e.type === "output") console.log(`--- ${e.lane} output ---\n${e.text.trim()}`);
  else if (e.type === "error") console.log("ERROR:", e.msg);
});
const icon = { green: "🟢 Looks clean", yellow: "🟡 Worth a look", red: "🔴 Behaves unexpectedly" }[report.verdict];
console.log(`\n${icon}\n${report.summary}\n`);
console.log(JSON.stringify({ files: report.files, connections: report.connections, analyzer: report.analyzer, kept: report.keptForEvidence }, null, 2));
