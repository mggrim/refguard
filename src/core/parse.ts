import type { RefEntry } from "./types.ts";
import { normDoi } from "./match.ts";

export const DOI_RE = /\b10\.\d{4,9}\/[^\s"'<>,;()]+/;
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

/** Heuristic parser for a pasted reference list (APA-shaped; one entry per line or paragraph). */
export function parseTextRefs(text: string): RefEntry[] {
  const blocks = text
    .split(/\n\s*\n|\r\n\s*\r\n/)
    .flatMap((b) => (b.length > 400 && b.includes("\n") ? b.split("\n") : [b]))
    .map((b) => b.replace(/\s+/g, " ").trim())
    .filter((b) => b.length > 40 && YEAR_RE.test(b));
  return blocks.map((raw, idx) => {
    const doi = normDoi(raw.match(DOI_RE)?.[0] ?? "");
    const yearMatch = raw.match(/\((\d{4})[a-z]?\)/) ?? raw.match(/\b((19|20)\d{2})\b/);
    const year = yearMatch ? (yearMatch[1] ?? yearMatch[0]!) : "";
    const paren = raw.indexOf(`(${year}`);
    const authorSeg = paren > 0 ? raw.slice(0, paren) : "";
    const afterYear = paren > 0 ? raw.slice(raw.indexOf(")", paren) + 1) : raw;
    const title = (afterYear.replace(/^[.\s]+/, "").split(/(?<=[a-z0-9])\.\s/)[0] ?? "").trim();
    const authors = [...authorSeg.matchAll(/([A-Z][A-Za-z'’-]+),/g)].map((m) => m[1]!);
    return { key: `ref${idx + 1}`, title, authors, year, journal: "", doi, raw };
  });
}
