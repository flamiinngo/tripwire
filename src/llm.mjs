// Thin LLM client. Providers are tried in order: Gemini (if a key is set), then
// OpenRouter free models with fallback (free models get rate-limited).
const OPENROUTER_MODELS = (process.env.TRIPWIRE_MODELS ||
  "nvidia/nemotron-3-super-120b-a12b:free,google/gemma-4-31b-it:free,poolside/laguna-s-2.1:free,nvidia/nemotron-3-ultra-550b-a55b:free")
  .split(",").map((s) => s.trim()).filter(Boolean);

const OPENROUTER_KEY = process.env.OPENROUTER_API_API_KEY || process.env.OPENROUTER_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

// Both expose an OpenAI-style chat endpoint; only the URL, key and "thinking" switch differ.
const PROVIDERS = [
  ...(GEMINI_KEY ? [{
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    key: GEMINI_KEY,
    models: [process.env.GEMINI_MODEL || "gemini-3.8-flash", "gemini-flash-latest"],
    extra: (think) => ({ reasoning_effort: think ? "medium" : "none" }),
  }] : []),
  {
    url: "https://openrouter.ai/api/v1/chat/completions",
    key: OPENROUTER_KEY,
    models: OPENROUTER_MODELS,
    headers: { "HTTP-Referer": "https://github.com/tripwire", "X-Title": "Tripwire" },
    // Hidden "thinking" makes free models take 50s+; off, they answer in ~12s. Turn it on only when it pays off.
    extra: (think) => ({ reasoning: { enabled: think } }),
  },
];

export async function chat(messages, { json = false, maxTokens = 4000, timeoutMs = 90_000, deadlineMs = Infinity, think = false } = {}) {
  let lastErr;
  const stopAt = Date.now() + deadlineMs;
  for (const p of PROVIDERS) for (const model of p.models) {
    if (Date.now() > stopAt) break;
    try {
      const res = await fetch(p.url, {
        method: "POST",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${p.key}`, "Content-Type": "application/json", ...p.headers },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.2, ...p.extra(think) }),
      });
      const body = await res.json().catch(() => ({}));
      const text = body?.choices?.[0]?.message?.content;
      if (!res.ok || !text) throw new Error(`${model}: ${res.status} ${JSON.stringify(body.error || body).slice(0, 200)}`);
      return { text: json ? extractJson(text) : text, model };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// Models wrap JSON in prose or fences; pull out the first balanced object.
export function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const src = fenced ? fenced[1] : text;
  const start = src.indexOf("{");
  if (start < 0) throw new Error("no JSON object in model output");
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inStr) { esc = !esc && c === "\\"; if (c === '"' && !esc) inStr = false; if (c !== "\\") esc = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return JSON.parse(src.slice(start, i + 1));
  }
  throw new Error("unbalanced JSON in model output");
}

export function extractCode(text, lang = "python") {
  const m = text.match(new RegExp("```(?:" + lang + "|py)?\\s*\\n([\\s\\S]*?)```"));
  return (m ? m[1] : text).trim() + "\n";
}
