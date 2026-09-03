/**
 * Crossref — the article registry.
 *
 * OpenAlex meters by credit: a title search costs ten times a DOI lookup and the
 * free allowance is about a hundred searches a day for a whole deployment. A
 * management bibliography carries almost no DOIs, so every entry is a search, and
 * one person checking one manuscript exhausted the day for everyone.
 *
 * Crossref's polite pool advertises 3 requests a second with no daily cap, which is
 * the difference between a tool that works in public and one that does not. It also
 * reports a work `type` from the publisher's own deposit, which is better evidence
 * than guessing a reference's kind from its punctuation.
 *
 * It does NOT carry a retraction flag in a form worth trusting here, so a Crossref
 * match is confirmed against OpenAlex by DOI afterwards, which costs nothing.
 */
import type { RefEntry, Truth } from "./types.ts";
import { authorOverlap, normDoi, titleSim } from "./match.ts";
import { RegistryUnreachable, SEARCH_ACCEPT, type RegistryOptions, type SearchMatch } from "./registry.ts";

const ENDPOINT = "https://api.crossref.org/works";
const SELECT = "DOI,title,author,issued,container-title,type";

interface CrossrefItem {
  DOI?: string;
  title?: string[];
  author?: Array<{ family?: string; name?: string }>;
  issued?: { "date-parts"?: number[][] };
  "container-title"?: string[];
  type?: string;
}

/** Crossref's own work type, which beats guessing from the reference string. */
export function crossrefIsBookish(type: string | undefined): boolean {
  return Boolean(type && /^(book|monograph|edited-book|reference-book|book-chapter|book-part|book-section)$/.test(type));
}

function itemToTruth(item: CrossrefItem): Truth {
  const year = item.issued?.["date-parts"]?.[0]?.[0];
  return {
    source: "crossref",
    title: item.title?.[0] ?? "",
    year: year ? String(year) : "",
    journal: item["container-title"]?.[0] ?? "",
    doi: normDoi(item.DOI ?? ""),
    authors: (item.author ?? [])
      .map((a) => {
        if (a.family) return a.family;
        const parts = (a.name ?? "").trim().split(/\s+/);
        return parts[parts.length - 1] ?? "";
      })
      .filter(Boolean),
    // Crossref exposes retractions only through linked update records, which are
    // patchy. OpenAlex is asked by DOI afterwards, and that lookup is free.
    retracted: false,
    id: item.DOI ? `https://doi.org/${item.DOI}` : undefined,
    type: item.type,
  };
}

/**
 * Best matching work, or null when nothing clears the bar. `query.bibliographic`
 * is Crossref's whole-reference matcher and handles a raw reference string better
 * than a title-only query, so the raw entry is preferred when available.
 */
export async function crossrefSearch(
  entry: RefEntry,
  opts: RegistryOptions = {},
): Promise<SearchMatch | null> {
  const f = opts.fetchFn ?? fetch;
  const query = (entry.raw && entry.raw.length > entry.title.length ? entry.raw : entry.title).slice(0, 400);
  if (!query.trim()) return null;
  const url = `${ENDPOINT}?query.bibliographic=${encodeURIComponent(query)}&rows=5&select=${SELECT}` +
    (opts.mailto ? `&mailto=${encodeURIComponent(opts.mailto)}` : "");
  let resp: Response;
  try {
    resp = await f(url, {
      headers: { "User-Agent": "RefGuard/1.0 (https://github.com/mggrim/refguard)" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
    });
  } catch (e) {
    throw new RegistryUnreachable(`Crossref: ${String(e)}`);
  }
  if (resp.status === 404) return null;
  if (resp.status === 429) throw new RegistryUnreachable("Crossref rate limited (HTTP 429)");
  if (!resp.ok) throw new RegistryUnreachable(`Crossref HTTP ${resp.status}`);
  const data = (await resp.json()) as { message?: { items?: CrossrefItem[] } };

  let best: Truth | null = null;
  let bestScore = 0;
  for (const item of data.message?.items ?? []) {
    const t = itemToTruth(item);
    let score = entry.title ? titleSim(entry.title, t.title) : 0;
    const overlap = authorOverlap(entry.authors, t.authors);
    if (overlap >= 0) score = score * 0.7 + overlap * 0.3;
    if (entry.year && t.year && Math.abs(Number(entry.year) - Number(t.year)) <= 1) score += 0.05;
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return bestScore >= SEARCH_ACCEPT && best ? { truth: best, score: Math.min(1, bestScore) } : null;
}
