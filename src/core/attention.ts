/**
 * How much a verdict deserves the author's time.
 *
 * A verdict says what the comparison found; it does not say whether the author
 * should do anything about it. On one real AMJ list, 29 of 132 references came
 * back with a verdict other than CONSISTENT and two of them were worth changing.
 * The rest were sources no registry indexes, reprints and later editions of the
 * right work, and handbook chapters whose print and online years differ. So each
 * non-consistent result also gets an attention level and a one-line reason, worked
 * out from the same evidence by fixed rules.
 */
import type { AuditResult, RefEntry, Truth } from "./types.ts";
import type { RefKind } from "./parse.ts";
import { REF_KIND_LABEL, REGISTRY_COVERS } from "./parse.ts";
import { authorOverlap, knownYears, titleSim } from "./match.ts";

export type AttentionLevel = "fix" | "look" | "fine" | "cant";

export interface Attention {
  level: AttentionLevel;
  reason: string;
}

export const ATTENTION_LABEL: Record<AttentionLevel, string> = {
  fix: "Fix this",
  look: "Worth a look",
  fine: "Probably fine",
  cant: "Can't check here",
};

/** The order the report lists them in: what needs the author first. */
export const ATTENTION_ORDER: readonly AttentionLevel[] = ["fix", "look", "fine", "cant"];

/** A reference that gives a volume or page run was cited after publication. */
const HAS_VOLUME = /\b\d{1,4}\s*\(\s*\d{1,4}\s*\)|,\s*\d{1,4}\s*:\s*\d|\bvol\.\s*\d|\bpp?\.\s*\d/i;
const ADVANCE_CITE = /\b(?:in\s+press|forthcoming|working\s+paper|SSRN|online\s+first|early\s+view|advance\s+online)\b/i;

/** "Strategic Management Journal, 43(3)", or as much of it as the record holds. */
function venueOf(t: Truth): string {
  const issue = t.volume ? `${t.volume}${t.issue ? `(${t.issue})` : ""}` : "";
  return [t.journal, issue].filter(Boolean).join(", ");
}

export function attentionFor(entry: RefEntry, kind: RefKind, r: AuditResult, truth: Truth | null): Attention | null {
  switch (r.verdict) {
    case "CONSISTENT":
      return null;
    case "FABRICATED_CANDIDATE":
      return { level: "fix", reason: "The DOI is registered nowhere, so this reference cannot be found as cited." };
    case "RETRACTED":
      return { level: "fix", reason: "The work has been retracted. Cite it only to discuss the retraction." };
    case "INCONSISTENT":
      return {
        level: "fix",
        reason: r.match_basis === "doi"
          ? `The record at this DOI disagrees with the reference: ${r.notes[0] ?? "a field does not match"}.`
          : `The title identifies this work, but other fields belong to something else: ${r.notes.find((n) => !n.startsWith("title")) ?? r.notes[0] ?? "a field does not match"}.`,
      };
    case "REGISTRY_UNREACHABLE":
      return { level: "cant", reason: "A registry could not be reached, so this was not checked. Run it again later." };
    case "UNVERIFIED":
      return {
        level: "cant",
        reason: !REGISTRY_COVERS[kind]
          ? `A ${REF_KIND_LABEL[kind]}. No registry indexes these, so not finding it says nothing about the reference.`
          : "Not found in Crossref or Open Library. That is not evidence of a problem; check it by hand if it matters.",
      };
  }
  if (!truth) return { level: "fine", reason: "A small difference from the record found." };

  // BENIGN_DRIFT and AMBIGUOUS_MATCH: a record was found and differs. Which way it
  // differs, and how strongly the record matches, decides whether it matters.
  const sim = entry.title && truth.title ? titleSim(entry.title, truth.title) : 0;
  const overlap = authorOverlap(entry.authors, truth.authors);
  const strong = sim >= 0.9 && overlap > 0;
  const ey = /^\d{4}$/.test(entry.year) ? Number(entry.year) : null;
  const years = knownYears(truth).sort((a, b) => a - b);
  const print = truth.printYear;
  const article = truth.source === "crossref" && truth.type === "journal-article";
  const venue = venueOf(truth);

  if (r.verdict === "AMBIGUOUS_MATCH" && r.notes[0]?.includes("too general")) {
    return { level: "fine", reason: "The title is too general to be sure the record found is this work." };
  }
  if (ey !== null && print && ey < print && years.includes(ey)) {
    return {
      level: "look",
      reason: `You cited the online-first year (${ey}). The version of record is ${venue ? `${venue}, ` : ""}${print}.`,
    };
  }
  if (strong && article && ey !== null && years.length && ey < years[0]! && (!HAS_VOLUME.test(entry.raw) || ADVANCE_CITE.test(entry.raw))) {
    return {
      level: "look",
      reason: `Cited before it was published. The published version is ${venue ? `${venue}, ` : ""}${truth.year}.`,
    };
  }
  if (ey === null && strong && article && ADVANCE_CITE.test(entry.raw) && truth.year) {
    return {
      level: "look",
      reason: `Cited as forthcoming. The published version is ${venue ? `${venue}, ` : ""}${truth.year}.`,
    };
  }
  const nearest = ey !== null && years.length
    ? years.reduce((a, b) => (Math.abs(ey - b) < Math.abs(ey - a) ? b : a))
    : null;
  if (strong && article && ey !== null && nearest !== null && Math.abs(ey - nearest) === 1 && !years.includes(ey)) {
    return {
      level: "look",
      reason: `The cited year (${ey}) is one off the record's (${nearest}), and its print and online dates do not explain the difference.`,
    };
  }

  // Everything below is a difference of record, not of reference.
  if (ey !== null && print && ey > print && years.includes(ey)) {
    return { level: "fine", reason: `The cited year is when it went online (${ey}); it appeared in print in ${print}. Either year is defensible.` };
  }
  if (ey !== null && years.length && ey < years[0]!) {
    return { level: "fine", reason: `The cited year is earlier than any version the registry holds (${years.join(", ")}), so an earlier edition or printing probably exists.` };
  }
  if (ey !== null && years.length && ey > years.at(-1)!) {
    return { level: "fine", reason: `The registry holds an earlier version (${years.join(", ")}); a later edition or printing was probably cited.` };
  }
  if (nearest !== null && ey !== null && Math.abs(ey - nearest) >= 1) {
    return { level: "fine", reason: `The record found is from ${truth.year}, probably a different edition or printing of the same work.` };
  }
  if (sim > 0 && sim < 0.9) return { level: "fine", reason: "The title differs from the record only in its subtitle or wording." };
  if (overlap >= 0 && overlap < 1) return { level: "fine", reason: "Some authors differ from the record's list. Check the author list if it matters." };
  return { level: "fine", reason: "A small difference from the record found." };
}
