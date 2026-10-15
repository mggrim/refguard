import type { AuditResult, LocalHit, LocalLibrary, MatchBasis, RefEntry, Truth, Verdict } from "./types.ts";
import type { RefKind } from "./parse.ts";
import type { SearchMatch } from "./registry.ts";
import { REF_KIND_LABEL, REGISTRY_COVERS, referenceKind } from "./parse.ts";
import { openLibrarySearch } from "./openlibrary.ts";
import { crossrefByDoi, crossrefSearch } from "./crossref.ts";
import { authorOverlap, GENERIC_TITLE_TOKENS, journalMatch, knownYears, titleDistinctiveness, titleSim } from "./match.ts";
import { attentionFor } from "./attention.ts";
import { doiHandleExists, newBreaker, RegistryUnreachable, type RegistryOptions } from "./registry.ts";

/**
 * Below this title similarity two records are different works. Inside `compare`
 * that is a title mismatch on a record the reference claims to be; on a search
 * result it means the search found something else, which says nothing about the
 * reference.
 */
const SAME_WORK_TITLE_SIM = 0.55;

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
    // One call. Crossref's search response carries the Retraction Watch record, so
    // the retraction check costs nothing extra.
    const m = await crossrefSearch(entry, opts, kind);
    return m ? { match: m, basis: "search" as MatchBasis } : null;
  };
  const book = async () => {
    const m = await openLibrarySearch(entry, opts);
    return m ? { match: m, basis: "book" as MatchBasis } : null;
  };
  const noop = async () => null;
  const [first, second] = booky ? [book, article] : [article, bookWorthTrying ? book : noop];
  let outage: RegistryUnreachable | null = null;
  // A hit whose title is a different work's is kept only as a last resort: the
  // other registry may hold the work itself, and stopping at the first answer
  // would report the wrong work while the right one went unasked.
  let weak: { match: SearchMatch; basis: MatchBasis } | null = null;
  // A record with no author in common counts as weak too: it is usually a review
  // or a namesake, and the other registry may hold the work itself.
  const differentWork = (h: { match: SearchMatch }) =>
    (Boolean(entry.title && h.match.truth.title) && titleSim(entry.title, h.match.truth.title) < SAME_WORK_TITLE_SIM) ||
    authorOverlap(entry.authors, h.match.truth.authors) === 0;
  try {
    const hit = await first();
    if (hit && !differentWork(hit)) return hit;
    weak = hit;
  } catch (e) {
    // The preferred registry being down must not stop the other from answering,
    // but it must not be forgotten either: "not found" and "could not look" are
    // different answers, and only one of them is safe to report as not found.
    if (!(e instanceof RegistryUnreachable)) throw e;
    outage = e;
  }
  try {
    const hit = await second();
    if (hit && !differentWork(hit)) return hit;
    weak = weak ?? hit;
  } catch (e) {
    if (!(e instanceof RegistryUnreachable)) throw e;
    outage = outage ?? e;
  }
  if (outage) throw outage;
  return weak;
}

export function compare(entry: RefEntry, truth: Truth): { verdict: Verdict; notes: string[] } {
  const notes: string[] = [];
  let blocking = false;
  let drift = false;

  if (truth.retracted) {
    return {
      verdict: "RETRACTED",
      // The identifier is printed on its own line in every report, so repeating it
      // here just made the sentence longer.
      notes: ["the Retraction Watch database records this work as retracted"],
    };
  }

  if (entry.title && truth.title) {
    const sim = titleSim(entry.title, truth.title);
    if (sim < SAME_WORK_TITLE_SIM) {
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
  // record with a blank or zero year used to read as "year off by 2021". A record
  // can carry several correct years (print and online for an article, one per
  // edition for a book), and citing any of them is citing the published state, so
  // a gap is measured from the nearest one.
  const ey = /^\d{4}$/.test(entry.year) && Number(entry.year) > 1000 ? Number(entry.year) : null;
  const tys = knownYears(truth);
  if (ey !== null && truth.printYear && ey !== truth.printYear && tys.includes(ey)) {
    // The cited year is a real year of this record, but the online-first one. The
    // print year is the published state, so the difference is reported, however
    // many years apart they are; it is still the right record, so it is drift.
    // Usually the online year comes first. A handbook chapter can go online after
    // the printed volume, and calling that year "online-first" would be wrong.
    const which = ey > truth.printYear ? "online year" : "online-first year";
    notes.push(`cited the ${which} (${ey}); the print year is ${truth.printYear}`);
    drift = true;
  } else if (ey !== null && tys.length) {
    const nearest = tys.reduce((a, b) => (Math.abs(ey - b) < Math.abs(ey - a) ? b : a));
    const dy = Math.abs(ey - nearest);
    // With only one year on the record the gap may still be online-first against
    // print; with both on it, that explanation has already been ruled out.
    const why = tys.length > 1 ? "" : " (possibly online-first vs print)";
    if (dy === 1) {
      notes.push(`year off by 1: ${entry.year} vs ${nearest}${why}`);
      drift = true;
    } else if (dy >= 2) {
      notes.push(`year off by ${dy}: ${entry.year} vs ${nearest}`);
      blocking = true;
    }
  }

  if (!journalMatch(entry.journal, truth.journal)) {
    notes.push(`venue mismatch: "${entry.journal}" vs "${truth.journal}"`);
    blocking = true;
  }

  // Open Library work records routinely carry only the first author, so a partial
  // overlap there is a gap in its data rather than a disagreement. The first
  // claimed author agreeing is all the confirmation that record can offer.
  const firstAuthorConfirmed =
    truth.source === "openlibrary" &&
    entry.authors.length > 0 &&
    authorOverlap(entry.authors.slice(0, 1), truth.authors) === 1;
  const ao = firstAuthorConfirmed ? 1 : authorOverlap(entry.authors, truth.authors);
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

/** Kinds of source neither registry indexes, so they are not searched at all. */
const NOT_SEARCHED = new Set<RefKind>(["web", "report", "thesis"]);

export async function auditEntry(entry: RefEntry, opts: AuditOptions = {}): Promise<AuditResult> {
  const seen: { truth: Truth | null } = { truth: null };
  const result = await auditOne(entry, opts, seen);
  return { ...result, attention: attentionFor(entry, result.kind, result, result.truth_title ? seen.truth : null) };
}

async function auditOne(entry: RefEntry, opts: AuditOptions, seen: { truth: Truth | null }): Promise<AuditResult> {
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
      truth = await crossrefByDoi(entry.doi, opts);
      if (truth) basis = "doi";
      if (!truth) {
        const handle = await doiHandleExists(entry.doi, opts);
        if (handle === false) {
          return {
            ...base,
            verdict: "FABRICATED_CANDIDATE",
            notes: [
              `DOI ${entry.doi} is registered nowhere: 404 at Crossref AND at the doi.org handle registry`,
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
              notes: [`DOI ${entry.doi} resolves at doi.org but Crossref has no record for it, which happens with DataCite and other agencies; verify by hand`],
              truth_source: null,
              truth_title: null,
            };
          }
        }
        if (handle === null && !truth) {
          return {
            ...base,
            verdict: "REGISTRY_UNREACHABLE",
            notes: ["Crossref 404 and doi.org unreachable; cannot distinguish fabrication from outage"],
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
    // Web pages, trade press, reports, cases and theses are indexed by neither
    // registry. Searching for them only ever found something else ("About B Corps"
    // matched a paper on laboratory animal science), so they are not searched.
    if (!truth && !NOT_SEARCHED.has(base.kind)) {
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
        // A gap of two years or more is a question about which record was cited, so
        // it is never drift: drift is reserved for differences that change nothing.
        verdict: contradicted ? "INCONSISTENT" : yearOnly ? "AMBIGUOUS_MATCH" : "REGISTRY_UNREACHABLE",
        notes: [
          ...c.notes,
          contradicted
            ? "registry unreachable; this mismatch is against your local library metadata"
            : yearOnly
              ? `matched in your local library by title, not DOI; your library holds the ${local.year} record, so check which edition or printing you cited`
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
            ? "no match at Crossref or Open Library, and not in your local library; verify by hand"
            : `this looks like a ${REF_KIND_LABEL[base.kind]}, which no registry indexes; not a sign of a bad reference, but check it by hand`,
        ],
        truth_source: null,
        truth_title: null,
      };
    }
    // A search hit whose title is a different work's is no match at all. Comparing
    // its fields reported a correct HBR citation as an error because the search
    // had found the PLOS ONE paper the same authors wrote. With no record of the
    // cited work, the honest verdict is the one for a reference nothing confirmed.
    // UNVERIFIED rather than AMBIGUOUS_MATCH, because AMBIGUOUS_MATCH says a record
    // of the same name was found and may be the wrong one; here nothing of the
    // same name was found. The record is named in the note, not reported as the
    // match, so the report does not print "matched by" above a non-match.
    if ((basis === "search" || basis === "book") && entry.title && truth.title) {
      const sim = titleSim(entry.title, truth.title);
      if (sim < SAME_WORK_TITLE_SIM) {
        const who = [truth.authors.slice(0, 2).join(", "), truth.year].filter(Boolean).join(", ");
        return {
          ...base,
          verdict: "UNVERIFIED",
          notes: [
            `the registry search returned only a different work ("${truth.title.slice(0, 70)}"${who ? `, ${who}` : ""}; title similarity ${sim.toFixed(2)}); this is not evidence of an error in your reference, but nothing confirmed it, so check it by hand`,
          ],
        };
      }
    }
    // No author in common and no DOI: the right work would share at least one
    // author, so this is a record of something else (a review of the book, a
    // namesake) and showing it as a candidate was noise. The one exception is
    // field mixing: a distinctive journal-article title that matches exactly, whose
    // authors are someone else's, is the error this tool exists to catch.
    if ((basis === "search" || basis === "book") && authorOverlap(entry.authors, truth.authors) === 0) {
      const sim = entry.title && truth.title ? titleSim(entry.title, truth.title) : 0;
      const mixing = sim >= 0.9 && titleDistinctiveness(entry.title) >= GENERIC_TITLE_TOKENS && base.kind === "journal";
      if (!mixing) {
        return {
          ...base,
          verdict: "UNVERIFIED",
          notes: ["no record with a matching author was found at Crossref or Open Library; not evidence of a problem, but check it by hand"],
        };
      }
    }
    seen.truth = truth;
    const c = compare(entry, truth);
    // A search-based match (no DOI anchor) whose only disagreement is a year gap of
    // two or more cannot be an online-first offset: the print and online years are
    // both on the record already. It is a different edition, a reprint, or a
    // different record of a similar name, and which one is a question only the
    // author can answer. Calling it drift hid six wrong matches on one manuscript,
    // and blocking would claim an error the evidence does not show, so it goes to
    // review as a question about the record. A DOI-anchored gap still blocks.
    // Open Library work records often list only the first author, so a partial
    // author overlap there is a gap in its data, not a second disagreement.
    const viaDoi = Boolean(entry.doi) && truth.doi === entry.doi;
    const recordQuestion = (n: string) =>
      n.startsWith("year off by") || n.startsWith("title drift") ||
      (truth.source === "openlibrary" && n.startsWith("partial author overlap"));
    if (c.verdict === "INCONSISTENT" && !viaDoi && c.notes.length > 0 && c.notes.every(recordQuestion)) {
      const years = knownYears(truth).sort((a, b) => a - b);
      const held = years.length > 1 ? `carries the years ${years.join(", ")}` : `is from ${truth.year}`;
      return {
        ...withTruth(truth, basis ?? "search", score),
        verdict: "AMBIGUOUS_MATCH",
        notes: [
          // Open Library's first_publish_year is the earliest printing IT holds,
          // which is not always the true first edition, so do not assert which
          // printing the author cited, only which ones the record carries.
          truth.source === "openlibrary" && (truth.editions ?? 1) > 1
            ? `Open Library records ${truth.editions} editions of this work, none from ${entry.year}; check which edition you cited`
            : `matched by title/author search, not DOI; the record found ${held}, so check which record or edition you cited`,
          ...c.notes,
        ],
      };
    }
    // "Your reference is wrong" and "the wrong paper was matched" both show as a
    // field mismatch, and they call for opposite responses from the author. What
    // separates them is whether the title could identify the work on its own: a
    // distinctive title that matched IS the right paper, so a disagreement is a
    // real error, while a generic title with no author in common and no DOI anchor
    // is far more likely to be a different work with the same name.
    // A record sharing an author but disagreeing elsewhere, on a title too general
    // to identify one work, may be another work by the same author.
    if (c.verdict === "INCONSISTENT" && (basis === "search" || basis === "book") &&
        authorOverlap(entry.authors, truth.authors) > 0 && titleDistinctiveness(entry.title) < GENERIC_TITLE_TOKENS) {
      return {
        ...withTruth(truth, basis ?? "search", score),
        verdict: "AMBIGUOUS_MATCH",
        notes: [
          `"${entry.title}" is too general to identify a work on its own; a record by the same author has this title but other fields differ, so it may be a different work`,
          ...c.notes,
        ],
      };
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
