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
 * A block only counts as a reference if a parenthesized (year) appears early,
 * before any other parenthesis — real APA entries open with authors then (year),
 * while table rows, appendix text, and quotes that merely contain a year do not.
 * This keeps the parser from auditing a manuscript's tables as citations.
 */
const REF_SHAPE_RE = /^[^()]{0,250}\(\d{4}[a-z]?\)/;

/** Heuristic parser for a pasted reference list (APA-shaped; one entry per line or paragraph). */
export function parseTextRefs(text: string): RefEntry[] {
  const cleaned = text.replace(/ADDIN ZOTERO_BIBL.*?CSL_BIBLIOGRAPHY\s*/gs, "");
  const blocks = cleaned
    .split(/\n\s*\n|\r\n\s*\r\n/)
    .flatMap((b) => (b.length > 400 && b.includes("\n") ? b.split("\n") : [b]))
    .map((b) => b.replace(/\s+/g, " ").trim())
    .filter((b) => b.length > 40 && YEAR_RE.test(b) && REF_SHAPE_RE.test(b));
  const used = new Set<string>();
  return blocks.map((raw, idx) => {
    const doi = normDoi(trimDoiTail(raw.match(DOI_RE)?.[0] ?? ""));
    const yearMatch = raw.match(/\((\d{4})[a-z]?\)/) ?? raw.match(/\b((19|20)\d{2})\b/);
    const year = yearMatch ? (yearMatch[1] ?? yearMatch[0]!) : "";
    const paren = raw.indexOf(`(${year}`);
    const authorSeg = paren > 0 ? raw.slice(0, paren) : "";
    const afterYear = paren > 0 ? raw.slice(raw.indexOf(")", paren) + 1) : raw;
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
