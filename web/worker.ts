/**
 * RefGuard web API — Cloudflare Worker.
 *
 * The browser drives the audit one entry at a time so each request stays
 * within subrequest limits and the UI can show progress:
 *   POST /api/parse        {input}  → {entries: RefEntry[]}
 *   POST /api/audit-entry  {entry}  → AuditResult
 * Static UI is served from the assets binding.
 */
import { auditEntry, parseBib, parseTextRefs, type RefEntry } from "../src/core/index.ts";

const MAX_INPUT_BYTES = 200_000;
const MAX_ENTRIES = 300;

interface Env {
  ASSETS: { fetch(req: Request): Promise<Response> };
  REFGUARD_MAILTO?: string;
  OPENALEX_MAILTO?: string;   // legacy name, still honoured
  /** Per-IP limiter. Absent in local dev, where the check is skipped. */
  AUDIT_LIMIT?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
}

/** A day. Registry records barely change, and the edge cache is what keeps one
 *  popular bibliography from costing the next reader anything. */
const REGISTRY_CACHE_SECONDS = 86_400;

/**
 * Every visitor shares this Worker's egress, so one script looping over 300 entries
 * would get the whole site throttled by Crossref — exactly the failure the move off
 * a metered registry was meant to end. The limit is per client IP.
 */
async function overLimit(req: Request, env: Env): Promise<boolean> {
  if (!env.AUDIT_LIMIT) return false;
  const ip = req.headers.get("cf-connecting-ip") ?? "anonymous";
  const { success } = await env.AUDIT_LIMIT.limit({ key: ip });
  return !success;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/api/parse" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as { input?: string } | null;
      const input = body?.input;
      if (!input || typeof input !== "string") return json({ error: "missing input" }, 400);
      if (input.length > MAX_INPUT_BYTES) return json({ error: "input too large" }, 413);
      const entries = input.trimStart().startsWith("@") ? parseBib(input) : parseTextRefs(input);
      if (!entries.length) return json({ error: "no reference entries recognized" }, 422);
      return json({ entries: entries.slice(0, MAX_ENTRIES).map((e) => ({ ...e, raw: e.raw.slice(0, 500) })) });
    }

    if (url.pathname === "/api/audit-entry" && req.method === "POST") {
      if (await overLimit(req, env)) {
        return json(
          { error: "too many checks from this address in the last minute; wait a moment and try again" },
          429,
        );
      }
      const body = (await req.json().catch(() => null)) as { entry?: RefEntry } | null;
      const e = body?.entry;
      if (!e || typeof e.key !== "string") return json({ error: "missing entry" }, 400);
      const entry: RefEntry = {
        key: String(e.key).slice(0, 100),
        title: String(e.title ?? "").slice(0, 500),
        authors: Array.isArray(e.authors) ? e.authors.slice(0, 30).map((a) => String(a).slice(0, 80)) : [],
        year: String(e.year ?? "").slice(0, 4),
        journal: String(e.journal ?? "").slice(0, 300),
        doi: String(e.doi ?? "").slice(0, 300),
        raw: String(e.raw ?? "").slice(0, 500),
      };
      const result = await auditEntry(entry, {
        mailto: env.REFGUARD_MAILTO ?? env.OPENALEX_MAILTO,
        cacheTtlSeconds: REGISTRY_CACHE_SECONDS,
      });
      return json(result);
    }

    if (url.pathname.startsWith("/api/")) return json({ error: "not found" }, 404);
    return env.ASSETS.fetch(req);
  },
};
