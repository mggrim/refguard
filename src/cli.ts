#!/usr/bin/env bun
/**
 * RefGuard CLI — deterministic reference-integrity audit.
 *
 * Usage:
 *   refguard --bib refs.bib [--zotero <sqlite>] [--zotero-data <dir>] [--out report.json]
 *   refguard --text refs.txt            # pasted bibliography
 *   refguard --docx manuscript.docx     # extracts the References section
 *   refguard --locate "title or DOI"    # find a local (Zotero) PDF for a work
 *
 * Exit codes: 0 = all pass · 1 = blocking findings · 2 = cannot certify (a registry
 * was unreachable, or the reader may have missed a reference).
 * Set REFGUARD_MAILTO (or OPENALEX_MAILTO) to join Crossref's polite pool.
 */
import { join } from "node:path";
import { homedir } from "node:os";
import {
  auditAll,
  BLOCKING_VERDICTS,
  DOI_RE,
  MATCH_BASIS_LABEL,
  referencesSection,
  trimDoiTail,
  normDoi,
  parseBib,
  readReferenceList,
  ATTENTION_LABEL,
  ATTENTION_ORDER,
  type AttentionLevel,
  type AuditResult,
  type ReferenceList,
  type RefEntry,
} from "./core/index.ts";
import { ZoteroLibrary } from "./zotero.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function extractDocxText(path: string): Promise<string> {
  const proc = Bun.spawn(["unzip", "-p", path, "word/document.xml"], { stdout: "pipe" });
  const xml = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`could not read ${path} as .docx`);
  return xml
    .replace(/<w:p[ >]/g, "\n<w:p ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}



/**
 * What the reader made of a pasted list, before any verdict: how many references
 * it read against how many the text appears to hold, what it set aside, and every
 * place it may have merged or missed one. A lost reference is never certified,
 * so this comes first.
 */
export function renderReading(reading: ReferenceList): string[] {
  const lines = [
    `📖 READ: ${reading.entries.length} references (${reading.style} style); the text appears to hold ${reading.expected}.`,
  ];
  if (reading.skipped.length) {
    lines.push(`   Set aside ${reading.skipped.length} ${reading.skipped.length === 1 ? "passage" : "passages"} that ${reading.skipped.length === 1 ? "is" : "are"} not a reference:`);
    for (const s of reading.skipped.slice(0, 5)) lines.push(`     "${s.slice(0, 80)}${s.length > 80 ? "…" : ""}"`);
    if (reading.skipped.length > 5) lines.push(`     and ${reading.skipped.length - 5} more`);
  }
  if (reading.warnings.length) {
    lines.push(`⚠️ PARSE WARNINGS (${reading.warnings.length}): a reference may have been merged into another or missed.`);
    for (const w of reading.warnings) lines.push(`  - ${w.message}`);
  }
  return [...lines, ""];
}

export function render(results: AuditResult[], label: string, reading?: ReferenceList): string {
  const counts: Record<string, number> = {};
  for (const r of results) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
  const lines = [`RefGuard — ${label}`, "=".repeat(60)];
  lines.push(Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(" · "), "");
  if (reading) lines.push(...renderReading(reading));
  const label_ = (r: AuditResult) => (r.title ? `${r.key} "${r.title.slice(0, 55)}"` : r.key);
  /**
   * How the record was found, and what it actually is. A DOI-anchored match and a
   * title guess used to print identically, leaving no way to tell "your reference
   * is wrong" from "the wrong paper was matched".
   */
  const matched = (r: AuditResult): string[] => {
    if (!r.truth_title || !r.match_basis) return [];
    const how = MATCH_BASIS_LABEL[r.match_basis] +
      (r.match_confidence !== null ? ` (confidence ${r.match_confidence.toFixed(2)})` : "");
    const who = [
      // A record with no authors used to print "undefined" here: null?.slice gives
      // undefined, and undefined plus a string is the word.
      r.truth_authors?.length
        ? r.truth_authors.slice(0, 4).join(", ") + (r.truth_authors.length > 4 ? " et al." : "")
        : "",
      r.truth_year,
    ].filter(Boolean).join(", ");
    return [
      `      ${how}`,
      `      record: "${r.truth_title.slice(0, 70)}"${who ? ` — ${who}` : ""}`,
      ...(r.truth_doi || r.truth_id ? [`      ${r.truth_doi ? `doi:${r.truth_doi}` : r.truth_id}`] : []),
    ];
  };
  // Grouped by what the author should do, not by verdict: on one real list, 29 of
  // 132 references had a verdict other than CONSISTENT and about two of them were
  // worth changing. The verdict and its notes stay on each line for the detail.
  const levelOf = (r: AuditResult): AttentionLevel =>
    r.attention?.level ?? ((BLOCKING_VERDICTS as readonly string[]).includes(r.verdict) ? "fix" : "fine");
  const reasonOf = (r: AuditResult) => r.attention?.reason ?? r.notes[0] ?? "";
  const pending = results.filter((r) => r.verdict !== "CONSISTENT");
  const group = (level: AttentionLevel) => pending.filter((r) => levelOf(r) === level);
  const n = (level: AttentionLevel) => group(level).length;
  lines.push(
    `Needs your attention: ${n("fix") + n("look")} (${ATTENTION_LABEL.fix} ${n("fix")} · ${ATTENTION_LABEL.look} ${n("look")})` +
      ` · ${ATTENTION_LABEL.fine} ${n("fine")} · ${ATTENTION_LABEL.cant} ${n("cant")} · Consistent ${counts["CONSISTENT"] ?? 0}`,
    "",
  );
  const heading: Record<AttentionLevel, string> = {
    fix: "🛑 FIX THIS", look: "👀 WORTH A LOOK", fine: "✓ PROBABLY FINE", cant: "📚 CAN'T CHECK HERE",
  };
  for (const level of ATTENTION_ORDER) {
    const rows = group(level);
    if (!rows.length) continue;
    lines.push(`${heading[level]} (${rows.length}):`);
    for (const r of rows) {
      lines.push(`  ${label_(r)}: ${reasonOf(r)}`);
      // The detail behind the reason. A source no registry indexes has none.
      if (level !== "cant") {
        lines.push(`      [${r.verdict}] ${r.notes.join("; ")}`);
        lines.push(...matched(r));
      }
    }
    lines.push("");
  }
  lines.push(`✅ CONSISTENT: ${counts["CONSISTENT"] ?? 0}`);
  return lines.join("\n");
}

async function main(): Promise<number> {
  let zotero: ZoteroLibrary | null = null;
  try {
    zotero = new ZoteroLibrary(arg("zotero"), arg("zotero-data"));
  } catch {
    zotero = null;
  }

  const locate = arg("locate");
  if (locate) {
    if (!zotero) {
      console.error(`Zotero DB not found (looked at ${arg("zotero") ?? join(homedir(), "Zotero", "zotero.sqlite")})`);
      return 2;
    }
    const entry: RefEntry = DOI_RE.test(locate)
      ? { key: "q", title: "", authors: [], year: "", journal: "", doi: normDoi(trimDoiTail(locate)), raw: locate }
      : { key: "q", title: locate, authors: [], year: "", journal: "", doi: "", raw: locate };
    const hit = zotero.lookup(entry);
    console.log(JSON.stringify(hit ?? { found: false }, null, 2));
    return hit ? 0 : 1;
  }

  let entries: RefEntry[] = [];
  let reading: ReferenceList | undefined;
  let label = "";
  const bibPath = arg("bib");
  const textPath = arg("text");
  const docxPath = arg("docx");
  if (bibPath) {
    entries = parseBib(await Bun.file(bibPath).text());
    label = bibPath;
  } else if (textPath) {
    reading = readReferenceList(await Bun.file(textPath).text());
    entries = reading.entries;
    label = textPath;
  } else if (docxPath) {
    const docText = await extractDocxText(docxPath);
    const refsSection = referencesSection(docText);
    if (refsSection === null) {
      console.error(
        "note: no References heading found; scanning the whole document, which can pick up\n" +
        "      sentences that open with a citation. Check the entries below against the draft.",
      );
    }
    reading = readReferenceList(refsSection ?? docText);
    entries = reading.entries;
    label = docxPath;
  } else {
    console.error(
      "usage: refguard --bib <file> | --text <file> | --docx <file> | --locate <title-or-doi> [--zotero <sqlite>] [--out <json>] [--delay <ms>]",
    );
    return 2;
  }
  if (!entries.length) {
    console.error("no reference entries parsed from input");
    if (reading) console.error(renderReading(reading).join("\n"));
    return 2;
  }
  if (!zotero) console.error("note: no Zotero library found; auditing against registry only");

  // Crossref's polite pool allows roughly three requests a second. --delay raises
  // the gap between entries for a very large bibliography.
  const delayMs = Number(arg("delay") ?? 120);
  const results = await auditAll(entries, {
    local: zotero,
    mailto: process.env.REFGUARD_MAILTO ?? process.env.OPENALEX_MAILTO,
    delayMs: Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : 120,
  });

  const outPath = arg("out");
  if (outPath) {
    const parse = reading && {
      style: reading.style, parsed: reading.entries.length, expected: reading.expected,
      warnings: reading.warnings, skipped: reading.skipped,
    };
    await Bun.write(outPath, JSON.stringify({ label, generated: new Date().toISOString(), parse, results }, null, 2));
  }
  console.log(render(results, label, reading));

  if (results.some((r) => (BLOCKING_VERDICTS as readonly string[]).includes(r.verdict))) return 1;
  // A reference the reader may have missed was never checked, so the list cannot
  // be certified even when every entry it did read passes.
  if (results.some((r) => r.verdict === "REGISTRY_UNREACHABLE") || reading?.warnings.length) return 2;
  return 0;
}

// Only when run, not when imported, so the report can be tested.
if (import.meta.main) main().then((code) => process.exit(code));
