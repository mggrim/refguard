import type { AuditResult, LocalHit, LocalLibrary, RefEntry, Truth, Verdict } from "./types.ts";
import { authorOverlap, journalMatch, titleSim } from "./match.ts";
import { doiHandleExists, newBreaker, openalexByDoi, openalexSearch, RegistryUnreachable, type RegistryOptions } from "./registry.ts";

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

  // A four-digit year on both sides, or there is nothing to compare. A library
  // record with a blank or zero year used to read as "year off by 2021".
  const yearOf = (y: string) => (/^\d{4}$/.test(y) && Number(y) > 1000 ? Number(y) : null);
  const ey = yearOf(entry.year);
  const ty = yearOf(truth.year);
  if (ey !== null && ty !== null) {
    const dy = Math.abs(ey - ty);
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
    title: entry.title,
    year: entry.year,
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
    // A registry outage must not throw away local evidence. Bibliographies in
    // management journals carry almost no DOIs, so every entry rides on search —
    // and when search is down, a Zotero library can still contradict an entry.
    let registryDown = false;
    if (!truth) {
      try {
        truth = await openalexSearch(entry, opts);
      } catch (e) {
        if (!(e instanceof RegistryUnreachable) || !local) throw e;
        registryDown = true;
      }
    }
    if (!truth && local && registryDown) {
      const c = compare(entry, {
        source: "local",
        title: local.title,
        year: local.year,
        journal: local.journal,
        doi: local.doi,
        authors: local.authors,
        retracted: false,
      });
      // A contradiction against your own library is evidence regardless of the
      // registry. Agreement is not: with no registry record there is no
      // retraction check and no second opinion, so it cannot be certified.
      // Same rule as a search-based match: with no DOI anchor we cannot be sure we
      // matched the right record, so a difference of year alone is a question for
      // a human, not a blocking verdict. Books and reprints hit this constantly
      // ("The Discovery of Grounded Theory", 1967 original against a 2009 reprint).
      const yearOnly =
        c.verdict === "INCONSISTENT" &&
        c.notes.length > 0 &&
        c.notes.every((n) => n.startsWith("year off by") || n.startsWith("title drift"));
      const contradicted = c.verdict === "INCONSISTENT" && !yearOnly;
      return {
        ...base,
        verdict: contradicted ? "INCONSISTENT" : yearOnly ? "BENIGN_DRIFT" : "REGISTRY_UNREACHABLE",
        notes: [
          ...c.notes,
          contradicted
            ? "registry unreachable; this mismatch is against your local library metadata"
            : yearOnly
              ? "matched in your local library by title, not DOI — a year gap here is usually a different edition or printing; confirm by hand"
              : "registry unreachable; matches your local library, which is not certification (no registry record, no retraction check)",
        ],
        truth_source: "local",
        truth_title: local.title,
      };
    }
    if (!truth && registryDown) {
      return {
        ...base,
        verdict: "REGISTRY_UNREACHABLE",
        notes: ["registry unreachable and not in the local library; NOT evidence of fabrication"],
        truth_source: null,
        truth_title: null,
      };
    }
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
    // A search-based match (no DOI anchor) that differs ONLY in year is more
    // likely a different edition or an online-first record of the same work
    // than a manuscript error — books and slow journals hit this constantly.
    // Without a DOI we cannot be sure we matched the right record, so blocking
    // would be overconfident: downgrade to review with an explicit note.
    const viaDoi = Boolean(entry.doi) && truth.doi === entry.doi;
    if (
      c.verdict === "INCONSISTENT" &&
      !viaDoi &&
      c.notes.length > 0 &&
      c.notes.every((n) => n.startsWith("year off by") || n.startsWith("title drift"))
    ) {
      return {
        ...base,
        verdict: "BENIGN_DRIFT",
        notes: [
          ...c.notes,
          "matched by title/author search, not DOI — year gap likely a different edition or online-first record; confirm the year by hand",
        ],
        truth_source: truth.source,
        truth_title: truth.title,
      };
    }
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
  // One breaker for the whole run, so a hard throttle stops the retry storm.
  const opts_ = { ...opts, breaker: opts.breaker ?? newBreaker() };
  for (const entry of entries) {
    results.push(await auditEntry(entry, opts_));
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
  }
  return results;
}
