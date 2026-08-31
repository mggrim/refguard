import type { AuditResult, LocalHit, LocalLibrary, RefEntry, Truth, Verdict } from "./types.ts";
import { authorOverlap, journalMatch, titleSim } from "./match.ts";
import { doiHandleExists, openalexByDoi, openalexSearch, RegistryUnreachable, type RegistryOptions } from "./registry.ts";

export function compare(entry: RefEntry, truth: Truth): { verdict: Verdict; notes: string[] } {
  const notes: string[] = [];
  let blocking = false;
  let drift = false;

  if (truth.retracted) {
    return {
      verdict: "RETRACTED",
      notes: [`registry marks this work retracted (${truth.id ?? truth.source})`],
    };
  }

  if (entry.title && truth.title) {
    const sim = titleSim(entry.title, truth.title);
    if (sim < 0.55) {
      notes.push(
        `title mismatch: "${entry.title.slice(0, 60)}" vs "${truth.title.slice(0, 60)}" (sim ${sim.toFixed(2)})`,
      );
      blocking = true;
    } else if (sim < 0.9) {
      notes.push(`title drift (formatting/subtitle, sim ${sim.toFixed(2)})`);
      drift = true;
    }
  }

  if (entry.year && truth.year) {
    const dy = Math.abs(Number(entry.year) - Number(truth.year));
    if (dy === 1) {
      notes.push(`year off by 1: ${entry.year} vs ${truth.year} (likely online-first vs print)`);
      drift = true;
    } else if (dy >= 2) {
      notes.push(`year off by ${dy}: ${entry.year} vs ${truth.year}`);
      blocking = true;
    }
  }

  if (!journalMatch(entry.journal, truth.journal)) {
    notes.push(`venue mismatch: "${entry.journal}" vs "${truth.journal}"`);
    blocking = true;
  }

  const ao = authorOverlap(entry.authors, truth.authors);
  if (ao >= 0 && ao < 0.5) {
    notes.push(
      `author mismatch: claimed [${entry.authors.join(", ")}] vs registry [${truth.authors.slice(0, 6).join(", ")}]`,
    );
    blocking = true;
  } else if (ao >= 0.5 && ao < 1) {
    notes.push(`partial author overlap (${Math.round(ao * 100)}%)`);
    drift = true;
  }

  if (entry.doi && truth.doi && entry.doi !== truth.doi) {
    notes.push(`DOI mismatch: ${entry.doi} vs ${truth.doi}`);
    blocking = true;
  }

  return { verdict: blocking ? "INCONSISTENT" : drift ? "BENIGN_DRIFT" : "CONSISTENT", notes };
}

export interface AuditOptions extends RegistryOptions {
  local?: LocalLibrary | null;
}

export async function auditEntry(entry: RefEntry, opts: AuditOptions = {}): Promise<AuditResult> {
  let local: LocalHit | null = null;
  try {
    local = (await opts.local?.lookup(entry)) ?? null;
  } catch {
    local = null; // a broken local library must not sink the audit
  }
  const base = {
    key: entry.key,
    local_id: local?.id ?? null,
    local_pdf: local?.pdf ?? null,
  };
  try {
    let truth: Truth | null = null;
    if (entry.doi) {
      truth = await openalexByDoi(entry.doi, opts);
      if (!truth) {
        const handle = await doiHandleExists(entry.doi, opts);
        if (handle === false) {
          return {
            ...base,
            verdict: "FABRICATED_CANDIDATE",
            notes: [
              `DOI ${entry.doi} is registered nowhere: 404 at OpenAlex AND at the doi.org handle registry`,
            ],
            truth_source: null,
            truth_title: null,
          };
        }
        if (handle === true) {
          truth = await openalexSearch(entry, opts);
          if (!truth) {
            return {
              ...base,
              verdict: "UNVERIFIED",
              notes: [`DOI ${entry.doi} exists at doi.org but OpenAlex has no record; verify by hand`],
              truth_source: null,
              truth_title: null,
            };
          }
        }
        if (handle === null && !truth) {
          return {
            ...base,
            verdict: "REGISTRY_UNREACHABLE",
            notes: ["OpenAlex 404 and doi.org unreachable; cannot distinguish fabrication from outage"],
            truth_source: null,
            truth_title: null,
          };
        }
      }
    }
    if (!truth) truth = await openalexSearch(entry, opts);
    if (!truth && local) {
      const c = compare(entry, {
        source: "local",
        title: local.title,
        year: local.year,
        journal: local.journal,
        doi: local.doi,
        authors: local.authors,
        retracted: false,
      });
      return {
        ...base,
        verdict: c.verdict,
        notes: [
          ...c.notes,
          "registry had no match; verified against local library metadata only (no retraction check)",
        ],
        truth_source: "local",
        truth_title: local.title,
      };
    }
    if (!truth) {
      return {
        ...base,
        verdict: "UNVERIFIED",
        notes: [
          "no registry match by DOI/title/author and not in the local library; verify by hand — could be fabricated or obscure",
        ],
        truth_source: null,
        truth_title: null,
      };
    }
    const c = compare(entry, truth);
    return { ...base, verdict: c.verdict, notes: c.notes, truth_source: truth.source, truth_title: truth.title };
  } catch (e) {
    if (e instanceof RegistryUnreachable) {
      return {
        ...base,
        verdict: "REGISTRY_UNREACHABLE",
        notes: [`registry unreachable (${e.message.slice(0, 80)}); NOT evidence of fabrication`],
        truth_source: null,
        truth_title: null,
      };
    }
    throw e;
  }
}

export async function auditAll(
  entries: RefEntry[],
  opts: AuditOptions & { delayMs?: number } = {},
): Promise<AuditResult[]> {
  const results: AuditResult[] = [];
  for (const entry of entries) {
    results.push(await auditEntry(entry, opts));
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
  }
  return results;
}
