export type Verdict =
  | "CONSISTENT"
  | "BENIGN_DRIFT"
  | "INCONSISTENT"
  | "FABRICATED_CANDIDATE"
  | "RETRACTED"
  | "UNVERIFIED"
  | "AMBIGUOUS_MATCH"
  | "REGISTRY_UNREACHABLE";

export const BLOCKING_VERDICTS: readonly Verdict[] = [
  "INCONSISTENT",
  "FABRICATED_CANDIDATE",
  "RETRACTED",
];

export interface RefEntry {
  key: string;
  title: string;
  /** Family names as claimed by the bibliography. */
  authors: string[];
  year: string;
  journal: string;
  doi: string;
  raw: string;
}

export interface Truth {
  source: "crossref" | "openlibrary" | "local";
  title: string;
  /** The year to report: the print year where the registry knows it. */
  year: string;
  /**
   * Every year the record can rightly be cited under: print, online and issued for
   * an article, each edition for a book. An online-first paper has two correct
   * years, and a citation of either one is a citation of the published state.
   */
  years?: number[];
  /**
   * Crossref only: the year the work appeared in print, when it has. The print
   * year is the published state, so citing the online-first year instead is
   * reported, though never as an error. A record without one (online-only
   * journals, books) accepts any of its years.
   */
  printYear?: number;
  journal: string;
  doi: string;
  authors: string[];
  retracted: boolean;
  id?: string;
  /** Open Library only: how many printings this work has. A multi-edition work has
   * several correct years, which is why an edition gap is not a mismatch. */
  editions?: number;
  /** Crossref only: the publisher's own work type ("journal-article", "book"). */
  type?: string;
  /** Crossref only: volume and issue, so a report can name the version of record. */
  volume?: string;
  issue?: string;
}

export interface AuditResult {
  key: string;
  /** The entry's own claimed title/year, echoed for reporting. */
  title: string;
  year: string;
  verdict: Verdict;
  notes: string[];
  truth_source: string | null;
  truth_title: string | null;
  /**
   * How the registry record was found, and how strongly. A DOI-anchored match is
   * near-certain; a title search on a short generic title is a guess. Reporting
   * them identically left the reader unable to tell "your reference is wrong"
   * from "I probably matched the wrong paper".
   */
  match_basis: MatchBasis | null;
  /** What kind of source the reference describes, and whether a registry covers it. */
  kind: RefKind;
  /** Search score of the accepted match, 0-1. Null when the match needed no scoring. */
  match_confidence: number | null;
  /** The matched record's own identity, so a wrong match is visible at a glance. */
  truth_authors: string[] | null;
  truth_year: string | null;
  truth_doi: string | null;
  truth_id: string | null;
  local_id: number | string | null;
  local_pdf: string | null;
  /** Whether this deserves the author's time, and why. Null when CONSISTENT. */
  attention?: Attention | null;
}

import type { RefKind } from "./parse.ts";
import type { Attention } from "./attention.ts";

export type MatchBasis = "doi" | "search" | "book" | "local";


export const MATCH_BASIS_LABEL: Record<MatchBasis, string> = {
  doi: "matched by DOI",
  search: "matched by reference search",
  book: "matched in Open Library",
  local: "matched in your local library",
};

/**
 * Optional local ground-truth library (e.g. a Zotero database).
 * The web deployment runs without one; the CLI plugs Zotero in.
 */
export interface LocalLibrary {
  lookup(entry: RefEntry): LocalHit | null | Promise<LocalHit | null>;
}

export interface LocalHit {
  id: number | string;
  title: string;
  year: string;
  journal: string;
  doi: string;
  authors: string[];
  pdf: string | null;
}
