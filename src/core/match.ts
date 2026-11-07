import type { Truth } from "./types.ts";

const STOPWORDS = new Set(["the", "a", "an", "of", "and", "in", "on", "for", "to", "with"]);

export function normalize(s: string): string {
  return s
    // Crossref titles can carry JATS markup ("The <i>Selfish</i> Gene"); the tag
    // names are not words of the title.
    .replace(/<[^>]+>/g, " ")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[{}\\'"]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokens(s: string): string[] {
  return normalize(s)
    .split(" ")
    .filter((t) => t && !STOPWORDS.has(t));
}

/**
 * How much a title can identify a work on its own. "Designing Qualitative Research"
 * carries three ordinary words that many works share; "Building Sustainable Hybrid
 * Organizations: The Case of Commercial Microfinance Organizations" carries eight
 * that essentially one work shares. Below the threshold, a title match is a guess.
 */
export function titleDistinctiveness(title: string): number {
  return tokens(title).length;
}

/** Fewer significant tokens than this and a title alone cannot identify a work. */
export const GENERIC_TITLE_TOKENS = 5;

/** Symmetric token similarity with containment credit (handles dropped subtitles). */
export function titleSim(a: string, b: string): number {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (!ta.size || !tb.size) return 0;
  const inter = [...ta].filter((t) => tb.has(t)).length;
  const jaccard = inter / (ta.size + tb.size - inter);
  const containment = inter / Math.min(ta.size, tb.size);
  return Math.max(jaccard, containment);
}

/**
 * Venue comparison, deliberately strict on distinctive tokens so near-twin
 * journals ("… Review" vs "… Journal") never fuzzy-match: every non-stopword
 * token on the shorter side must appear on the longer side.
 */
export function journalMatch(a: string, b: string): boolean {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return true; // one side unknown → cannot contest
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const longSet = new Set(long);
  return short.every((t) => longSet.has(t));
}

/** Fraction of claimed family names confirmed by truth family names; -1 when either side unknown. */
/**
 * Nobility and toponymic particles ride with the surname in some registries and
 * some bibliographies and not others: "van Lente" against "Lente" is the same
 * person, and reporting it as an author mismatch is a false positive.
 */
const NAME_PARTICLES = /^(?:van|von|de|del|della|der|den|di|da|dos|du|la|le|el|al|bin|ben|st|mac|mc)\s+/;

/**
 * Surname key for comparison: accents folded, particles stripped, and reduced to
 * the final token so a compound surname matches its short form. Registries and
 * bibliographies disagree constantly about both ends of a name — "van Lente"
 * against "Lente", "Long Lingo" against "Lingo" — and each disagreement was
 * reported as an author mismatch on a perfectly good reference.
 */
export function surnameKey(name: string): string {
  // Drop apostrophes before normalising: the straight one is deleted by normalize
  // and the curly one becomes a space, so O'Mahony and O’Mahony keyed differently.
  let n = normalize(name.replace(/['\u2018\u2019\u02bc]/g, ""));
  for (;;) {
    const stripped = n.replace(NAME_PARTICLES, "");
    if (stripped === n) break;
    n = stripped;
  }
  const parts = n.split(" ").filter(Boolean);
  return parts[parts.length - 1] ?? n;
}

/**
 * Words of the record's title that the cited title leaves out, when the cited title
 * is otherwise a subset of the record's. `subtitle` is true when what is left out
 * is exactly the subtitle, the part after the record's first colon or question
 * mark. Similarity alone cannot see either case: the containment credit that
 * forgives a dropped subtitle scores a shortened title as identical.
 */
export function titleGap(cited: string, record: string): { missing: string[]; subtitle: boolean } {
  const c = new Set(tokens(cited));
  const r = tokens(record);
  if (!c.size || !r.length) return { missing: [], subtitle: false };
  // Only when every cited word is in the record; a reworded title is a different case.
  if ([...c].some((t) => !r.includes(t))) return { missing: [], subtitle: false };
  const missing = [...new Set(r.filter((t) => !c.has(t) && t.length > 1))];
  if (!missing.length) return { missing, subtitle: false };
  const cut = record.search(/[:?]\s/);
  const main = cut > 0 ? new Set(tokens(record.slice(0, cut + 1))) : null;
  const subtitle = Boolean(main && main.size && [...main].every((t) => c.has(t)) && [...c].every((t) => main.has(t)));
  return { missing, subtitle };
}

/** The record's authors that the cited list leaves out, in the record's order. */
export function missingAuthors(claimed: string[], truth: string[]): string[] {
  const have = new Set(claimed.map(surnameKey));
  const seen = new Set<string>();
  return truth.filter((t) => {
    const k = surnameKey(t);
    if (!k || have.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** A cited list that says it is shortened: "et al.", an ellipsis, BibTeX "and others". */
export const TRUNCATED_AUTHORS = /\bet\s+al\b|\band\s+others\b|\.\.\.|…/i;

export function authorOverlap(claimed: string[], truth: string[]): number {
  if (!claimed.length || !truth.length) return -1;
  const truthSet = new Set(truth.map(surnameKey));
  const hits = claimed.filter((c) => truthSet.has(surnameKey(c))).length;
  return hits / claimed.length;
}

/**
 * Every year a record can rightly be cited under, falling back to its one reported
 * year. A blank or zero year is no year at all, never a year to compare against.
 */
export function knownYears(t: Pick<Truth, "year" | "years">): number[] {
  const ys = t.years?.length ? t.years : [Number(t.year)];
  return ys.filter((y) => Number.isInteger(y) && y > 1000);
}

export function normDoi(doi: string): string {
  return doi
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
}
