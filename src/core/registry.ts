import type { Truth } from "./types.ts";
import { normDoi } from "./match.ts";

export class RegistryUnreachable extends Error {}

export function sanitizeSearchQuery(q: string): string {
  return q.replace(/[?&|!^~*:\\/]/g, " ").replace(/\s+/g, " ").trim();
}

export interface RegistryOptions {
  /** Injectable for tests and for platforms with custom fetch. */
  fetchFn?: typeof fetch;
  /** Joins Crossref's polite pool, which is faster and better supported. Never hardcoded. */
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
/**
 * One exhausted entry is enough. A credit budget that has run out stays out for
 * hours, so a second entry spending its full retry ladder to confirm that buys
 * nothing and costs the reader another wait.
 */
const BREAKER_TRIP_AFTER = 1;
const BREAKER_COOLDOWN_MS = 120_000;

const MAX_RETRIES = 4;
const RETRY_BASE_MS = 1000;
/**
 * A person is watching a progress bar, so a registry asking for a long wait is
 * refused rather than obeyed. Honouring a Retry-After literally once cost two
 * minutes per entry; the breaker and the other registries carry the run instead.
 */
const RETRY_CAP_MS = 4_000;




export interface SearchMatch {
  truth: Truth;
  /** Combined title/author/year score of the accepted candidate, 0-1. */
  score: number;
}

/** Below this the candidate is not trusted enough to be called a match. */
export const SEARCH_ACCEPT = 0.6;



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

/**
 * The one HTTP path every registry uses: timeout, bounded retry with backoff, and
 * the shared breaker. Each registry client used to carry its own copy, so a fix to
 * the retry policy reached only whichever one had been edited.
 *
 * Returns null on 404 (a clean "not held"), throws RegistryUnreachable on anything
 * else, because a registry that cannot answer must never read as an answer.
 */
export async function registryGet(url: string, opts: RegistryOptions, attempt = 0): Promise<unknown | null> {
  const f = opts.fetchFn ?? fetch;
  const breaker = opts.breaker;
  if (breaker && Date.now() < breaker.trippedUntil) {
    throw new RegistryUnreachable("registry is rate limiting this run; skipped without retrying");
  }
  let resp: Response;
  try {
    resp = await f(url, {
      headers: { "User-Agent": "RefGuard/1.0 (https://github.com/mggrim/refguard)" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
      ...(opts.cacheTtlSeconds
        ? { cf: { cacheTtl: opts.cacheTtlSeconds, cacheEverything: true } }
        : {}),
    } as RequestInit);
  } catch (e) {
    throw new RegistryUnreachable(String(e));
  }
  if (resp.status === 404) return null;
  if (resp.status === 429) {
    const limit = opts.maxRetries ?? MAX_RETRIES;
    if (attempt >= limit) {
      if (breaker && ++breaker.consecutive >= BREAKER_TRIP_AFTER) {
        breaker.trippedUntil = Date.now() + BREAKER_COOLDOWN_MS;
      }
      throw new RegistryUnreachable(`rate limited (HTTP 429 after ${limit + 1} attempts)`);
    }
    const base = opts.retryBaseMs ?? RETRY_BASE_MS;
    const retryAfter = Number(resp.headers.get("retry-after"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, RETRY_CAP_MS)
      : Math.min(base * 2 ** attempt, RETRY_CAP_MS);
    await new Promise((r) => setTimeout(r, waitMs));
    return registryGet(url, opts, attempt + 1);
  }
  if (!resp.ok) throw new RegistryUnreachable(`HTTP ${resp.status}`);
  if (breaker) breaker.consecutive = 0;
  return resp.json();
}
