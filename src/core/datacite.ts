/**
 * DataCite — the DOI registry for preprints and data.
 *
 * Crossref registers journal articles and books. arXiv, Zenodo, OSF and most
 * dataset repositories register with DataCite instead, so a real arXiv paper is a
 * 404 at Crossref and used to come back "unverified", or, cited by its arXiv URL,
 * "a web page no registry indexes". DataCite answers both: arXiv's DOIs are
 * 10.48550/arXiv.<id>, and the record carries the title, authors and year.
 */
import type { Truth } from "./types.ts";
import { registryGet, type RegistryOptions } from "./registry.ts";

const ENDPOINT = "https://api.datacite.org/dois";

/** arXiv's DOI prefix. Every arXiv paper since 2022, and the back catalogue, has one. */
export const ARXIV_DOI_PREFIX = "10.48550/arxiv.";

/**
 * The arXiv identifier a reference cites, if any: "arXiv:2607.05775",
 * "arxiv.org/abs/2607.05775v2", "arxiv.org/pdf/2607.05775", the arXiv DOI, or an
 * old-style id ("arXiv:cs/0112017"). The version suffix is dropped, because the DOI
 * names the paper and its versions share it.
 */
export function arxivId(raw: string): string | null {
  const s = raw.replace(/\s+/g, " ");
  const newStyle = s.match(/(?:arxiv(?:\.org\/(?:abs|pdf)\/|:\s*|\.)|10\.48550\/arxiv\.)(\d{4}\.\d{4,5})(?:v\d+)?/i);
  if (newStyle) return newStyle[1];
  const oldStyle = s.match(/(?:arxiv(?:\.org\/(?:abs|pdf)\/|:\s*))([a-z][a-z.\-]*\/\d{7})(?:v\d+)?/i);
  return oldStyle ? oldStyle[1].toLowerCase() : null;
}

export const arxivDoi = (id: string): string => `${ARXIV_DOI_PREFIX}${id}`;

interface DataciteAttributes {
  doi?: string;
  titles?: Array<{ title?: string; titleType?: string }>;
  creators?: Array<{ familyName?: string; name?: string; nameType?: string }>;
  publicationYear?: number | string;
  publisher?: string | { name?: string };
  types?: { resourceTypeGeneral?: string };
  url?: string;
}

const familyOf = (c: { familyName?: string; name?: string; nameType?: string }): string => {
  if (c.familyName) return c.familyName;
  const name = (c.name ?? "").trim();
  // "Zhao, Wei" or an organisation's name; keep the part before the comma.
  if (name.includes(",")) return name.split(",")[0].trim();
  if (c.nameType === "Organizational") return name;
  const parts = name.split(/\s+/);
  return parts[parts.length - 1] ?? "";
};

function toTruth(a: DataciteAttributes): Truth {
  const title = (a.titles ?? []).find((t) => !t.titleType)?.title ?? a.titles?.[0]?.title ?? "";
  const year = Number(a.publicationYear);
  const publisher = typeof a.publisher === "string" ? a.publisher : a.publisher?.name ?? "";
  return {
    source: "datacite",
    title,
    year: year > 1000 ? String(year) : "",
    years: year > 1000 ? [year] : [],
    // The repository is the venue: "arXiv", "Zenodo", "OSF Preprints".
    journal: publisher,
    doi: (a.doi ?? "").toLowerCase(),
    authors: (a.creators ?? []).map(familyOf).filter(Boolean),
    retracted: false, // DataCite carries no retraction feed; withdrawn preprints say so on arXiv itself
    id: a.url,
    type: a.types?.resourceTypeGeneral?.toLowerCase(),
  };
}

/** Direct DOI lookup at DataCite. Returns null for a DOI DataCite does not hold. */
export async function dataciteByDoi(doi: string, opts: RegistryOptions = {}): Promise<Truth | null> {
  const data = (await registryGet(`${ENDPOINT}/${encodeURIComponent(doi)}`, opts)) as
    | { data?: { attributes?: DataciteAttributes } }
    | null;
  const a = data?.data?.attributes;
  return a ? toTruth(a) : null;
}
