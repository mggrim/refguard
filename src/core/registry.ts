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
}

async function openalexGet(url: string, opts: RegistryOptions): Promise<unknown | null> {
  const f = opts.fetchFn ?? fetch;
  const full = opts.mailto
    ? `${url}${url.includes("?") ? "&" : "?"}mailto=${encodeURIComponent(opts.mailto)}`
    : url;
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
    await new Promise((r) => setTimeout(r, 2000));
    return openalexGet(url, opts);
  }
  if (!resp.ok) throw new RegistryUnreachable(`HTTP ${resp.status}`);
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
