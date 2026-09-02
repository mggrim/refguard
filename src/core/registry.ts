import type { RefEntry, Truth } from "./types.ts";
import { authorOverlap, normDoi, titleSim } from "./match.ts";

export class RegistryUnreachable extends Error {}

export function sanitizeSearchQuery(q: string): string {
  return q.replace(/[?&|!^~*:\\/]/g, " ").replace(/\s+/g, " ").trim();
}

export interface RegistryOptions {
  /** Injectable for tests and for platforms with custom fetch. */
  fetchFn?: typeof fetch;
  /** Joins the OpenAlex polite pool. Never hardcoded. */
  mailto?: string;
  timeoutMs?: number;
  /** Attempts after a 429 before giving up. Kept low: the fail-closed verdict is the point. */
  maxRetries?: number;
  /** First backoff step after a 429; doubles per attempt. Lowered in tests. */
  retryBaseMs?: number;
  /**
   * Shared across one run. When the registry hard-throttles, retrying every entry
   * turns a 90-second audit into a 20-minute one and still answers nothing, so the
   * first exhausted entry trips the breaker and the rest fail fast and honestly.
   */
  breaker?: Breaker;
}

export interface Breaker {
  trippedUntil: number;
  consecutive: number;
}

export const newBreaker = (): Breaker => ({ trippedUntil: 0, consecutive: 0 });

/** Consecutive exhausted entries before the rest of the run stops retrying. */
const BREAKER_TRIP_AFTER = 2;
const BREAKER_COOLDOWN_MS = 120_000;

const MAX_RETRIES = 4;
const RETRY_BASE_MS = 1000;
const RETRY_CAP_MS = 30_000;

async function openalexGet(url: string, opts: RegistryOptions, attempt = 0): Promise<unknown | null> {
  const f = opts.fetchFn ?? fetch;
  const full = opts.mailto
    ? `${url}${url.includes("?") ? "&" : "?"}mailto=${encodeURIComponent(opts.mailto)}`
    : url;
  const breaker = opts.breaker;
  if (breaker && Date.now() < breaker.trippedUntil) {
    throw new RegistryUnreachable("registry is rate limiting this run; skipped without retrying");
  }
  let resp: Response;
  try {
    resp = await f(full, {
      headers: { "User-Agent": "RefGuard/1.0" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
    });
  } catch (e) {
    throw new RegistryUnreachable(String(e));
  }
  if (resp.status === 404) return null;
  if (resp.status === 429) {
    // Retry, but a bounded number of times. This used to recurse without a limit,
    // so a sustained rate limit hung the run forever instead of failing closed —
    // the whole point of REGISTRY_UNREACHABLE is that it says "cannot certify".
    const limit = opts.maxRetries ?? MAX_RETRIES;
    if (attempt >= limit) {
      if (breaker && ++breaker.consecutive >= BREAKER_TRIP_AFTER) {
        breaker.trippedUntil = Date.now() + BREAKER_COOLDOWN_MS;
      }
      throw new RegistryUnreachable(`rate limited by OpenAlex (HTTP 429 after ${limit + 1} attempts)`);
    }
    const base = opts.retryBaseMs ?? RETRY_BASE_MS;
    const retryAfter = Number(resp.headers.get("retry-after"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, RETRY_CAP_MS)
      : Math.min(base * 2 ** attempt, RETRY_CAP_MS);
    await new Promise((r) => setTimeout(r, waitMs));
    return openalexGet(url, opts, attempt + 1);
  }
  if (!resp.ok) throw new RegistryUnreachable(`HTTP ${resp.status}`);
  if (breaker) breaker.consecutive = 0;
  return resp.json();
}

function workToTruth(w: any): Truth {
  return {
    source: "openalex",
    title: w.display_name ?? "",
    year: w.publication_year ? String(w.publication_year) : "",
    journal: w.primary_location?.source?.display_name ?? "",
    doi: normDoi(w.doi ?? ""),
    authors: (w.authorships ?? []).map((a: any) => {
      const name: string = a.author?.display_name ?? "";
      const parts = name.trim().split(/\s+/);
      return parts[parts.length - 1] ?? "";
    }),
    retracted: Boolean(w.is_retracted),
    id: w.id,
  };
}

export async function openalexByDoi(doi: string, opts: RegistryOptions = {}): Promise<Truth | null> {
  const w = await openalexGet(`https://api.openalex.org/works/doi:${encodeURIComponent(doi)}`, opts);
  return w ? workToTruth(w) : null;
}

export async function openalexSearch(entry: RefEntry, opts: RegistryOptions = {}): Promise<Truth | null> {
  // OpenAlex's search endpoint returns HTTP 400 on queries containing '?' (even encoded)
  const q = sanitizeSearchQuery(entry.title || entry.raw.slice(0, 200));
  const data: any = await openalexGet(
    `https://api.openalex.org/works?search=${encodeURIComponent(q)}&per-page=5`,
    opts,
  );
  const results: any[] = data?.results ?? [];
  let best: Truth | null = null;
  let bestScore = 0;
  for (const w of results) {
    const t = workToTruth(w);
    let score = entry.title ? titleSim(entry.title, t.title) : 0;
    const ao = authorOverlap(entry.authors, t.authors);
    if (ao >= 0) score = score * 0.7 + ao * 0.3;
    if (entry.year && t.year && Math.abs(Number(entry.year) - Number(t.year)) <= 1) score += 0.05;
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return bestScore >= 0.6 ? best : null;
}

/** Second opinion on a DOI's existence, so one registry's gap ≠ fabrication. */
export async function doiHandleExists(doi: string, opts: RegistryOptions = {}): Promise<boolean | null> {
  const f = opts.fetchFn ?? fetch;
  try {
    const resp = await f(`https://doi.org/api/handles/${encodeURIComponent(doi)}`, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
    });
    if (resp.status === 404) return false;
    if (!resp.ok) return null;
    const data: any = await resp.json();
    return data?.responseCode === 1;
  } catch {
    return null;
  }
}
