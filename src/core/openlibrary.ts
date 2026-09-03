/**
 * Open Library — the book registry.
 *
 * OpenAlex and Crossref index the serial literature. The monographs a management
 * bibliography leans on (Weick 1995, Glaser and Strauss 1967, Marshall and Rossman
 * 1989) mostly predate DOI registration, so neither registry can confirm them, and
 * an unconfirmed book looks identical to a fabricated one. Open Library covers them,
 * is free, and needs no key.
 *
 * It also carries an edition count, which settles the argument a year gap on a book
 * always starts: a work with five editions between 1989 and 2016 has five correct
 * years, and reporting the gap as an error is wrong.
 */
import type { RefEntry, Truth } from "./types.ts";
import { authorOverlap, titleSim } from "./match.ts";
import { RegistryUnreachable, SEARCH_ACCEPT, type RegistryOptions, type SearchMatch } from "./registry.ts";

const ENDPOINT = "https://openlibrary.org/search.json";
const FIELDS = "title,author_name,first_publish_year,edition_count,key";

interface OpenLibraryDoc {
  title?: string;
  author_name?: string[];
  first_publish_year?: number;
  edition_count?: number;
  key?: string;
}

/**
 * Open Library's search returns NOTHING for a query carrying the parenthetical and
 * edition furniture a bibliography puts in a title: "Sensemaking in organizations
 * (Vol. 3) Weick" matched zero documents while "sensemaking in organizations weick"
 * matched the right book. Strip the furniture before asking.
 */
export function bookQuery(entry: RefEntry): string {
  const title = (entry.title || "")
    .replace(/\([^)]*\)/g, " ")                                   // (Vol. 3), (2nd ed.)
    .replace(/\b\d(?:st|nd|rd|th)\s+ed(?:ition|\.)?/gi, " ")      // 3rd edition
    .replace(/\bvol(?:ume)?\.?\s*\d+/gi, " ")                     // Vol. 3
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")                          // punctuation confuses the parser
    .replace(/\s+/g, " ")
    .trim();
  return [title, entry.authors[0] ?? ""].filter(Boolean).join(" ").slice(0, 300);
}

function docToTruth(doc: OpenLibraryDoc): Truth {
  return {
    source: "openlibrary",
    title: doc.title ?? "",
    // The earliest printing. Later editions are legitimate alternative years,
    // which is what `editions` exists to say.
    year: doc.first_publish_year ? String(doc.first_publish_year) : "",
    journal: "", // a book has no venue, so venue comparison has nothing to contest
    doi: "",
    authors: (doc.author_name ?? []).map((n) => {
      const parts = n.trim().split(/\s+/);
      return parts[parts.length - 1] ?? "";
    }),
    retracted: false, // Open Library records no retractions; books are not retracted this way
    id: doc.key ? `https://openlibrary.org${doc.key}` : undefined,
    editions: doc.edition_count,
  };
}

/**
 * Best matching book, or null when nothing clears the acceptance bar. Scored the
 * same way as the article search so the two are comparable: title similarity
 * carrying most of the weight, author agreement the rest.
 */
export async function openLibrarySearch(
  entry: RefEntry,
  opts: RegistryOptions = {},
): Promise<SearchMatch | null> {
  const f = opts.fetchFn ?? fetch;
  const query = bookQuery(entry);
  if (!query.trim()) return null;
  const url = `${ENDPOINT}?q=${encodeURIComponent(query)}&limit=5&fields=${FIELDS}`;
  let resp: Response;
  try {
    resp = await f(url, {
      headers: { "User-Agent": "RefGuard/1.0" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
    });
  } catch (e) {
    throw new RegistryUnreachable(`Open Library: ${String(e)}`);
  }
  if (resp.status === 404) return null;
  if (!resp.ok) throw new RegistryUnreachable(`Open Library HTTP ${resp.status}`);
  const data = (await resp.json()) as { docs?: OpenLibraryDoc[] };

  let best: Truth | null = null;
  let bestScore = 0;
  for (const doc of data.docs ?? []) {
    const t = docToTruth(doc);
    let score = entry.title ? titleSim(entry.title, t.title) : 0;
    const overlap = authorOverlap(entry.authors, t.authors);
    if (overlap >= 0) score = score * 0.7 + overlap * 0.3;
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return bestScore >= SEARCH_ACCEPT && best ? { truth: best, score: Math.min(1, bestScore) } : null;
}
