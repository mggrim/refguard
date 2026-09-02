const STOPWORDS = new Set(["the", "a", "an", "of", "and", "in", "on", "for", "to", "with"]);

export function normalize(s: string): string {
  return s
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

export function authorOverlap(claimed: string[], truth: string[]): number {
  if (!claimed.length || !truth.length) return -1;
  const truthSet = new Set(truth.map(surnameKey));
  const hits = claimed.filter((c) => truthSet.has(surnameKey(c))).length;
  return hits / claimed.length;
}

export function normDoi(doi: string): string {
  return doi
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
}
