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
  verdict: Verdict;
  notes: string[];
  truth_source: string | null;
  truth_title: string | null;
  local_id: number | string | null;
  local_pdf: string | null;
}

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
