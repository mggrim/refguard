/**
 * Crossref — the article registry.
 *
 * This is the only article registry the tool uses. OpenAlex was the original and
 * was removed: it meters by credit, a title search cost ten times a DOI lookup, and
 * the free allowance was about a hundred searches a day for an ENTIRE deployment.
 * A management bibliography carries almost no DOIs, so every entry is a search, and
 * one person checking one manuscript exhausted the day for everyone.
 *
 * Crossref's polite pool advertises 3 requests a second with no daily cap, which is
 * the difference between a tool that works in public and one that does not. It also
 * reports a work `type` from the publisher's own deposit, which is better evidence
 * than guessing a reference's kind from its punctuation.
 *
 * It also publishes the Retraction Watch database, which it acquired, so a
 * retraction comes back inside the search response at no extra cost.
 */
import type { RefEntry, Truth } from "./types.ts";
import { authorOverlap, normDoi, titleSim } from "./match.ts";
import { registryGet, SEARCH_ACCEPT, type RegistryOptions, type SearchMatch } from "./registry.ts";

const ENDPOINT = "https://api.crossref.org/works";
// `updated-by` carries the Retraction Watch record, so a retraction comes back
// inside the search response and costs no extra call.
const SELECT = "DOI,title,author,issued,container-title,type,updated-by";

interface CrossrefItem {
  DOI?: string;
  title?: string[];
  author?: Array<{ family?: string; name?: string }>;
  issued?: { "date-parts"?: number[][] };
  "container-title"?: string[];
  type?: string;
  "updated-by"?: Array<{ type?: string; source?: string; DOI?: string }>;
}

/**
 * Crossref publishes the Retraction Watch database it acquired, as `updated-by`
 * entries on the retracted work. A "correction" is not a retraction, so match the
 * type exactly rather than treating any update as one.
 */
export function isRetracted(item: { "updated-by"?: Array<{ type?: string }> }): boolean {
  return (item["updated-by"] ?? []).some((u) => u.type === "retraction");
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
    retracted: isRetracted(item),
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
  const query = (entry.raw && entry.raw.length > entry.title.length ? entry.raw : entry.title).slice(0, 400);
  if (!query.trim()) return null;
  const url = `${ENDPOINT}?query.bibliographic=${encodeURIComponent(query)}&rows=5&select=${SELECT}` +
    (opts.mailto ? `&mailto=${encodeURIComponent(opts.mailto)}` : "");
  const data = (await registryGet(url, opts)) as { message?: { items?: CrossrefItem[] } } | null;

  let best: Truth | null = null;
  let bestScore = 0;
  for (const item of data?.message?.items ?? []) {
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

/** Direct DOI lookup. Returns null for a DOI Crossref does not hold. */
export async function crossrefByDoi(doi: string, opts: RegistryOptions = {}): Promise<Truth | null> {
  const url = `${ENDPOINT}/${encodeURIComponent(doi)}` + (opts.mailto ? `?mailto=${encodeURIComponent(opts.mailto)}` : "");
  const data = (await registryGet(url, opts)) as { message?: CrossrefItem } | null;
  if (!data) return null;
  return data.message ? itemToTruth(data.message) : null;
}
