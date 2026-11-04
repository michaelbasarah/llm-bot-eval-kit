/**
 * Demo server around the toy bot, so the gates have a real HTTP target.
 *
 *   POST /webhook                         WhatsApp Cloud API-shaped inbound (HMAC-checked if APP_SECRET is set);
 *                                         ACKs 200 at once, replies async, like the real thing
 *   GET  /api/conversations/:id/messages  transcript as JSON (?after=<id> for new ones only)
 *   POST /api/chat  {from, text}          same pipeline, answers synchronously (used by the web page)
 *   GET  /  ·  /transcripts  ·  /health   small HTML pages for the browser smoke gate
 *
 * Nothing is sent anywhere: replies are stored in memory, which is what makes it a safe gate target.
 * When reply() throws, the customer gets FALLBACK_TEXT, and the golden gate treats that as a failure.
 *
 *   npm start                 # PORT=3000, persona from PERSONA (salon | clinic | saas)
 */
import http from "node:http";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { reply as toyReply } from "./toybot.mjs";
import { PERSONAS } from "./personas.mjs";

export const FALLBACK_TEXT = "Maaf, sistem kami sedang sibuk. Silakan coba lagi sebentar lagi.";

/** Build (but don't start) the server. `replyFn` is injectable so tests can make the bot fail. */
export function createServer({ replyFn = toyReply, bot = PERSONAS.salon, appSecret = "" } = {}) {
  const convs = new Map(); // id → { lang, messages: [{ id, direction, text, lang, at }] }
  let nextId = 1;

  const conv = (id) => {
    if (!convs.has(id)) convs.set(id, { lang: null, messages: [] });
    return convs.get(id);
  };
  const record = (c, direction, text, lang = null) => {
    const m = { id: nextId++, direction, text, lang, at: new Date().toISOString() };
    c.messages.push(m);
    return m;
  };

  async function handle(from, text) {
    const c = conv(from);
    const history = c.messages.map((m) => ({ role: m.direction === "in" ? "user" : "model", text: m.text }));
    record(c, "in", text);
    try {
      const r = await replyFn({ text, bot, history, priorLang: c.lang, bookings: [] });
      if (r?.lang) c.lang = r.lang; // the language lock follows the bot; a missing lang never resets it
      return record(c, "out", String(r?.reply ?? ""), r?.lang ?? null);
    } catch (err) {
      console.error(`reply failed for ${from}: ${err?.message || err}`);
      return record(c, "out", FALLBACK_TEXT, c.lang);
    }
  }

  const send = (res, status, body, type = "application/json") => {
    res.writeHead(status, { "content-type": type });
    res.end(type === "application/json" ? JSON.stringify(body) : body);
  };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const raw = await new Promise((ok) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => ok(Buffer.concat(chunks)));
    });
    try {
      if (req.method === "POST" && url.pathname === "/webhook") {
        if (appSecret) {
          const want = "sha256=" + crypto.createHmac("sha256", appSecret).update(raw).digest("hex");
          const got = String(req.headers["x-hub-signature-256"] || "");
          if (got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) return send(res, 401, { error: "bad signature" });
        }
        const body = JSON.parse(raw.toString() || "{}");
        send(res, 200, { ok: true }); // ACK fast; the work happens after
        for (const entry of body.entry || [])
          for (const change of entry.changes || [])
            for (const m of change.value?.messages || []) if (m.type === "text") handle(m.from, m.text.body);
        return;
      }
      const msgs = url.pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
      if (req.method === "GET" && msgs) {
        const c = convs.get(decodeURIComponent(msgs[1]));
        if (!c) return send(res, 404, { error: "no such conversation" });
        const after = Number(url.searchParams.get("after")) || 0;
        return send(res, 200, { messages: c.messages.filter((m) => m.id > after) });
      }
      if (req.method === "POST" && url.pathname === "/api/chat") {
        const { from = "web", text = "" } = JSON.parse(raw.toString() || "{}");
        const out = await handle(String(from), String(text));
        return send(res, 200, { reply: out.text, lang: out.lang });
      }
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });
      if (req.method === "GET" && url.pathname === "/") return send(res, 200, chatPage(bot), "text/html; charset=utf-8");
      if (req.method === "GET" && url.pathname === "/transcripts") return send(res, 200, transcriptsPage(convs), "text/html; charset=utf-8");
      send(res, 404, { error: "not found" });
    } catch (err) {
      send(res, 500, { error: err.message });
    }
  });
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const shell = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px system-ui,sans-serif;max-width:640px;margin:0 auto;padding:16px}#log p{margin:6px 0}.out{color:#0a6}form{display:flex;gap:8px}input{flex:1;padding:8px}</style></head><body>${body}</body></html>`;

function chatPage(bot) {
  return shell(bot.name, `<h1>${esc(bot.name)}</h1><p><a href="/transcripts">transcripts</a></p><div id="log"></div>
<form id="f"><input id="t" placeholder="Tulis pesan…" autocomplete="off"><button>Send</button></form>
<script>
const log = document.getElementById("log"), t = document.getElementById("t");
const add = (cls, text) => { const p = document.createElement("p"); p.className = cls; p.textContent = text; log.append(p); };
document.getElementById("f").onsubmit = async (e) => {
  e.preventDefault(); const text = t.value.trim(); if (!text) return; t.value = ""; add("in", text);
  const r = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: "web", text }) });
  add("out", (await r.json()).reply);
};
</script>`);
}

function transcriptsPage(convs) {
  const rows = [...convs].map(([id, c]) => `<h2>${esc(id)}</h2>` + c.messages.map((m) => `<p class="${m.direction}">${m.direction === "in" ? "→" : "←"} ${esc(m.text)}</p>`).join(""));
  return shell("Transcripts", `<h1>Transcripts</h1><p><a href="/">chat</a></p>${rows.join("") || "<p>No conversations yet.</p>"}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.loadEnvFile(); } catch {} // .env in the cwd, if there is one
  const port = Number(process.env.PORT) || 3000;
  const bot = PERSONAS[process.env.PERSONA || "salon"] || PERSONAS.salon;
  createServer({ bot, appSecret: process.env.APP_SECRET || "" }).listen(port, () => console.log(`toy bot "${bot.name}" on http://localhost:${port}`));
}
