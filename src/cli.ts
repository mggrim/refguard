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
 * Exit codes: 0 = all pass · 1 = blocking findings · 2 = cannot certify.
 * Set OPENALEX_MAILTO to join the OpenAlex polite pool.
 */
import { join } from "node:path";
import { homedir } from "node:os";
import {
  auditAll,
  BLOCKING_VERDICTS,
  DOI_RE,
  normDoi,
  parseBib,
  parseTextRefs,
  type AuditResult,
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

function referencesSection(text: string): string {
  const m = text.match(/\n\s*(References|Bibliography|Works Cited|REFERENCES)\s*\n/);
  return m ? text.slice(m.index! + m[0].length) : text;
}

function render(results: AuditResult[], label: string): string {
  const counts: Record<string, number> = {};
  for (const r of results) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
  const lines = [`RefGuard — ${label}`, "=".repeat(60)];
  lines.push(Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(" · "), "");
  const blocking = results.filter((r) => (BLOCKING_VERDICTS as readonly string[]).includes(r.verdict));
  const review = results.filter((r) =>
    ["BENIGN_DRIFT", "UNVERIFIED", "REGISTRY_UNREACHABLE"].includes(r.verdict),
  );
  if (blocking.length) {
    lines.push(`🛑 BLOCKING (${blocking.length}):`);
    for (const r of blocking) lines.push(`  [${r.verdict}] ${r.key}: ${r.notes.join("; ")}`);
    lines.push("");
  }
  if (review.length) {
    lines.push(`⚠️ REVIEW (${review.length}):`);
    for (const r of review) lines.push(`  [${r.verdict}] ${r.key}: ${r.notes.join("; ")}`);
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
      ? { key: "q", title: "", authors: [], year: "", journal: "", doi: normDoi(locate), raw: locate }
      : { key: "q", title: locate, authors: [], year: "", journal: "", doi: "", raw: locate };
    const hit = zotero.lookup(entry);
    console.log(JSON.stringify(hit ?? { found: false }, null, 2));
    return hit ? 0 : 1;
  }

  let entries: RefEntry[] = [];
  let label = "";
  const bibPath = arg("bib");
  const textPath = arg("text");
  const docxPath = arg("docx");
  if (bibPath) {
    entries = parseBib(await Bun.file(bibPath).text());
    label = bibPath;
  } else if (textPath) {
    entries = parseTextRefs(await Bun.file(textPath).text());
    label = textPath;
  } else if (docxPath) {
    entries = parseTextRefs(referencesSection(await extractDocxText(docxPath)));
    label = docxPath;
  } else {
    console.error(
      "usage: refguard --bib <file> | --text <file> | --docx <file> | --locate <title-or-doi> [--zotero <sqlite>] [--out <json>]",
    );
    return 2;
  }
  if (!entries.length) {
    console.error("no reference entries parsed from input");
    return 2;
  }
  if (!zotero) console.error("note: no Zotero library found; auditing against registry only");

  const results = await auditAll(entries, {
    local: zotero,
    mailto: process.env.OPENALEX_MAILTO,
    delayMs: 120,
  });

  const outPath = arg("out");
  if (outPath) {
    await Bun.write(outPath, JSON.stringify({ label, generated: new Date().toISOString(), results }, null, 2));
  }
  console.log(render(results, label));

  if (results.some((r) => (BLOCKING_VERDICTS as readonly string[]).includes(r.verdict))) return 1;
  if (results.some((r) => r.verdict === "REGISTRY_UNREACHABLE")) return 2;
  return 0;
}

main().then((code) => process.exit(code));
