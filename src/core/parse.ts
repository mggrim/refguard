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

// ---------- reference lists in plain text ----------
//
// A pasted reference list arrives in whatever shape its source left it: one
// reference per paragraph from Word, or lines wrapped mid-reference from a PDF,
// with two references run onto one line, page headers and line numbers in the
// middle, and tables and author bios after the last entry. Splitting on line
// breaks read 75 of the 132 references in one real AMJ list. So the reader works
// out the list's style first, then splits where a reference STARTS (in an
// author-date list, an author block followed by a year), and counts the year
// markers separately, so a reference it failed to split out is reported instead
// of being merged silently into its neighbour.

export type RefStyle = "author-date" | "numbered" | "mla";

export interface ParseWarning {
  kind: "count" | "merged" | "long" | "no-year" | "skipped-year";
  /** The entry the warning is about, when it is about one. */
  key?: string;
  message: string;
}

export interface ReferenceList {
  entries: RefEntry[];
  style: RefStyle;
  /** How many references the text appears to hold, counted without the splitter. */
  expected: number;
  warnings: ParseWarning[];
  /** Text that was read and set aside: headings, page furniture, tables, bios. */
  skipped: string[];
}

const R = String.raw;

// Surnames: accents, apostrophes and hyphens (O’Connor, Aragón-Correa), a
// lowercase or capitalised particle (van Werven, Van de Ven, El Khatib), and up to
// three words (Zuckerman Sivan, Saltuk Lamy).
const PARTICLE = R`(?:(?:[Vv]an|[Vv]on|[Dd]e|[Dd]el|[Dd]ella|[Dd]er|[Dd]en|[Dd]i|[Dd]a|[Dd]u|[Dd]os|[Ll]a|[Ll]e|[Ee]l|[Aa]l|[Bb]in|[Bb]en|St\.)\s+)`;
const WORD = R`\p{Lu}[\p{L}\p{M}'’\-]*[\p{L}\p{M}]`;
// Later words of a surname carry lowercase letters, so "Besharov ML" is a surname
// and its initials, not a two-word surname.
const SURNAME = R`${PARTICLE}*${WORD}(?:\s\p{Lu}[\p{Ll}'’][\p{L}\p{M}'’\-]*){0,2}`;
// "P. S.", "J.-F.", "R.M", "KM": initials, with or without periods, never the
// first letter of a word ("Journal, The …").
const INITIALS = R`\p{Lu}\.?(?:\s?-?\s?\p{Lu}\.?){0,3}(?![\p{Ll}])`;
// Chicago and MLA spell the given name out: "Mark S.", "Wendy Nelson", "W. Richard".
const GIVEN = R`(?:\p{Lu}\.\s?)*\p{Lu}\p{Ll}+(?:-\p{Lu}\p{Ll}+)?(?:\s(?:\p{Lu}\.|\p{Lu}\p{Ll}+)){0,2}`;
// A nickname in parentheses ("Hinings, C. R. (Bob)"), never a year or "(Eds.)".
const NICK = R`(?:\s*\((?!\d|[Ee]ds?\.?\))[^()]{1,20}\))`;
const UNIT_INV = R`(?:\p{Lu}\.\s?){0,2}${SURNAME},\s*(?:${INITIALS}|${GIVEN})${NICK}?`;
const UNIT_NAT = R`(?:(?:\p{Lu}\.\s?)+|\p{Lu}\p{Ll}+\s(?:\p{Lu}\.\s?)*)${SURNAME}`;
const UNIT_COMPACT = R`${SURNAME}\s\p{Lu}{1,3}(?![\p{L}])`;
const SEP = R`(?:\s*,\s*(?:&\s*|and\s+)?|\s*&\s*|\s+and\s+)`;
const ETAL = R`(?:\s*,?\s*(?:et\s+al\.?|\.\.\.|…)(?:\s*,?\s*(?:&\s*)?${UNIT_INV})?)`;
const EDS = R`(?:\s*,?\s*\([Ee]ds?\.?\)|\s*,\s*[Ee]ds?\.)`;
const BLOCK = R`(?:${UNIT_INV}|${UNIT_COMPACT})(?:${SEP}(?:${UNIT_INV}|${UNIT_NAT}|${UNIT_COMPACT})){0,30}${ETAL}?${EDS}?`;

const YEARNUM = R`(?:1[5-9]|20)\d{2}[a-z]?`;
const YEARWORD = R`(?:[Ii]n\s[Pp]ress|[Ff]orthcoming|n\.\s?d\.)`;
// "2013, May 1", "(2015, December)": a date, not the start of the title.
const MD = R`(?:,\s*\p{Lu}\p{Ll}+\.?(?:\s\d{1,2}(?:[–-]\d{1,2})?)?)`;
// APA and Harvard put the year in parentheses; AMJ, ASQ and Chicago put it bare
// after the authors with a full stop; Harvard sometimes puts it bare with a comma.
const PAREN_MARK = R`\s*\.?\s*\((${YEARNUM}|${YEARWORD})${MD}?\)\s*[.,:]?`;
const BARE_MARK = R`\.?\s+(${YEARNUM}|${YEARWORD})${MD}?(?:(?<=\.)(?=\s|$)|\.(?=\s|$)|,(?=\s))`;
const START_PERSON = new RegExp(R`(${BLOCK})(?:${PAREN_MARK}|${BARE_MARK})`, "uy");

// An organisation as author: "B Lab. 2021a.", "World Economic Forum (2012).",
// "KPMG (2019).". A word year is not accepted here, because "Organization Science
// (forthcoming)." at the end of a reference would otherwise start a new one.
const CORP = R`\p{Lu}[\p{L}\p{N}&'’\-]*(?:\s(?:(?:of|for|and|the|on|in|de|du|des|&)\s)?\p{Lu}[\p{L}\p{N}&'’\-]*){0,7}`;
const CORP_YEAR = R`(?:${YEARNUM}|n\.\s?d\.)`;
const START_CORP = new RegExp(
  R`(${CORP})(?:\s*\.?\s*\((${CORP_YEAR})${MD}?\)\s*[.,:]?|\.\s+(${CORP_YEAR})${MD}?(?:(?<=\.)(?=\s|$)|\.(?=\s|$)))`,
  "uy",
);

// MLA puts no year after the authors: "Weick, Karl E. Sensemaking in Organizations."
const GIVEN_MLA = R`\p{Lu}\p{Ll}+(?:-\p{Lu}\p{Ll}+)?(?:\s(?:\p{Lu}\.|\p{Lu}\p{Ll}+))?`;
const START_MLA = new RegExp(
  R`(${SURNAME},\s+${GIVEN_MLA}(?:,?\s+(?:and\s+${UNIT_NAT}|et\s+al\.?))?)(?:\.|(?<=\.))\s+(?=[“"‘\p{Lu}])`,
  "uy",
);

/**
 * Year markers, counted on their own so the count does not depend on the splitter:
 * a year in parentheses, or a bare year straight after a full stop. A year inside
 * a title ("1880–1935", "the 1964 Civil Rights Act") or a date after the venue
 * ("6 January, 2022") is neither, and nor is a year in parentheses before a colon,
 * which is a venue's issue date ("4, no. 1 (1987): 43-49").
 */
const MARKER_RE = new RegExp(
  R`\((?:${YEARNUM})${MD}?\)(?!\s*:)|(?<=\.\s?)\((?:${YEARWORD})\)|(?<=[.)]\s)(?:${YEARNUM})${MD}?(?:\.(?=\s|$)|,(?=\s))|(?<=\.\s)${YEARWORD}(?=[.\s])`,
  "gu",
);
const countMarkers = (s: string) => (s.match(MARKER_RE) ?? []).length;

// Where a new reference may begin: the start of a line, or after the end of a
// sentence or of a URL or DOI.
const BOUNDARY_BEFORE = /(?:[.?!)\]"”’]|(?:https?:\/\/|www\.|\b10\.\d{4,9}\/)\S*)\s+$/u;
const WORD_START = /(?<=^|\s)(?=\p{Lu}|(?:[Vv]an|[Vv]on|[Dd]e|[Dd]el|[Dd]er|[Dd]en|[Dd]i|[Dd]a|[Dd]u|[Ll]a|[Ll]e|[Ee]l|[Aa]l)\s)/gu;

interface Start {
  at: number;
  end: number;
  block: string;
  /** The year as written: "2019", "2021a", "in press", "n.d.". Empty for MLA. */
  yearToken: string;
  corp: boolean;
  /** Harvard's "Smith, J. 2012, Title": the title then runs to the next comma. */
  commaYear: boolean;
}

function execAt(re: RegExp, s: string, i: number): RegExpExecArray | null {
  re.lastIndex = i;
  return re.exec(s);
}

function startAt(s: string, i: number, style: RefStyle): Start | null {
  if (style === "mla") {
    const m = execAt(START_MLA, s, i);
    return m ? { at: i, end: i + m[0].length, block: m[1]!, yearToken: "", corp: false, commaYear: false } : null;
  }
  const p = execAt(START_PERSON, s, i);
  if (p) {
    return { at: i, end: i + p[0].length, block: p[1]!, yearToken: (p[2] ?? p[3] ?? "").trim(), corp: false,
             commaYear: p[0].endsWith(",") && !p[2] };
  }
  const c = execAt(START_CORP, s, i);
  return c ? { at: i, end: i + c[0].length, block: c[1]!, yearToken: (c[2] ?? c[3] ?? "").trim(), corp: true, commaYear: false } : null;
}

function isBoundary(s: string, i: number, lineStarts: Set<number>): boolean {
  return i === 0 || lineStarts.has(i) || BOUNDARY_BEFORE.test(s.slice(Math.max(0, i - 200), i));
}

function findStarts(s: string, style: RefStyle, lineStarts: Set<number>, needBoundary = true): Start[] {
  const out: Start[] = [];
  let after = 0;
  for (const m of s.matchAll(WORD_START)) {
    const i = m.index!;
    if (i < after || (needBoundary && !isBoundary(s, i, lineStarts))) continue;
    const st = startAt(s, i, style);
    if (st) { out.push(st); after = st.end; }
  }
  return out;
}

// ---------- cleaning ----------

const isNumberRun = (line: string) => {
  const t = line.trim().split(/\s+/);
  if (t.length < 5 || !t.every((x) => /^\d{1,3}$/.test(x))) return false;
  let up = 0;
  for (let k = 1; k < t.length; k++) if (Number(t[k]) === Number(t[k - 1]) + 1) up++;
  return up >= (t.length - 1) * 0.8;
};
/**
 * A margin line number left in the text: a bare number up to 60 at the start or
 * end of a line or before a capitalised word ("1662–1682. 10 Verhaal",
 * "Government: 8 How"). "The 99 percent economy" keeps its number.
 */
function isLineNumber(tok: string, prev: string | undefined, next: string | undefined): boolean {
  if (!/^\d{1,2}$/.test(tok) || Number(tok) > 60) return false;
  if (prev !== undefined && KEEP_NUMBER_AFTER.test(prev)) return false;
  return prev === undefined || next === undefined || /^\p{Lu}/u.test(next);
}
const NUMERIC_TOKEN = /^[-+–(]?\d[\d.,%*+()–-]*$/;
const KEEP_NUMBER_AFTER = /^(?:vol|vols|no|nos|pp?|ch|chap|part|ed|eds|issue|number)\.?$/i;

/**
 * Lines with the page furniture taken out. A proof PDF carries a running header
 * ("Academy of Management Journal Page 50 of 61") and a column of line numbers
 * that copies out as runs of integers and as digits glued to words ("7Vasudeva",
 * "15responsibility"); tables copy out as tab-separated or mostly numeric rows.
 */
function cleanLines(text: string): { lines: string[]; skipped: string[] } {
  const t = text
    .replace(/ADDIN ZOTERO_BIBL.*?CSL_BIBLIOGRAPHY\s*/gs, "")
    .replace(/ADDIN EN\.REFLIST\s*/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/­/g, "")
    .replace(/[   ]/g, " ")
    .replace(/ﬁ/g, "fi")
    .replace(/ﬂ/g, "fl");
  const raw = t.split("\n");
  const lineNumbers = raw.some(isNumberRun);
  const lines: string[] = [];
  const skipped: string[] = [];
  let lastSkipped = false;
  for (const original of raw) {
    let line = original.trim();
    if (!line || isNumberRun(line)) continue;
    const tokens = line.split(/\s+/);
    const tabs = (original.match(/\t/g) ?? []).length;
    const numeric = tokens.filter((x) => NUMERIC_TOKEN.test(x)).length;
    if ((/\bPage\s+\d+\s+of\s+\d+\b/i.test(line) && line.length < 120) || tabs >= 2 ||
        (tokens.length >= 4 && numeric / tokens.length >= 0.6)) {
      // Consecutive furniture lines are one passage, not forty.
      const flat = line.replace(/\s+/g, " ");
      if (lastSkipped) skipped[skipped.length - 1] += ` ${flat}`; else skipped.push(flat);
      lastSkipped = true;
      continue;
    }
    if (lineNumbers) {
      line = line
        .replace(/(^|\s)\d{1,2}(?=\p{L}{3})/gu, "$1")
        .split(/\s+/)
        .filter((tok, k, all) => !isLineNumber(tok, all[k - 1], all[k + 1]))
        .join(" ");
      if (!line) continue;
    }
    // In-line breakage from PDF text: "Socio- Economic", "1150– 1170".
    line = line.replace(/(\p{L})- (\p{L})/gu, "$1-$2").replace(/(\d)\s*([–—-])\s+(\d)/g, "$1$2$3").replace(/\s+/g, " ");
    lines.push(line);
    lastSkipped = false;
  }
  return { lines, skipped };
}

/** Join lines into one stream, mending DOIs, URLs and compounds broken at a line end. */
function joinLines(lines: string[]): { text: string; lineStarts: Set<number> } {
  let text = "";
  const lineStarts = new Set<number>();
  for (const line of lines) {
    if (text) {
      const lastTok = text.slice(text.lastIndexOf(" ") + 1);
      const firstTok = line.split(" ")[0] ?? "";
      const urlish = /(?:https?:\/\/|www\.|doi:|\b10\.\d{4,9}\/)\S*$/i.test(lastTok);
      const brokenUrl = urlish && (/[\/\-_=&?#]$/.test(lastTok) || (/\.$/.test(lastTok) && /^[\p{Ll}\d]/u.test(firstTok)));
      // A line ending in a hyphen before a lowercase word is joined with the
      // hyphen kept. That is right for "self-regulation" and leaves "organiza-
      // tional" as "organiza-tional"; telling the two apart needs a dictionary.
      const hyphenated = /\p{Ll}-$/u.test(lastTok) && /^\p{Ll}/u.test(line);
      if (!brokenUrl && !hyphenated) text += " ";
    }
    lineStarts.add(text.length);
    text += line;
  }
  return { text, lineStarts };
}

// ---------- style ----------

const NUM_CAND = /(?<=^|\s)(?:\[(\d{1,3})\]|(\d{1,3})[.)])(?=\s+\S)/gu;
// A mid-line "8." only starts an entry when an author follows it: "Wernerfelt B.",
// "J. G. March", "Tolbert, P.". Otherwise it is a volume or an issue number.
const AUTHORISH = /^\s+(?:\p{Lu}[\p{L}'’\-]+(?:,|\s\p{Lu}{1,3}[,.\s])|(?:\p{Lu}\.\s?)+\p{Lu}[\p{L}'’\-]+)/u;

function numberedChain(s: string, lineStarts: Set<number>): { positions: number[]; expected: number } {
  const forms: Array<Array<{ n: number; i: number }>> = [[], []];
  for (const m of s.matchAll(NUM_CAND)) {
    const i = m.index!;
    if (m[1] !== undefined) { forms[0]!.push({ n: Number(m[1]), i }); continue; }
    const after = s.slice(i + m[0].length, i + m[0].length + 80);
    if (lineStarts.has(i) || i === 0 || (isBoundary(s, i, lineStarts) && AUTHORISH.test(after))) {
      forms[1]!.push({ n: Number(m[2]), i });
    }
  }
  let best = { positions: [] as number[], expected: 0 };
  for (const cands of forms) {
    if (!cands.length) continue;
    let cur = Math.min(...cands.map((c) => c.n)) - 1;
    const positions: number[] = [];
    for (const c of cands) if (c.n === cur + 1) { positions.push(c.i); cur = c.n; }
    const expected = Math.max(...cands.map((c) => c.n).filter((n) => n <= positions.length * 2));
    if (positions.length > best.positions.length) best = { positions, expected };
  }
  return best;
}

// ---------- fields ----------

const ABBREVIATION = /^(?:vs|v|e\.g|i\.e|cf|No|no|Vol|vol|St|Dr|Mr|Mrs|Ms|Inc|Co|Ltd|Jr|Sr|al|ed|eds|Ed|Eds|pp|p|ch|Ch|U\.S|U\.K)$/;

/**
 * The title, from the text after the year. It ends at the first full stop that
 * ends a sentence (not "vs." or "U.S." or an initial). A "?" or "!" ends it only
 * when what follows is the venue ("Research Policy, 27(5)") or a short title-case
 * name ("BBC News"); a sentence-case run after it is a subtitle ("Fools rush in?
 * The institutional context of industry creation").
 */
function titleOf(after: string, commaYear: boolean): string {
  const rest = after.replace(/^[\s.,:;]+/, "");
  const head = rest.slice(0, 600);
  const quoted = head.match(/^[“"‘'](.+?[,.?!])[”"’']/u) ?? head.match(/^[“"‘'](.+?)[”"’'](?=[,.:;]|\s*$)/u);
  if (quoted) return quoted[1]!.replace(/[,.]$/, "").trim();
  if (commaYear) {
    const c = rest.search(/,\s+(?=\p{Lu})/u);
    if (c > 0) return rest.slice(0, c).trim();
  }
  return sentenceCut(rest);
}

function sentenceCut(rest: string): string {
  const term = /[.?!]["”’]?(?=\s|$)/gu;
  for (const m of rest.matchAll(term)) {
    const j = m.index!;
    const next = rest.slice(j + m[0].length).replace(/^\s+/, "");
    if (rest[j] === ".") {
      const word = rest.slice(rest.lastIndexOf(" ", j - 1) + 1, j).replace(/^[(“"‘]/, "");
      if (ABBREVIATION.test(word) || /^\p{Lu}$/u.test(word)) continue;
      if (next && !/^(?:[\p{Lu}(“"‘\d\[]|https?:|www\.|doi:)/u.test(next)) continue;
    } else if (next) {
      const segment = next.split(/[.?!](?:\s|$)/)[0] ?? "";
      const venue = /,\s*\d|\d+\s*\(\d/.test(segment);
      const subtitle = !venue && /(?:^|\s)\p{Ll}{4,}/u.test(segment);
      if (subtitle) continue;
    }
    return tidyTitle(rest.slice(0, j + 1));
  }
  return tidyTitle(rest);
}

function tidyTitle(t: string): string {
  let s = t.trim().replace(/[.”’"']+$/u, "").trim();
  if ((s.match(/“/g) ?? []).length > (s.match(/”/g) ?? []).length) s += "”";
  return s;
}

const yearOf = (token: string) => /^\d{4}/.test(token) ? token.slice(0, 4) : "";
const keyYear = (token: string) => token.toLowerCase().replace(/[^a-z0-9]/g, "");
const doiOf = (raw: string) => normDoi(trimDoiTail(raw.match(DOI_RE)?.[0] ?? ""));
const lastName = (name: string) => {
  const parts = name.replace(/[.,\s]+$/, "").trim().split(/\s+/);
  return parts[parts.length - 1] ?? "";
};

function authorDateEntry(raw: string, st: Start, idx: number, used: Set<string>): RefEntry {
  const authors = st.corp ? [] : familyNames(st.block);
  // An organisation has no surname to key on, so its name is the key.
  const stem = st.corp ? st.block : authors[0];
  const title = titleOf(raw.slice(st.end - st.at), st.commaYear);
  return { key: citationKey(stem, keyYear(st.yearToken), idx, used), title, authors, year: yearOf(st.yearToken), journal: "", doi: doiOf(raw), raw };
}

function mlaEntry(raw: string, st: Start, idx: number, used: Set<string>): RefEntry {
  const authors = familyNames(st.block);
  const after = raw.slice(st.end - st.at);
  const title = titleOf(after, false);
  const tail = after.slice(Math.max(0, after.indexOf(title.slice(-12)) + 12));
  const y = tail.match(new RegExp(R`\((${YEARNUM})\)|,\s(${YEARNUM})(?=[,.])`, "u")) ?? raw.match(/\b((?:1[5-9]|20)\d{2})\b/);
  const year = yearOf(y?.[1] ?? y?.[2] ?? "");
  return { key: citationKey(authors[0], year, idx, used), title, authors, year, journal: "", doi: doiOf(raw), raw };
}

function numberedEntry(raw: string, idx: number, used: Set<string>): RefEntry {
  const body = raw.replace(/^\s*(?:\[\d{1,3}\]|\d{1,3}[.)])\s*/, "");
  const st = startAt(body, 0, "author-date");
  if (st) return { ...authorDateEntry(body, st, idx, used), raw };
  let authors: string[];
  let title: string;
  let rest: string;
  const natural = (list: string) => list.split(/,\s*(?:and\s+)?|\s+and\s+/).map(lastName).filter((n) => /^\p{Lu}/u.test(n));
  const ieee = body.match(/^(.{2,300}?),\s*[“"](.+?)[,.]?[”"]/u);
  const ieeeBook = body.match(/^((?:\p{Lu}\.\s?)+[\p{L}'’\-]+(?:(?:,\s*(?:and\s+)?|\s+and\s+)(?:\p{Lu}\.\s?)+[\p{L}'’\-]+)*),\s+/u);
  if (ieee) {
    authors = natural(ieee[1]!);
    title = ieee[2]!.trim();
    rest = body.slice(ieee[0].length);
  } else if (ieeeBook) {
    authors = natural(ieeeBook[1]!);
    rest = body.slice(ieeeBook[0].length);
    title = sentenceCut(rest);
  } else {
    // Vancouver: "Battilana J, Dorado S. Building sustainable …. Acad Manage J. 2010;53(6)".
    const dot = body.search(/\.\s/);
    const authorPart = dot > 0 ? body.slice(0, dot) : body;
    authors = familyNames(`${authorPart}.`);
    rest = dot > 0 ? body.slice(dot + 1) : "";
    title = sentenceCut(rest.trim());
  }
  const years = [...rest.matchAll(/\b((?:1[5-9]|20)\d{2})\b/g)].map((m) => m[1]!);
  // IEEE ends on the year; Vancouver puts it straight after the journal.
  const year = ieee || ieeeBook ? (years.at(-1) ?? "") : (years[0] ?? "");
  return { key: citationKey(authors[0], year, idx, used), title, authors, year, journal: "", doi: doiOf(raw), raw };
}

// ---------- the reader ----------

/** Where a reference's text ends and the material after the list begins. */
const TAIL_MARKER = /\b(?:Table|Figure|Exhibit)\s+[A-Z]?\d+[.:]|\bNotes?:\s|\(?\S+@\S+\.\p{L}{2,}\)?|\bis\s+(?:an?\s+)?(?:Assistant\s+|Associate\s+|Full\s+|Distinguished\s+|Senior\s+|Emeritus\s+)?Professor\b/u;

function cutTail(text: string, from: number): [string, string] {
  const m = TAIL_MARKER.exec(text.slice(from));
  if (!m) return [text, ""];
  let at = from + m.index;
  if (!/^(?:Table|Figure|Exhibit|Notes?)/.test(m[0])) {
    // A bio: cut at the start of its sentence, not at the email address.
    const before = text.slice(from, at);
    const ends = [...before.matchAll(/[.?!]["”’)]?\s/g)];
    if (ends.length) at = from + ends.at(-1)!.index! + ends.at(-1)![0].length;
  }
  return [text.slice(0, at).trim(), text.slice(at).trim()];
}

/**
 * Read a pasted reference list. Every reference the text appears to hold is
 * either returned as an entry or named in a warning, and everything else that was
 * read (a heading, page furniture, a table, a bio) is listed as skipped.
 */
export function readReferenceList(text: string): ReferenceList {
  const { lines, skipped } = cleanLines(text);
  const stream = joinLines(lines);
  const chain = numberedChain(stream.text, stream.lineStarts);
  const adStarts = findStarts(stream.text, "author-date", stream.lineStarts).length;
  const mlaStarts = findStarts(stream.text, "mla", stream.lineStarts).length;
  const style: RefStyle =
    chain.positions.length >= 3 && chain.positions.length >= 0.5 * Math.max(adStarts, mlaStarts) ? "numbered"
    : mlaStarts > adStarts ? "mla" : "author-date";

  const used = new Set<string>();
  const entries: RefEntry[] = [];
  const warnings: ParseWarning[] = [];
  let expected = 0;
  const pending: string[] = []; // units with no start, kept until we know if an entry follows

  const addEntry = (raw: string, st: Start | null) => {
    const idx = entries.length;
    const e = style === "numbered" ? numberedEntry(raw, idx, used)
      : style === "mla" ? mlaEntry(raw, st!, idx, used)
      : authorDateEntry(raw, st!, idx, used);
    entries.push(e);
    return e;
  };
  // Text set aside between two entries is worth a warning when it carries a year:
  // that is what a reference the splitter could not read looks like.
  const flushPending = (interior: boolean) => {
    // After the list, what follows (tables, bios) is one passage, not one per line.
    if (!interior && pending.length > 1) pending.splice(0, pending.length, pending.join(" "));
    for (const p of pending) {
      skipped.push(p);
      if (style !== "numbered") {
        const n = countMarkers(p);
        expected += interior ? n : 0;
        if (interior && n) {
          warnings.push({ kind: "skipped-year", message: `set aside text that carries a year but no author block: "${p.slice(0, 90)}${p.length > 90 ? "…" : ""}"` });
        }
      }
    }
    pending.length = 0;
  };
  const splitUnit = (unit: string, starts: Array<{ at: number; st: Start | null }>) => {
    if (!starts.length) { if (unit.trim()) pending.push(unit.trim()); return; }
    const head = unit.slice(0, starts[0]!.at).trim();
    if (head) pending.push(head);
    flushPending(entries.length > 0);
    starts.forEach(({ at, st }, k) => {
      const end = k + 1 < starts.length ? starts[k + 1]!.at : unit.length;
      const [raw, tail] = cutTail(unit.slice(at, end).trim(), st ? st.end - st.at : 0);
      addEntry(raw, st ? { ...st, at: 0, end: st.end - st.at } : null);
      if (style !== "numbered") expected += countMarkers(raw);
      if (tail) pending.push(tail);
    });
  };

  if (style === "numbered") {
    const s = stream.text;
    splitUnit(s, chain.positions.map((at) => ({ at, st: null })));
    expected = Math.max(chain.expected, entries.length);
  } else {
    // One reference per line (a Word paste) makes every line break a boundary,
    // which keeps a table after the list out of the last entry. Text wrapped
    // mid-reference (a PDF) is read as one stream instead.
    const lineStart = lines.map((l) => startAt(l, 0, style) !== null);
    const first = lineStart.indexOf(true);
    const last = lineStart.lastIndexOf(true);
    const inRegion = first >= 0 ? last - first + 1 : 0;
    // Text wrapped from a PDF breaks lines mid-sentence; a list with one reference
    // per line ends nearly every line on a full stop, a URL or a page number.
    const region = lines.slice(first, last + 1);
    const begins = lineStart.slice(first, last + 1).filter(Boolean).length;
    const ends = region.filter((l) => /(?:[.?!)\]”"’]|https?:\/\/\S*|\d)$/u.test(l)).length;
    const perLine = first >= 0 &&
      (begins >= 0.9 * inRegion || (begins >= 0.5 * inRegion && ends >= 0.9 * inRegion));
    const units = perLine
      ? lines.map((l) => ({ text: l, lineStarts: new Set([0]) }))
      : [stream];
    for (const u of units) {
      splitUnit(u.text, findStarts(u.text, style, u.lineStarts).map((st) => ({ at: st.at, st })));
    }
  }
  flushPending(false);
  // MLA puts no year after the authors, so its count is the author blocks found
  // anywhere, boundary or not.
  if (style === "mla") expected = Math.max(expected, findStarts(stream.text, "mla", stream.lineStarts, false).length);

  // A reference the splitter missed is merged into its neighbour, and a merged
  // entry carries two year markers or a second author block.
  if (style !== "numbered") {
    for (const e of entries) {
      // Only a person's author block counts here: an organisation's name followed
      // by a year is too common inside a reference to mean a second one.
      const second = findStarts(e.raw, style, new Set(), false).some((s) => s.at > 0 && !s.corp);
      if (countMarkers(e.raw) > 1 || second) {
        warnings.push({ kind: "merged", key: e.key, message: `${e.key} may hold more than one reference: "${e.raw.slice(0, 120)}…"` });
      }
    }
  }
  for (const e of entries) {
    if (!e.year && !/\b(?:in\s+press|forthcoming|n\.\s?d\.)/i.test(e.raw)) {
      warnings.push({ kind: "no-year", key: e.key, message: `${e.key}: no year found` });
    }
    if (e.raw.length > 1000) {
      warnings.push({ kind: "long", key: e.key, message: `${e.key} is unusually long (${e.raw.length} characters) and may hold more than one reference` });
    }
  }
  if (entries.length < expected) {
    warnings.unshift({
      kind: "count",
      message: `read ${entries.length} references, but the text appears to hold ${expected}; the entries flagged below are the likely places`,
    });
  }
  return { entries, style, expected, warnings, skipped };
}

/** The entries alone, for callers that do not report on the reading. */
export function parseTextRefs(text: string): RefEntry[] {
  return readReferenceList(text).entries;
}

/**
 * A readable key for a text-parsed entry: first author family (or organisation)
 * plus year as cited ("tolbert1983", "blab2021a", "murrayforthcoming"), falling
 * back to a positional key when neither is available. Duplicates get a letter
 * suffix so two entries never collide in the results.
 */
function citationKey(author: string | undefined, year: string, idx: number, used: Set<string>): string {
  // Fold accents before stripping: a bare [^a-z] strip DELETED accented letters,
  // so "Tötterman" keyed as "ttterman" and no longer matched the author's own file.
  const stem = author
    ? author.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "")
    : "";
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

/**
 * Family names from an author segment. Two shapes appear in real bibliographies
 * and they put the surname on opposite sides of the initials:
 *
 *   APA / AoM     "Besharov, M. L., & Smith, W. K."   surname, comma, initials
 *   compact       "Besharov ML, Smith WK."            surname, space, initials
 *
 * Reading the compact shape with a comma-anchored rule returned the INITIALS as
 * the surname ("ML", "WK"), which mismatched every registry record and reported a
 * dozen perfectly good references as INCONSISTENT. Periods on the initials are
 * what separate the shapes, so the punctuated form is tried first.
 */
/** Words that appear in an author run but are part of an organisation, not a person. */
const NOT_A_SURNAME = new Set([
  "laboratory", "laboratories", "llc", "ltd", "inc", "incorporated", "university",
  "institute", "college", "corporation", "corp", "company", "association", "council",
  "department", "ministry", "commission", "foundation", "society", "group", "center", "centre",
]);

const FULL_NAME_HEAD = new RegExp(R`^\s*${SURNAME},\s*\p{Lu}\p{Ll}`, "u");

export function familyNames(authorSeg: string): string[] {
  const punctuated = [...authorSeg.matchAll(/([\p{Lu}][\p{L}\p{M}'\u2019-]+),\s*(?:[\p{Lu}]\.\s*)+/gu)]
    .map((m) => m[1]!);
  if (punctuated.length) return dropOrganisations(punctuated);
  // Chicago and MLA spell names out: "Espeland, Wendy Nelson, and Michael Sauder".
  // The first author is inverted and the rest are in natural order, so the
  // surname is the first word of the run and the last word of each name after it.
  if (FULL_NAME_HEAD.test(authorSeg)) {
    const parts = authorSeg.replace(/[.\s]+$/, "").split(/\s*,\s*/);
    const names = [lastName(parts[0]!)];
    parts.slice(1).forEach((part, k) => {
      const p = part.replace(/^(?:and|&)\s+/, "");
      if (/^et\s+al/.test(p)) return;
      p.split(/\s+(?:and|&)\s+/).forEach((bit, b) => { if (k > 0 || b > 0) names.push(lastName(bit)); });
    });
    return dropOrganisations(names.filter((n) => /^\p{Lu}/u.test(n)));
  }
  const compact = [...authorSeg.matchAll(/([\p{Lu}][\p{L}\p{M}'\u2019-]+)\s+[\p{Lu}]{1,3}(?=[,.]|\s|$)/gu)]
    .map((m) => m[1]!);
  if (compact.length) return dropOrganisations(compact);
  return dropOrganisations([...authorSeg.matchAll(/([\p{Lu}][\p{L}\p{M}'\u2019-]+),/gu)].map((m) => m[1]!));
}

const dropOrganisations = (names: string[]): string[] => {
  const people = names.filter((n) => !NOT_A_SURNAME.has(n.toLowerCase()));
  return people.length ? people : names;   // never return nothing
};

/** What kind of source a reference describes, judged from the reference string alone. */
export type RefKind = "journal" | "chapter" | "book" | "thesis" | "report" | "web" | "unknown";

export const REF_KIND_PLURAL: Record<RefKind, string> = {
  journal: "journal articles",
  chapter: "book chapters",
  book: "books",
  thesis: "theses and dissertations",
  report: "reports and working papers",
  web: "web pages and trade press",
  unknown: "unrecognised types",
};

export const REF_KIND_LABEL: Record<RefKind, string> = {
  journal: "journal article",
  chapter: "book chapter",
  book: "book",
  thesis: "thesis or dissertation",
  report: "report or working paper",
  web: "web page or trade press",
  unknown: "unrecognised type",
};

/**
 * Registries index the scholarly literature, not everything scholars cite. A book,
 * a thesis, a consultancy report and a Forbes column are not failures of the check,
 * they are outside what any registry covers, and telling an author that seven of their
 * references "could be fabricated" when four of them are books is alarming and
 * wrong. Classify from the reference string, before any lookup.
 */
export function referenceKind(raw: string): RefKind {
  const s = raw.replace(/\s+/g, " ");
  if (/\b(doctoral|master'?s?|PhD|Ph\.?D\.?|MSc|MA|MBA)?\s*(dissertation|thesis)\b/i.test(s)) return "thesis";
  if (/\bIn:?\s+[A-Z]/.test(s) && /\(\s*Eds?\.?\s*\)/i.test(s)) return "chapter";
  // A volume(issue) or "pp." run is the signature of an article in a serial.
  if (/\b\d{1,4}\s*\(\s*\d{1,4}\s*\)/.test(s) || /\bpp?\.\s*\d+/.test(s)) return "journal";
  if (/\b(working paper|technical report|white ?paper|policy brief|research report)\b/i.test(s)) return "report";
  // Teaching cases: "Harvard Business School Case, 411047", "HBS No. 9-415-080".
  if (/\b(?:Business School|HBS|Ivey)\b[^.]*\b(?:Case|No\.)|\bcase (?:no\.|number|study no\.)/i.test(s)) return "report";
  // "Place: Publisher" with no serial numbering is a monograph, optionally with a
  // US state ("Thousand Oaks, CA: Sage"). It has to END the reference: unanchored,
  // every title with a subtitle ("Values work: A process study ...") read as a
  // book, which sent journal articles to the book index first.
  if (/[.,]\s*[A-Z][A-Za-z.\-' ]{2,30}(?:,\s*[A-Z]{2})?:\s*[A-Z][^.:]{1,60}\.?\s*$/.test(s) || /\(\s*Vol\.?\s*\d+/i.test(s) || /\b\d(?:st|nd|rd|th)\s+ed(?:ition|\.)/i.test(s)) return "book";
  // A reference that ends on a publisher's name, with no volume or pages, is a
  // book: "Henderson, R. 2020. Reimagining Capitalism in a World on Fire. Penguin UK."
  if (/[.,]\s*(?:[\p{Lu}][\p{L}&'’\-]*\s){0,4}(?:Press|UP|Publishing|Publishers|Books|Penguin(?: UK)?|Wiley|Springer|Sage|Routledge|Elgar|Macmillan|Palgrave|McGraw-Hill|Jossey-Bass|Berrett-Koehler|Emerald(?: [\p{L} ]+)?|Free Press|Basic Books)\b[^.]*\.?\s*$/u.test(s) &&
      !/https?:\/\//i.test(s)) return "book";
  if (/https?:\/\//i.test(s) && !/doi\.org|\b10\.\d{4,9}\//.test(s)) return "web";
  if (/\bRetrieved from\b/i.test(s)) return "web";
  return "unknown";
}

/** Registries cover serials well and everything else poorly. */
export const REGISTRY_COVERS: Record<RefKind, boolean> = {
  journal: true, chapter: false, book: false, thesis: false, report: false, web: false, unknown: true,
};
