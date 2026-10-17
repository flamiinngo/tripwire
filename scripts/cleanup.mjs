// Destroys every sandbox on the account (use when a run crashes mid-way).
import { CreateosSandboxClient } from "@nodeops-createos/sandbox";

const client = new CreateosSandboxClient({
  baseUrl: process.env.CREATEOS_SANDBOX_BASE_URL || "https://api-eu.sb.createos.sh",
  apiKey: process.env.CREATEOS_SANDBOX_API_KEY,
});
const page = await client.listSandboxes();
const items = page.items || page.sandboxes || page.data || page;
for (const s of items) {
  if (s.status === "destroyed") continue;
  console.log("destroying", s.id, s.status);
  try { await (await client.getSandbox(s.id)).destroy(); } catch (e) { console.log("  failed:", e.message); }
}
console.log("done");
