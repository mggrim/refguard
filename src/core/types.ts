export type Verdict =
  | "CONSISTENT"
  | "BENIGN_DRIFT"
  | "INCONSISTENT"
  | "FABRICATED_CANDIDATE"
  | "RETRACTED"
  | "UNVERIFIED"
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
  source: "openalex" | "local";
  title: string;
  year: string;
  journal: string;
  doi: string;
  authors: string[];
  retracted: boolean;
  id?: string;
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
  /** Search score of the accepted match, 0-1. Null when the match needed no scoring. */
  match_confidence: number | null;
  /** The matched record's own identity, so a wrong match is visible at a glance. */
  truth_authors: string[] | null;
  truth_year: string | null;
  truth_doi: string | null;
  truth_id: string | null;
  local_id: number | string | null;
  local_pdf: string | null;
}

export type MatchBasis = "doi" | "search" | "local";

export const MATCH_BASIS_LABEL: Record<MatchBasis, string> = {
  doi: "matched by DOI",
  search: "matched by title search",
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
