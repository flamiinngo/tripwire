import { CreateosSandboxClient } from "@nodeops-createos/sandbox";
const client = new CreateosSandboxClient({ baseUrl: "https://api-eu.sb.createos.sh", apiKey: process.env.CREATEOS_SANDBOX_API_KEY });
const t0 = Date.now(); const T = () => ((Date.now() - t0) / 1000).toFixed(1) + "s";
const sb = await client.createSandbox({ shape: "s-1vcpu-1gb", rootfs: "devbox:1", egress: ["github.com:443"] });
console.log(T(), "created");
const forks = [];
try {
  await sb.sh("echo hello > /root/state.txt");
  await sb.pause(); await sb.waitUntilPaused(); console.log(T(), "paused");
  for (let i = 0; i < 2; i++) forks.push(await sb.fork({ egress: ["registry.npmjs.org:443"] }));
  console.log(T(), "fork requested", forks.map((f) => f.status));
  await Promise.all(forks.map((f) => f.waitUntilRunning({ timeoutMs: 180000 })));
  console.log(T(), "forks running");
  for (const f of forks) console.log((await f.sh("cat /root/state.txt; curl -s -o /dev/null -m 6 -w '%{http_code}' https://github.com || echo BLOCKED")).result.stdout.trim());
  await forks[0].pause(); await forks[0].waitUntilPaused(); console.log(T(), "fork0 paused (evidence)");
} catch (e) { console.log("ERR", e.message); }
finally { for (const f of forks) await f.destroy().catch(() => {}); await sb.destroy().catch(() => {}); console.log(T(), "cleaned"); }
