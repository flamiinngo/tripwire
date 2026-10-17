// Smoke test: confirms the CreateOS Sandbox features Tripwire depends on.
import { CreateosSandboxClient } from "@nodeops-createos/sandbox";

const client = new CreateosSandboxClient({
  baseUrl: process.env.CREATEOS_SANDBOX_BASE_URL || "https://api-eu.sb.createos.sh",
  apiKey: process.env.CREATEOS_SANDBOX_API_KEY,
});

const log = (...a) => console.log("•", ...a);

log("shapes:", JSON.stringify(await client.listShapes()).slice(0, 400));
log("rootfs:", JSON.stringify(await client.listRootfs()).slice(0, 600));

const sb = await client.createSandbox({ shape: "s-1vcpu-1gb", rootfs: "devbox:1", egress: ["registry.npmjs.org:443"] });
log("created", sb.id, sb.status);
try {
  const tools = await sb.sh("for t in node npm git python3 strace curl ss; do printf '%s=%s\\n' $t \"$(command -v $t || echo MISSING)\"; done; node -v; uname -a; id");
  log("tools:\n" + tools.result.stdout + tools.result.stderr);

  const allowed = await sb.sh("curl -s -o /dev/null -m 8 -w '%{http_code}' https://registry.npmjs.org/ || echo FAIL");
  const blocked = await sb.sh("curl -s -o /dev/null -m 8 -w '%{http_code}' https://example.com/ || echo BLOCKED");
  log("egress allowed npm:", allowed.result.stdout, "| example.com:", blocked.result.stdout);

  log("egress view:", JSON.stringify(await sb.getEgress()));
  await sb.setEgress(["registry.npmjs.org:443", "example.com:443"]);
  const after = await sb.sh("curl -s -o /dev/null -m 8 -w '%{http_code}' https://example.com/ || echo BLOCKED");
  log("after setEgress example.com:", after.result.stdout);

  await sb.sh("echo hello > /tmp/state.txt");
  await sb.pause();
  await sb.waitUntilPaused();
  log("paused:", sb.status);
  const fork = await sb.fork({ egress: ["registry.npmjs.org:443"] });
  log("fork:", fork.id, fork.status);
  const fr = await fork.sh("cat /tmp/state.txt");
  log("fork sees state:", fr.result.stdout.trim());
  await fork.destroy();
  await sb.resume();
  await sb.waitUntilRunning();
  log("resumed:", sb.status);
  log("preview url example:", sb.previewUrl(3000));
} finally {
  await sb.destroy();
  log("destroyed");
}
