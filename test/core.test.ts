import { describe, expect, test } from "bun:test";
import { parseBib, parseTextRefs } from "../src/core/parse.ts";
import { authorOverlap, journalMatch, titleSim } from "../src/core/match.ts";
import { auditEntry, compare } from "../src/core/audit.ts";
import type { RefEntry, Truth } from "../src/core/types.ts";

// ---------- parsing ----------

describe("parseBib", () => {
  test("survives nested protective braces in titles", () => {
    const bib = `@article{k1,
  title = {Social Movements, {B Corps}, and {AMJ} Conversations},
  author = {Doe, Jane},
  journal = {Some Journal},
  year = {2021},
  doi = {10.1000/xyz}
}`;
    const [e] = parseBib(bib);
    expect(e!.title).toBe("Social Movements, B Corps, and AMJ Conversations");
  });

  test("accepts bare (unbraced) year values", () => {
    const bib = `@article{k1,\n  title = {T},\n  year = 2020,\n  journal = {J}\n}`;
    expect(parseBib(bib)[0]!.year).toBe("2020");
  });

  test("does not merge entries that close on the last field line", () => {
    const bib = `@article{a, title = {One}, year = {2001}}\n@article{b, title = {Two}, year = {2002}}`;
    const es = parseBib(bib);
    expect(es.map((e) => e.key)).toEqual(["a", "b"]);
    expect(es[0]!.title).toBe("One");
    expect(es[1]!.title).toBe("Two");
  });

  test("extracts family names from both comma and natural order", () => {
    const bib = `@article{k, title={T}, author={Tolbert, Pamela S. and Lynne G. Zucker}, year={1983}}`;
    expect(parseBib(bib)[0]!.authors).toEqual(["Tolbert", "Zucker"]);
  });
});

describe("parseTextRefs", () => {
  test("parses an APA-shaped reference", () => {
    const [e] = parseTextRefs(
      "Miller, T. L., Grimes, M. G., McMullen, J. S., & Vogus, T. J. (2012). Venturing for others with heart and head: How compassion encourages social entrepreneurship. Academy of Management Review, 37(4), 616-640. https://doi.org/10.5465/amr.2010.0456",
    );
    expect(e!.year).toBe("2012");
    expect(e!.doi).toBe("10.5465/amr.2010.0456");
    expect(e!.title.toLowerCase()).toContain("venturing for others");
    expect(e!.authors).toContain("Miller");
    expect(e!.authors).toContain("Grimes");
  });
});

// ---------- matching ----------

describe("matching", () => {
  test("near-twin journals never fuzzy-match", () => {
    expect(journalMatch("Academy of Management Review", "Academy of Management Journal")).toBe(false);
    expect(journalMatch("Academy of Management Journal", "The Academy of Management Journal")).toBe(true);
  });

  test("titleSim gives containment credit for dropped subtitles", () => {
    const full = "Rhetorical Strategies of Legitimacy: A Study of Something Long";
    expect(titleSim("Rhetorical Strategies of Legitimacy", full)).toBeGreaterThan(0.9);
  });

  test("authorOverlap detects invented authors", () => {
    expect(authorOverlap(["Smith", "Weber"], ["Zuckerman"])).toBe(0);
    expect(authorOverlap([], ["Zuckerman"])).toBe(-1);
  });
});

// ---------- verdict logic ----------

const truth: Truth = {
  source: "openalex",
  title: "The Categorical Imperative: Securities Analysts and the Illegitimacy Discount",
  year: "1999",
  journal: "American Journal of Sociology",
  doi: "10.1086/210178",
  authors: ["Zuckerman"],
  retracted: false,
};

function entry(overrides: Partial<RefEntry>): RefEntry {
  return {
    key: "t",
    title: truth.title,
    authors: ["Zuckerman"],
    year: "1999",
    journal: "American Journal of Sociology",
    doi: "10.1086/210178",
    raw: "",
    ...overrides,
  };
}

describe("compare", () => {
  test("clean entry is CONSISTENT", () => {
    expect(compare(entry({}), truth).verdict).toBe("CONSISTENT");
  });
  test("invented authors are blocking", () => {
    expect(compare(entry({ authors: ["Smith", "Weber"] }), truth).verdict).toBe("INCONSISTENT");
  });
  test("year off by one is benign drift", () => {
    expect(compare(entry({ year: "1998" }), truth).verdict).toBe("BENIGN_DRIFT");
  });
  test("year off by two is blocking", () => {
    expect(compare(entry({ year: "1997" }), truth).verdict).toBe("INCONSISTENT");
  });
  test("retraction dominates", () => {
    expect(compare(entry({}), { ...truth, retracted: true }).verdict).toBe("RETRACTED");
  });
  test("DOI mismatch is blocking", () => {
    expect(compare(entry({ doi: "10.9999/other" }), truth).verdict).toBe("INCONSISTENT");
  });
});

// ---------- fail-closed registry behavior (stubbed fetch, no network) ----------

function fetchStub(handler: (url: string) => Response | null): typeof fetch {
  return (async (input: any) => {
    const url = String(input);
    const r = handler(url);
    if (r) return r;
    throw new TypeError("network down");
  }) as typeof fetch;
}

describe("auditEntry fail-closed", () => {
  test("network failure yields REGISTRY_UNREACHABLE, never FABRICATED_CANDIDATE", async () => {
    const r = await auditEntry(entry({}), { fetchFn: fetchStub(() => null) });
    expect(r.verdict).toBe("REGISTRY_UNREACHABLE");
  });

  test("fabrication requires 404 at BOTH OpenAlex and doi.org", async () => {
    const r = await auditEntry(entry({ doi: "10.9999/fake" }), {
      fetchFn: fetchStub((url) => {
        if (url.includes("api.openalex.org/works/doi:")) return new Response("", { status: 404 });
        if (url.includes("doi.org/api/handles")) return new Response("", { status: 404 });
        return null;
      }),
    });
    expect(r.verdict).toBe("FABRICATED_CANDIDATE");
  });

  test("OpenAlex 404 with doi.org unreachable cannot certify", async () => {
    const r = await auditEntry(entry({ doi: "10.9999/fake" }), {
      fetchFn: fetchStub((url) => {
        if (url.includes("api.openalex.org/works/doi:")) return new Response("", { status: 404 });
        return null; // doi.org down
      }),
    });
    expect(r.verdict).toBe("REGISTRY_UNREACHABLE");
  });

  test("real DOI unknown to OpenAlex is UNVERIFIED, not fabricated", async () => {
    const r = await auditEntry(entry({ doi: "10.5555/dataset" }), {
      fetchFn: fetchStub((url) => {
        if (url.includes("api.openalex.org/works/doi:")) return new Response("", { status: 404 });
        if (url.includes("doi.org/api/handles"))
          return new Response(JSON.stringify({ responseCode: 1 }), { status: 200 });
        if (url.includes("api.openalex.org/works?search"))
          return new Response(JSON.stringify({ results: [] }), { status: 200 });
        return null;
      }),
    });
    expect(r.verdict).toBe("UNVERIFIED");
  });
});
