import type { AuditResult, LocalHit, LocalLibrary, MatchBasis, RefEntry, Truth, Verdict } from "./types.ts";
import type { RefKind } from "./parse.ts";
import type { SearchMatch } from "./registry.ts";
import { REF_KIND_LABEL, REGISTRY_COVERS, referenceKind } from "./parse.ts";
import { openLibrarySearch } from "./openlibrary.ts";
import { authorOverlap, GENERIC_TITLE_TOKENS, journalMatch, titleDistinctiveness, titleSim } from "./match.ts";
import { doiHandleExists, newBreaker, openalexByDoi, openalexSearchScored, RegistryUnreachable, type RegistryOptions } from "./registry.ts";

/**
 * Which registry to ask, and in what order. The kind is read from the reference
 * string, so it can be wrong; neither registry is therefore exclusive. A book goes
 * to Open Library first and still falls back to the article index, and vice versa,
 * so a misread reference costs one extra call rather than a missed match.
 */
async function searchRegistries(
  entry: RefEntry,
  kind: RefKind,
  opts: RegistryOptions,
): Promise<{ match: SearchMatch; basis: MatchBasis } | null> {
  const booky = kind === "book" || kind === "chapter";
  // A reference the string clearly shows to be a journal article has no business in
  // a book index, so don't spend a call on it. Anything else gets both.
  const bookWorthTrying = booky || kind === "unknown";
  const article = async () => {
    const m = await openalexSearchScored(entry, opts);
    return m ? { match: m, basis: "search" as MatchBasis } : null;
  };
  const book = async () => {
    const m = await openLibrarySearch(entry, opts);
    return m ? { match: m, basis: "book" as MatchBasis } : null;
  };
  const noop = async () => null;
  const [first, second] = booky ? [book, article] : [article, bookWorthTrying ? book : noop];
  try {
    const hit = await first();
    if (hit) return hit;
  } catch (e) {
    // The preferred registry being down must not stop the other from answering.
    if (!(e instanceof RegistryUnreachable)) throw e;
    return await second();
  }
  return await second();
}

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
    kind: referenceKind(entry.raw || entry.title),
    truth_source: null as string | null,
    truth_title: null as string | null,
    match_basis: null as MatchBasis | null,
    match_confidence: null as number | null,
    truth_authors: null as string[] | null,
    truth_year: null as string | null,
    truth_doi: null as string | null,
    truth_id: null as string | null,
    local_id: local?.id ?? null,
    local_pdf: local?.pdf ?? null,
  };
  /** Fill the matched record's identity so a wrong match is visible in the report. */
  const withTruth = (t: Truth, basis: MatchBasis, confidence: number | null) => ({
    ...base,
    match_basis: basis,
    match_confidence: confidence,
    truth_authors: t.authors.length ? t.authors : null,
    truth_year: t.year || null,
    truth_doi: t.doi || null,
    truth_id: t.id ?? null,
    truth_source: t.source,
    truth_title: t.title,
  });
  try {
    let truth: Truth | null = null;
    let basis: MatchBasis | null = null;
    let score: number | null = null;
    if (entry.doi) {
      truth = await openalexByDoi(entry.doi, opts);
      if (truth) basis = "doi";
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
          const m = await searchRegistries(entry, base.kind, opts);
          if (m) { truth = m.match.truth; basis = m.basis; score = m.match.score; }
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
        const m = await searchRegistries(entry, base.kind, opts);
        if (m) { truth = m.match.truth; basis = m.basis; score = m.match.score; }
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
        ...withTruth({ source: "local", title: local.title, year: local.year, journal: local.journal,
                       doi: local.doi, authors: local.authors, retracted: false }, "local", null),
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
        ...withTruth({ source: "local", title: local.title, year: local.year, journal: local.journal,
                       doi: local.doi, authors: local.authors, retracted: false }, "local", null),
        verdict: c.verdict,
        notes: [
          ...c.notes,
          "registry had no match; verified against local library metadata only (no retraction check)",
        ],
      };
    }
    if (!truth) {
      return {
        ...base,
        verdict: "UNVERIFIED",
        notes: [
          REGISTRY_COVERS[base.kind]
            ? "no registry match by DOI, title or author, and not in the local library; verify by hand"
            : `this looks like a ${REF_KIND_LABEL[base.kind]}, which the registry does not index; not a sign of a bad reference, but check it by hand`,
        ],
        truth_source: null,
        truth_title: null,
      };
    }
    const c = compare(entry, truth);
    // A book with several printings has several correct years. Open Library reports
    // the first printing plus an edition count, so a year gap on a multi-edition work
    // is an edition, not an error — this is the complaint that started the project.
    if (truth.source === "openlibrary" && (truth.editions ?? 1) > 1 && c.verdict === "INCONSISTENT") {
      // Open Library often lists only the first author on a work record, so a
      // partial author overlap is a gap in its data, not a disagreement.
      const editionOnly =
        c.notes.length > 0 &&
        c.notes.every((n) => n.startsWith("year off by") || n.startsWith("partial author overlap"));
      if (editionOnly) {
        return {
          ...withTruth(truth, "book", score),
          verdict: "BENIGN_DRIFT",
          notes: [
            // Open Library's first_publish_year is the earliest printing IT holds,
            // which is not always the true first edition, so do not assert which
            // printing the author cited — only that several exist.
            `Open Library records ${truth.editions} editions of this work; edition years differ, so confirm which printing you cited`,
            ...c.notes,
          ],
        };
      }
    }
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
        ...withTruth(truth, basis ?? "search", score),
        verdict: "BENIGN_DRIFT",
        notes: [
          ...c.notes,
          "matched by title/author search, not DOI — year gap likely a different edition or online-first record; confirm the year by hand",
        ],
      };
    }
    // "Your reference is wrong" and "the wrong paper was matched" both show as a
    // field mismatch, and they call for opposite responses from the author. What
    // separates them is whether the title could identify the work on its own: a
    // distinctive title that matched IS the right paper, so a disagreement is a
    // real error, while a generic title with no author in common and no DOI anchor
    // is far more likely to be a different work with the same name.
    if (c.verdict === "INCONSISTENT" && basis === "search") {
      const overlap = authorOverlap(entry.authors, truth.authors);
      const generic = titleDistinctiveness(entry.title) < GENERIC_TITLE_TOKENS;
      if (overlap === 0 && generic) {
        return {
          ...withTruth(truth, "search", score),
          verdict: "AMBIGUOUS_MATCH",
          notes: [
            `"${entry.title}" is too general to identify a work on its own, and no author matches, so this is probably a different work with the same title rather than an error in your reference`,
            ...c.notes,
          ],
        };
      }
    }
    return { ...withTruth(truth, basis ?? "search", score), verdict: c.verdict, notes: c.notes };
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
