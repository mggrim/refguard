import type { RefEntry } from "./types.ts";
import { normDoi } from "./match.ts";

/**
 * DOIs may legally contain parentheses — Elsevier and Lancet DOIs routinely do
 * (10.1016/S0140-6736(97)11096-0). Excluding them truncated such a DOI mid-string,
 * and a truncated DOI resolves to a DIFFERENT registered work, which produced a
 * confident INCONSISTENT verdict against the wrong paper. So parentheses are
 * allowed here and `trimDoiTail` removes the trailing punctuation this admits.
 */
export const DOI_RE = /\b10\.\d{4,9}\/[^\s"'<>,;]+/;

/** Drop sentence punctuation and unbalanced closing parens from a scraped DOI. */
export function trimDoiTail(doi: string): string {
  let d = doi;
  for (;;) {
    const last = d[d.length - 1];
    if (!last) break;
    if (".,;:".includes(last)) { d = d.slice(0, -1); continue; }
    const opens = (d.match(/\(/g) ?? []).length;
    const closes = (d.match(/\)/g) ?? []).length;
    if (last === ")" && closes > opens) { d = d.slice(0, -1); continue; }
    break;
  }
  return d;
}
const YEAR_RE = /\((\d{4})[a-z]?\)|\b(19|20)\d{2}\b/;

/** Brace-balanced BibTeX parser. Survives nested braces, bare values, quoted values. */
export function parseBib(text: string): RefEntry[] {
  const entries: RefEntry[] = [];
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf("@", i);
    if (at < 0) break;
    const braceOpen = text.indexOf("{", at);
    if (braceOpen < 0) break;
    const type = text.slice(at + 1, braceOpen).trim().toLowerCase();
    let depth = 1;
    let j = braceOpen + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}") depth--;
      j++;
    }
    const body = text.slice(braceOpen + 1, j - 1);
    i = j;
    if (["comment", "preamble", "string"].includes(type)) continue;
    const comma = body.indexOf(",");
    if (comma < 0) continue;
    const key = body.slice(0, comma).trim();
    const fields = parseBibFields(body.slice(comma + 1));
    entries.push({
      key,
      title: stripBraces(fields["title"] ?? ""),
      authors: bibAuthorFamilies(fields["author"] ?? ""),
      year: (fields["year"] ?? "").replace(/\D/g, "").slice(0, 4),
      journal: stripBraces(fields["journal"] ?? fields["booktitle"] ?? ""),
      doi: normDoi(fields["doi"] ?? ""),
      raw: text.slice(at, j),
    });
  }
  return entries;
}

/** Field parser that balances braces and accepts bare values (year = 2020). */
function parseBibFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let i = 0;
  while (i < body.length) {
    const eq = body.indexOf("=", i);
    if (eq < 0) break;
    const name = body.slice(i, eq).replace(/[,\s]/g, "").toLowerCase();
    let j = eq + 1;
    while (j < body.length && /\s/.test(body[j]!)) j++;
    let value = "";
    if (body[j] === "{") {
      let depth = 1;
      const start = ++j;
      while (j < body.length && depth > 0) {
        if (body[j] === "{") depth++;
        else if (body[j] === "}") depth--;
        j++;
      }
      value = body.slice(start, j - 1);
    } else if (body[j] === '"') {
      const start = ++j;
      while (j < body.length && body[j] !== '"') j++;
      value = body.slice(start, j);
      j++;
    } else {
      const start = j;
      while (j < body.length && body[j] !== "," && body[j] !== "\n") j++;
      value = body.slice(start, j).trim();
    }
    if (name) fields[name] = value.replace(/\s+/g, " ").trim();
    i = j + 1;
  }
  return fields;
}

function stripBraces(s: string): string {
  return s.replace(/[{}]/g, "").trim();
}

function bibAuthorFamilies(author: string): string[] {
  return stripBraces(author)
    .split(/\s+and\s+/i)
    .map((a) => {
      const comma = a.indexOf(",");
      if (comma >= 0) return a.slice(0, comma).trim();
      const parts = a.trim().split(/\s+/);
      return parts[parts.length - 1] ?? "";
    })
    .filter(Boolean);
}

/**
 * A block only counts as a reference if it opens in one of the two author-date
 * shapes below. Table rows, appendix text and quotes that merely contain a year
 * match neither, which keeps the parser from auditing a manuscript's tables.
 *
 * APA and friends put the year in parentheses, early, before any other bracket:
 *   Tolbert, P. S., & Zucker, L. G. (1983). Institutional sources of change...
 */
const REF_SHAPE_APA = /^[^()]{0,250}\(\d{4}[a-z]?\)/;

/**
 * Academy of Management style — the house style of AMJ, AMR, JOM and the Annals —
 * puts a bare year after the authors, so a parenthesis-only test finds nothing in
 * an entire AoM-formatted bibliography. Real drafts also mix in accented surnames,
 * multi-word surnames, and initials with or without periods:
 *   Acs, Z. J., & Audretsch, D. B. 1988. Innovation in large and small firms...
 *   Barthelemy, J. 2017. The impact of technical consultants...
 *   Van de Ven, A. H. 1986. Central problems in the management of innovation...
 *   Battilana J, Dorado S. 2010. Building sustainable hybrid organizations...
 */
const AOM_OPENER =
  /^(?:\p{Ll}{2,4}\s+)?(\p{Lu}[\p{L}\p{M}'\u2019.,&()\- ]{2,240}?)\b(?:19|20)\d{2}[a-z]?(?:,\s*\p{Lu}\p{Ll}+\.?(?:\s+\d{1,2})?)?\.\s/u;

/** The author run ends in an initial, an "et al.", or an "(Eds.)". */
const AOM_AUTHOR_TAIL = /(?:\p{Lu}{1,3}\.|al\.|\(Eds?\.\)\.?)\s*$/u;

/**
 * A reference is a name run followed by a year and a period. Requiring the run to
 * end the way an author list ends is what separates it from a sentence that merely
 * finishes on a year, such as "The firm doubled its headcount in 1998." The shapes
 * below all appear in real submitted drafts:
 *
 *   Acs, Z. J., & Audretsch, D. B. 1988. Innovation in large and small firms...
 *   Barthelemy, J. 2017. The impact of technical consultants...          (accents)
 *   Van de Ven, A. H. 1986. Central problems in the management...   (multi-word)
 *   Battilana J, Dorado S. 2010. Building sustainable hybrid...   (no periods)
 *   van Werven, R., & Cornelissen, J. P. 2015. The power of arguments... (particle)
 *   Gehman, J., ... Langley, A., et al. 2018. Finding theory-method fit...
 *   Lockwood, C., & Soubliere, J.-F. (Eds.). 2022. Advances in...       (editors)
 *   Blank, S. 2013, May 1. Why the lean start-up changes everything.   (dated)
 *
 * An institutional author with no initials ("World Bank. 2020. ...") is skipped
 * rather than guessed at; every run reports how many entries it found.
 */
function looksLikeAomEntry(block: string): boolean {
  const m = AOM_OPENER.exec(block);
  return m ? AOM_AUTHOR_TAIL.test(m[1]!) : false;
}

const looksLikeReference = (b: string) => REF_SHAPE_APA.test(b) || looksLikeAomEntry(b);

/** Heuristic parser for a pasted reference list (APA-shaped; one entry per line or paragraph). */
export function parseTextRefs(text: string): RefEntry[] {
  // Word leaves the citation manager's field code inline; both wreck the first entry.
  const cleaned = text
    .replace(/ADDIN ZOTERO_BIBL.*?CSL_BIBLIOGRAPHY\s*/gs, "")
    .replace(/ADDIN EN\.REFLIST\s*/g, "");
  const blocks = cleaned
    .split(/\n\s*\n|\r\n\s*\r\n/)
    .flatMap((b) => (b.length > 400 && b.includes("\n") ? b.split("\n") : [b]))
    .map((b) => b.replace(/\s+/g, " ").trim())
    .filter((b) => b.length > 40 && YEAR_RE.test(b) && looksLikeReference(b));
  const used = new Set<string>();
  return blocks.map((raw, idx) => {
    const doi = normDoi(trimDoiTail(raw.match(DOI_RE)?.[0] ?? ""));
    const yearMatch = raw.match(/\((\d{4})[a-z]?\)/) ?? raw.match(/\b((19|20)\d{2})\b/);
    const year = yearMatch ? (yearMatch[1] ?? yearMatch[0]!) : "";
    // Split the block at the year, which sits between the authors and the title in
    // both shapes: "… (1983). Title" and "… 1983. Title".
    const paren = year ? raw.indexOf(`(${year}`) : -1;
    const bare = year && paren < 0 ? raw.indexOf(year) : -1;
    const yearStart = paren >= 0 ? paren : bare;
    const yearEnd = paren >= 0 ? raw.indexOf(")", paren) + 1 : bare + year.length;
    const authorSeg = yearStart > 0 ? raw.slice(0, yearStart) : "";
    // A year may be qualified by a month and day ("2013, May 1."). That is part of
    // the date, not the start of the title.
    const afterYear = (yearStart >= 0 ? raw.slice(yearEnd) : raw)
      .replace(/^[a-z]?,\s*\p{Lu}\p{Ll}+\.?(?:\s+\d{1,2})?/u, "");
    const title = (afterYear.replace(/^[.\s]+/, "").split(/(?<=[a-z0-9])\.\s/)[0] ?? "").trim();
    const authors = [...authorSeg.matchAll(/([A-Z][A-Za-z'’-]+),/g)].map((m) => m[1]!);
    return { key: citationKey(authors[0], year, idx, used), title, authors, year, journal: "", doi, raw };
  });
}

/**
 * A readable key for a text-parsed entry: first author family + year ("tolbert1983"),
 * falling back to a positional key when neither is available. Duplicates get a letter
 * suffix so two entries never collide in the results.
 */
function citationKey(author: string | undefined, year: string, idx: number, used: Set<string>): string {
  const stem = author ? author.toLowerCase().replace(/[^a-z]/g, "") : "";
  let key = stem ? `${stem}${year}` : `ref${idx + 1}`;
  if (used.has(key)) {
    let n = 1;
    while (used.has(`${key}${String.fromCharCode(96 + n)}`)) n++;
    key = `${key}${String.fromCharCode(96 + n)}`;
  }
  used.add(key);
  return key;
}

/**
 * Find where a manuscript's reference list begins. The heading is matched on its
 * own line and may carry a trailing note, because drafts really do say things like
 * "REFERENCES - TO RE DO; IGNORE". Returns null when no heading is present, so the
 * caller can say so rather than silently auditing the whole manuscript: prose that
 * opens "Smith (2010) argued..." parses as a reference and produces junk entries.
 */
export function referencesSection(text: string): string | null {
  const m = text.match(/\n[ \t]*(?:REFERENCES|References|REFERENCE LIST|Bibliography|BIBLIOGRAPHY|Works Cited|WORKS CITED)\b[^\n]{0,60}\n/);
  return m ? text.slice(m.index! + m[0].length) : null;
}
