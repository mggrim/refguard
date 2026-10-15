import { describe, expect, test } from "bun:test";
import { familyNames, parseBib, parseTextRefs, referenceKind, referencesSection, REGISTRY_COVERS, trimDoiTail } from "../src/core/parse.ts";
import { authorOverlap, journalMatch, titleSim } from "../src/core/match.ts";
import { auditAll, auditEntry, compare } from "../src/core/audit.ts";
import { RegistryUnreachable } from "../src/core/registry.ts";
import { crossrefByDoi } from "../src/core/crossref.ts";
import { bookQuery } from "../src/core/openlibrary.ts";
import { BLOCKING_VERDICTS } from "../src/core/types.ts";
import type { LocalHit, RefEntry, Truth } from "../src/core/types.ts";

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
  source: "crossref",
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

// ---------- real-manuscript lessons (2026-09-02 SMJ draft audit) ----------

import { sanitizeSearchQuery } from "../src/core/registry.ts";

describe("manuscript-audit regressions", () => {
  test("search queries are sanitized: a bare '?' breaks registry search", () => {
    expect(sanitizeSearchQuery("Expecting the Unexpected? How SWAT Officers Handle Surprises")).not.toContain("?");
  });

  test("table rows and appendix quotes are not parsed as references", () => {
    const junk = [
      "Source Description Outcome/purpose Archival data Searchable internal emails (2,219 email threads; 2013-2020) something",
      "A2 finishes his PhD program and leaves the city; board selects a new administrator (A3) who is not aligned 2016",
      "The calendar-partition logic of the charter, applied to a named individual with zero discretion.: 2017 onwards",
    ].join("\n\n");
    expect(parseTextRefs(junk)).toHaveLength(0);
  });

  test("real APA entries still parse alongside junk", () => {
    const mixed =
      "Bechky, B. A., & Okhuysen, G. A. (2011). Expecting the unexpected? How SWAT officers and film crews handle surprises. Academy of Management Journal, 54(2), 239-261.\n\n" +
      "Source Description Outcome/purpose Archival data Searchable internal emails (2,219 email threads; 2013-2020) x";
    const es = parseTextRefs(mixed);
    expect(es).toHaveLength(1);
    expect(es[0]!.authors).toEqual(["Bechky", "Okhuysen"]);
  });

  test("Zotero field-code junk is stripped from the first entry", () => {
    const es = parseTextRefs(
      'ADDIN ZOTERO_BIBL {"uncited":[],"omitted":[],"custom":[]} CSL_BIBLIOGRAPHY Alvesson, M., & Skoldberg, K. (2017). Reflexive methodology: New vistas for qualitative research. Sage.',
    );
    expect(es[0]!.authors[0]).toBe("Alvesson");
  });

  test("search-based match with year-only gap downgrades to review (edition/online-first)", async () => {
    const work = {
      DOI: undefined, title: ["Case Study Research: Design and Methods"],
      author: [{ family: "Yin" }], issued: { "date-parts": [[1984]] },
      "container-title": [""], type: "journal-article",
    };
    const r = await auditEntry(
      { key: "yin", title: "Case study research: Design and methods", authors: ["Yin"], year: "1994", journal: "", doi: "", raw: "" },
      {
        fetchFn: (async (input: any) => {
          const url = String(input);
          if (url.includes("api.crossref.org/works?")) return new Response(JSON.stringify({ message: { items: [work] } }), { status: 200 });
          if (url.includes("openlibrary.org")) return new Response(JSON.stringify({ docs: [] }), { status: 200 });
          throw new TypeError("unexpected fetch " + url);
        }) as typeof fetch,
      },
    );
    // Ten years is not drift. It is a question about which record or edition was
    // cited, and calling it benign hid wrong matches on a real manuscript.
    expect(r.verdict).toBe("AMBIGUOUS_MATCH");
    expect(BLOCKING_VERDICTS).not.toContain(r.verdict);
    expect(r.notes.join(" ")).toContain("edition");
  });

  test("DOI-anchored year gap of 2+ still blocks", async () => {
    const r = await auditEntry(entry({ year: "1997" }), {
      fetchFn: (async (input: any) => {
        const url = String(input);
        if (url.includes("api.crossref.org/works/"))
          return new Response(
            JSON.stringify({
              message: {
                DOI: truth.doi, title: [truth.title], author: [{ family: "Zuckerman" }],
                issued: { "date-parts": [[1999]] }, "container-title": [truth.journal],
                type: "journal-article",
              },
            }),
            { status: 200 },
          );
        throw new TypeError("unexpected " + url);
      }) as typeof fetch,
    });
    expect(r.verdict).toBe("INCONSISTENT");
  });
});

// ---------- fail-closed registry behavior (stubbed fetch, no network) ----------


/** A Crossref work in the shape the API returns, for stubbing. */
function xref(over: Record<string, unknown> = {}) {
  return {
    DOI: "10.1234/abcd",
    title: ["A Real Paper"],
    author: [{ family: "Doe" }],
    issued: { "date-parts": [[2010]] },
    "container-title": ["Some Journal"],
    type: "journal-article",
    ...over,
  };
}
/** Serves one Crossref work for both the DOI and the search route. */
function xrefStub(item: Record<string, unknown> = xref(), extra?: (u: string) => Response | null) {
  return (async (input: any) => {
    const u = String(input);
    const e = extra?.(u);
    if (e) return e;
    if (u.includes("api.crossref.org/works?")) return new Response(JSON.stringify({ message: { items: [item] } }), { status: 200 });
    if (u.includes("api.crossref.org/works/")) return new Response(JSON.stringify({ message: item }), { status: 200 });
    if (u.includes("openlibrary.org")) return new Response(JSON.stringify({ docs: [] }), { status: 200 });
    if (u.includes("doi.org/api/handles")) return new Response(JSON.stringify({ responseCode: 1 }), { status: 200 });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
}

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

  test("fabrication requires 404 at BOTH Crossref and doi.org", async () => {
    const r = await auditEntry(entry({ doi: "10.9999/fake" }), {
      fetchFn: fetchStub((url) => {
        if (url.includes("api.crossref.org/works/10")) return new Response("", { status: 404 });
        if (url.includes("doi.org/api/handles")) return new Response("", { status: 404 });
        return null;
      }),
    });
    expect(r.verdict).toBe("FABRICATED_CANDIDATE");
  });

  test("a Crossref 404 with doi.org unreachable cannot certify", async () => {
    const r = await auditEntry(entry({ doi: "10.9999/fake" }), {
      fetchFn: fetchStub((url) => {
        if (url.includes("api.crossref.org/works/10")) return new Response("", { status: 404 });
        return null; // doi.org down
      }),
    });
    expect(r.verdict).toBe("REGISTRY_UNREACHABLE");
  });

  test("a real DOI unknown to Crossref is UNVERIFIED, not fabricated", async () => {
    const r = await auditEntry(entry({ doi: "10.5555/dataset" }), {
      fetchFn: fetchStub((url) => {
        if (url.includes("api.crossref.org/works/10")) return new Response("", { status: 404 });
        if (url.includes("doi.org/api/handles"))
          return new Response(JSON.stringify({ responseCode: 1 }), { status: 200 });
        if (url.includes("api.crossref.org/works?"))
          return new Response(JSON.stringify({ message: { items: [] } }), { status: 200 });
        if (url.includes("openlibrary.org")) return new Response(JSON.stringify({ docs: [] }), { status: 200 });
        return null;
      }),
    });
    expect(r.verdict).toBe("UNVERIFIED");
  });
});

test("text entries get readable author-year keys, deduped", () => {
  const refs = parseTextRefs([
    "Tolbert, P. S., & Zucker, L. G. (1983). Institutional sources of change in the formal structure of organizations. Administrative Science Quarterly, 28(1), 22-39.",
    "Tolbert, P. S. (1983). A different paper published in the very same year by the same author. Some Other Journal, 1(1), 1-9.",
    "(1994). A block with no author segment at all but plenty of length to pass the filter. Journal, 2(2), 2-9.",
  ].join("\n\n"));
  // A block with a year but no author is not split out as a reference any more:
  // the same rule admitted table rows such as "Issuer impact reports (2016), …".
  // It is reported as skipped text instead (see test/reflists.test.ts).
  expect(refs.map((r) => r.key)).toEqual(["tolbert1983", "tolbert1983a"]);
});

test("a DOI containing parentheses survives text parsing intact", () => {
  const [ref] = parseTextRefs(
    "Wakefield, A. J., & Murch, S. H. (1998). Ileal-lymphoid-nodular hyperplasia and pervasive developmental disorder in children. The Lancet, 351(9103), 637-641. https://doi.org/10.1016/S0140-6736(97)11096-0",
  );
  expect(ref?.doi).toBe("10.1016/s0140-6736(97)11096-0");
});

test("trailing sentence punctuation and unbalanced parens are trimmed from a DOI", () => {
  expect(trimDoiTail("10.5465/amj.2010.1234.")).toBe("10.5465/amj.2010.1234");
  expect(trimDoiTail("10.5465/amj.2010.1234)")).toBe("10.5465/amj.2010.1234");
  expect(trimDoiTail("10.1016/S0140-6736(97)11096-0")).toBe("10.1016/S0140-6736(97)11096-0");
});

describe("Academy of Management reference style (bare year)", () => {
  const aom = [
    "Acs, Z. J., & Audretsch, D. B. 1988. Innovation in large and small firms: An empirical analysis. The American Economic Review, 78(4): 678-690.",
    "Baptista, R., & Swann, P. 1998. Do firms in clusters innovate more? Research Policy, 27(5): 525-540.",
    "Weick, K. E. 1995. Sensemaking in organizations. Thousand Oaks, CA: Sage.",
  ].join("\n\n");

  test("parses entries that carry no parenthesised year", () => {
    const refs = parseTextRefs(aom);
    expect(refs.length).toBe(3);
    expect(refs[0]?.year).toBe("1988");
    expect(refs[0]?.authors).toEqual(["Acs", "Audretsch"]);
    expect(refs[0]?.title).toBe("Innovation in large and small firms: An empirical analysis");
    expect(refs[0]?.key).toBe("acs1988");
    expect(refs[2]?.title).toBe("Sensemaking in organizations");
  });

  test("still refuses prose and table rows that merely contain a year", () => {
    const notRefs = [
      "The firm doubled its headcount in 1998. Managers described the period as chaotic and said little else about it.",
      "Site B | 1998 | 42 employees | interviews conducted across three visits to the plant during the expansion",
      "As one founder put it, we had no idea what 1998 would bring, and the board was in no mood to find out.",
    ].join("\n\n");
    expect(parseTextRefs(notRefs)).toEqual([]);
  });

  test("strips the EndNote field code Word leaves before the first entry", () => {
    const refs = parseTextRefs(" ADDIN EN.REFLIST Acs, Z. J., & Audretsch, D. B. 1988. Innovation in large and small firms: An empirical analysis. The American Economic Review, 78(4): 678-690.");
    expect(refs.length).toBe(1);
    expect(refs[0]?.authors).toEqual(["Acs", "Audretsch"]);
  });
});

describe("author-run shapes found in real drafts", () => {
  const cases: Array<[string, string, string[]]> = [
    ["accented surname", "Barthelemy, J. 2017. The impact of technical consultants on the quality of their clients' products. Strategic Management Journal, 38(5): 1002-1019.", ["Barthelemy"]],
    ["multi-word surname", "Van de Ven, A. H. 1986. Central problems in the management of innovation. Management Science, 32(5): 590-607.", ["Ven"]],
    ["initials without periods", "Battilana J, Dorado S. 2010. Building sustainable hybrid organizations: The case of commercial microfinance organizations. Academy of Management Journal 53(6): 1419-1440.", []],
    ["paired initials", "Besharov ML, Smith WK. 2014. Multiple institutional logics in organizations: Explaining their varied nature and implications. Academy of Management Review 39(3): 364-381.", []],
  ];
  for (const [name, raw, authors] of cases) {
    test(name, () => {
      const refs = parseTextRefs(raw);
      expect(refs.length).toBe(1);
      expect(refs[0]?.year.length).toBe(4);
      if (authors.length) expect(refs[0]?.authors).toEqual(authors);
    });
  }
});

describe("more author-run shapes from real drafts", () => {
  const cases: Array<[string, string]> = [
    ["lowercase particle", "van Werven, R., Bouwmeester, O., & Cornelissen, J. P. 2015. The power of arguments: How entrepreneurs convince stakeholders. International Small Business Journal, 33(1): 616-628."],
    ["et al.", "Gehman, J., Glaser, V. L., Eisenhardt, K. M., Gioia, D., Langley, A., et al. 2018. Finding theory-method fit: A comparison of three qualitative approaches. Journal of Management Inquiry, 27(3): 284-300."],
    ["edited volume", "Lockwood, C., & Soubliere, J.-F. (Eds.). 2022. Advances in cultural entrepreneurship. Bingley: Emerald Group Publishing."],
    ["dated magazine piece", "Blank, S. 2013, May 1. Why the lean start-up changes everything. Harvard Business Review, 91(5): 63-72."],
  ];
  for (const [name, raw] of cases) {
    test(name, () => {
      const refs = parseTextRefs(raw);
      expect(refs.length).toBe(1);
      expect(refs[0]?.year.length).toBe(4);
      expect(refs[0]?.title.length).toBeGreaterThan(10);
    });
  }
});

describe("rate limiting fails closed instead of hanging", () => {
  const entry: RefEntry = {
    key: "x", title: "Some Paper", authors: ["Doe"], year: "2020",
    journal: "Some Journal", doi: "10.1234/abcd", raw: "x",
  };
  const alwaysRateLimited = () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return new Response("", { status: 429 });
    }) as unknown as typeof fetch;
    return { fetchFn, calls: () => calls };
  };

  test("a DOI lookup gives up after the retry budget", async () => {
    const stub = alwaysRateLimited();
    await expect(
      crossrefByDoi("10.1234/abcd", { fetchFn: stub.fetchFn, maxRetries: 2, retryBaseMs: 1 }),
    ).rejects.toThrow(RegistryUnreachable);
    expect(stub.calls()).toBe(3);   // the first attempt plus two retries, then it stops
  });

  test("a rate-limited entry audits to REGISTRY_UNREACHABLE, never to a pass", async () => {
    const stub = alwaysRateLimited();
    const r = await auditEntry(entry, { fetchFn: stub.fetchFn, maxRetries: 1, retryBaseMs: 1 });
    expect(r.verdict).toBe("REGISTRY_UNREACHABLE");
    expect(BLOCKING_VERDICTS).not.toContain(r.verdict);
  });
});

describe("finding the references section in a manuscript", () => {
  const body = "Intro paragraph about the study.\nMore body text here.\n";
  const refs = "Acs, Z. J. 1988. Innovation in large and small firms. AER, 78(4): 678-690.\n";

  test("finds a plain heading", () => {
    expect(referencesSection(`${body}\nReferences\n${refs}`)?.trim()).toBe(refs.trim());
  });

  test("finds a heading that carries an author's note", () => {
    expect(referencesSection(`${body}\nREFERENCES – TO RE DO; IGNORE\n${refs}`)?.trim()).toBe(refs.trim());
  });

  test("returns null when the draft has no reference list", () => {
    expect(referencesSection(`${body}We reference prior work throughout the paper.\n`)).toBeNull();
  });

  test("a sentence opening with a citation is why the null matters", () => {
    // Scanning a whole manuscript picks this up as if it were a bibliography entry.
    const prose = "Smith (2010) argued that incubators shape venture identity in ways founders rarely anticipate.";
    expect(parseTextRefs(prose).length).toBe(1);
  });
});

describe("a registry outage still uses the local library", () => {
  const down = (async () => new Response("", { status: 429 })) as unknown as typeof fetch;
  const opts = { fetchFn: down, maxRetries: 0, retryBaseMs: 1 };
  const entry: RefEntry = {
    key: "battilana2010", title: "Building Sustainable Hybrid Organizations",
    authors: ["Battilana", "Dorado"], year: "2010",
    journal: "Academy of Management Journal", doi: "", raw: "x",
  };
  const libraryHit = (over: Partial<LocalHit> = {}) => ({
    lookup: () => ({
      id: 1, title: "Building Sustainable Hybrid Organizations",
      year: "2010", journal: "Academy of Management Journal",
      authors: ["Battilana", "Dorado"], doi: "", pdf: null, ...over,
    }),
  });

  test("agreement with the library cannot certify: it stays unreachable", async () => {
    const r = await auditEntry(entry, { ...opts, local: libraryHit() });
    expect(r.verdict).toBe("REGISTRY_UNREACHABLE");
    expect(r.truth_source).toBe("local");
    expect(r.notes.join(" ")).toContain("not certification");
  });

  test("a contradiction against the library is still reported", async () => {
    const r = await auditEntry(entry, { ...opts, local: libraryHit({ authors: ["Eisenhardt"], year: "1989" }) });
    expect(r.verdict).toBe("INCONSISTENT");
    expect(r.truth_source).toBe("local");
  });

  test("with no library at all the entry fails closed", async () => {
    const r = await auditEntry(entry, opts);
    expect(r.verdict).toBe("REGISTRY_UNREACHABLE");
    expect(r.truth_source).toBeNull();
  });
});

test("a hard throttle trips the breaker so the rest of the run fails fast", async () => {
  let calls = 0;
  // Count only the throttled registry: Open Library is a separate service and is
  // deliberately still asked, so it must not be counted against the breaker.
  const fetchFn = (async (url: string) => {
    if (String(url).includes("api.crossref.org")) calls++;
    return new Response("", { status: 429 });
  }) as unknown as typeof fetch;
  const entries: RefEntry[] = Array.from({ length: 8 }, (_, i) => ({
    key: `e${i}`, title: `Paper number ${i}`, authors: ["Doe"], year: "2020",
    journal: "Journal", doi: "", raw: "x",
  }));
  const started = Date.now();
  const results = await auditAll(entries, { fetchFn, maxRetries: 1, retryBaseMs: 1 });
  expect(results.every((r) => r.verdict === "REGISTRY_UNREACHABLE")).toBe(true);
  // The first entry spends its ladder (one attempt plus one retry here) and trips
  // the breaker; the other seven are skipped without a single further request. A
  // budget that has run out stays out, so re-confirming it only makes people wait.
  expect(calls).toBe(2);
  expect(Date.now() - started).toBeLessThan(2000);
});

describe("surnames are read from either author shape", () => {
  test("compact initials do not become the surname", () => {
    // This shape produced author lists of ["ML"], ["WK"], ["RB"] and reported a
    // dozen correct references as INCONSISTENT against the registry.
    expect(familyNames("Besharov ML, Smith WK. ")).toEqual(["Besharov", "Smith"]);
    expect(familyNames("Battilana J, Dorado S. ")).toEqual(["Battilana", "Dorado"]);
    expect(familyNames("Greenwood R, Raynard M, Kodeih F. ")).toEqual(["Greenwood", "Raynard", "Kodeih"]);
  });

  test("the punctuated shape still wins where both could match", () => {
    expect(familyNames("Acs, Z. J., & Audretsch, D. B. ")).toEqual(["Acs", "Audretsch"]);
    expect(familyNames("van Werven, R., Bouwmeester, O., & Cornelissen, J. P. ")).toEqual(["Werven", "Bouwmeester", "Cornelissen"]);
  });

  test("end to end, a compact entry keeps its real surnames", () => {
    const [ref] = parseTextRefs("Besharov ML, Smith WK. 2014. Multiple institutional logics in organizations: Explaining their varied nature. Academy of Management Review 39(3): 364-381.");
    expect(ref?.authors).toEqual(["Besharov", "Smith"]);
    expect(ref?.key).toBe("besharov2014");
  });
});

test("a title ending in a question mark does not swallow the journal", () => {
  const [ref] = parseTextRefs("Baptista, R., & Swann, P. 1998. Do firms in clusters innovate more? Research Policy, 27(5): 525-540.");
  expect(ref?.title).toBe("Do firms in clusters innovate more?");
});

describe("comparisons that used to fire on nothing", () => {
  test("a surname particle is not an author mismatch", () => {
    // "van Lente" in a library against "Lente" in the draft is one person.
    expect(authorOverlap(["Lente"], ["van Lente"])).toBe(1);
    expect(authorOverlap(["van Lente"], ["Lente"])).toBe(1);
    expect(authorOverlap(["Ven"], ["Van de Ven"])).toBe(1);
    expect(authorOverlap(["Smith"], ["Jones"])).toBe(0);
  });

  test("a missing year is not a year mismatch", () => {
    const entry: RefEntry = {
      key: "wood2021", title: "Back to the Future", authors: ["Wood"], year: "2021",
      journal: "Academy of Management Review", doi: "", raw: "x",
    };
    const blankYear: Truth = {
      source: "local", title: "Back to the Future", year: "", journal: "Academy of Management Review",
      doi: "", authors: ["Wood"], retracted: false,
    };
    const zeroYear: Truth = { ...blankYear, year: "0000" };
    // This reported "year off by 2021: 2021 vs 0000" against a library record
    // that simply had no year.
    expect(compare(entry, blankYear).notes.join(" ")).not.toContain("year off by");
    expect(compare(entry, zeroYear).notes.join(" ")).not.toContain("year off by");
    expect(compare(entry, blankYear).verdict).not.toBe("INCONSISTENT");
  });
});

test("a compound surname matches its short form", () => {
  expect(authorOverlap(["Lingo"], ["Long Lingo"])).toBe(1);
  expect(authorOverlap(["O’Mahony"], ["O'Mahony"])).toBe(1);
  expect(authorOverlap(["Brown"], ["Crilly"])).toBe(0);
});

describe("the report says how a record was found", () => {
  test("an accented surname keeps its letters in the key", () => {
    // "Tötterman" keyed as "ttterman" because a bare [^a-z] strip deleted the umlaut.
    const [ref] = parseTextRefs("Tötterman, H., & Sten, J. 2005. Start-ups: Business incubation and social capital. International Small Business Journal, 23(5): 487-511.");
    expect(ref?.key).toBe("totterman2005");
  });

  test("a DOI-anchored match records its basis and the matched record", async () => {
    const fetchFn = xrefStub();
    const entry: RefEntry = {
      key: "doe2010", title: "A Real Paper", authors: ["Doe"], year: "2010",
      journal: "Some Journal", doi: "10.1234/abcd", raw: "x",
    };
    const r = await auditEntry(entry, { fetchFn });
    expect(r.match_basis).toBe("doi");
    expect(r.truth_authors).toEqual(["Doe"]);
    expect(r.truth_year).toBe("2010");
    expect(r.truth_doi).toBe("10.1234/abcd");
    expect(r.truth_id).toBe("https://doi.org/10.1234/abcd");
  });

  test("a search match records a confidence between 0 and 1", async () => {
    const fetchFn = xrefStub(xref({ DOI: undefined }));
    const entry: RefEntry = {
      key: "doe2010", title: "A Real Paper", authors: ["Doe"], year: "2010",
      journal: "Some Journal", doi: "", raw: "x",
    };
    const r = await auditEntry(entry, { fetchFn });
    expect(r.match_basis).toBe("search");
    expect(r.match_confidence).toBeGreaterThan(0.6);
    expect(r.match_confidence).toBeLessThanOrEqual(1);
  });
});

describe("reference kind is read from the reference string", () => {
  const cases: Array<[string, string]> = [
    ["journal", "Tötterman, H. 2005. Start-ups: Business incubation and social capital. International Small Business Journal, 23(5): 487-511."],
    ["book", "Weick, K. E. 1995. Sensemaking in organizations (Vol. 3). Thousand Oaks, CA: Sage."],
    ["book", "Miller, P., & Bound, K. 2011. The startup factories. London: NESTA."],
    ["thesis", "Christiansen, J. 2009. Copying Y-Combinator. MBA dissertation, University of Cambridge."],
    ["report", "van Huijgevoort, T. 2012. The business accelerator. Working paper, Utrecht University."],
    ["web", "Strauss, K. 2013. Why coworking spaces are here to stay. Forbes. https://www.forbes.com/sites/karstenstrauss/"],
    ["chapter", "Soubliere, J.-F. 2022. Cultural entrepreneurship. In C. Lockwood & J. Soubliere (Eds.), Advances in cultural entrepreneurship."],
  ];
  for (const [expected, raw] of cases) {
    test(expected, () => expect(referenceKind(raw)).toBe(expected));
  }

  test("the registry is only expected to cover serials", () => {
    expect(REGISTRY_COVERS.journal).toBe(true);
    expect(REGISTRY_COVERS.book).toBe(false);
    expect(REGISTRY_COVERS.thesis).toBe(false);
  });
});

describe("a generic title that matches the wrong work is not called an error", () => {
  const wrongWork = xref({
    DOI: undefined, title: ["Designing qualitative research"],
    author: [{ family: "Ahmadi" }, { family: "Kaveh" }], issued: { "date-parts": [[1989]] },
    "container-title": [""],
  });
  const fetchFn = xrefStub(wrongWork);

  test("short title, no shared author, no DOI anchor -> not found, with no record shown", async () => {
    const entry: RefEntry = {
      key: "marshall1995", title: "Designing Qualitative Research",
      authors: ["Marshall", "Rossman"], year: "1995", journal: "", doi: "", raw: "x",
    };
    const r = await auditEntry(entry, { fetchFn });
    // A record with no author in common is no candidate at all; showing it was
    // noise (triage round, 2026-10-15). It reads as not found.
    expect(r.verdict).toBe("UNVERIFIED");
    expect(BLOCKING_VERDICTS).not.toContain(r.verdict);
    expect(r.truth_title).toBeNull();
  });

  test("a DOI anchor makes the same disagreement a real error", async () => {
    // The DOI, not the title's length, is what settles which work was matched.
    // Real drafts produced wrong matches on long distinctive titles too: "Why the
    // Lean Start-Up Changes Everything" matched a paper by different authors
    // entirely, so title length turned out to be the wrong discriminator.
    const anchored = xrefStub(xref({
      title: ["Designing qualitative research"], author: [{ family: "Ahmadi" }],
      issued: { "date-parts": [[1989]] }, "container-title": [""],
    }));
    const entry: RefEntry = {
      key: "marshall1995", title: "Designing Qualitative Research",
      authors: ["Marshall", "Rossman"], year: "1995", journal: "", doi: "10.1234/abcd", raw: "x",
    };
    const r = await auditEntry(entry, { fetchFn: anchored });
    expect(r.verdict).toBe("INCONSISTENT");
  });

  test("Open Library listing only the first author is not a disagreement", async () => {
    // OL work records routinely carry one author; three claimed against one listed
    // reported correct book citations as errors in four real drafts.
    const ol = (async (url: string) =>
      String(url).includes("openlibrary.org")
        ? new Response(JSON.stringify({ docs: [{ title: "An introduction to reasoning", author_name: ["Stephen Toulmin"], first_publish_year: 1979, edition_count: 1, key: "/works/OL5W" }] }), { status: 200 })
        : new Response(JSON.stringify({ results: [] }), { status: 200 })) as unknown as typeof fetch;
    const r = await auditEntry({
      key: "toulmin1979", title: "An introduction to reasoning", authors: ["Toulmin", "Rieke", "Janik"],
      year: "1979", journal: "", doi: "",
      raw: "Toulmin, S., Rieke, R., & Janik, A. 1979. An introduction to reasoning. New York: Macmillan.",
    }, { fetchFn: ol });
    expect(r.verdict).toBe("CONSISTENT");
  });
});

describe("books route to Open Library", () => {
  const olDocs = (docs: unknown[]) => (async (url: string) =>
    String(url).includes("openlibrary.org")
      ? new Response(JSON.stringify({ docs }), { status: 200 })
      : new Response(JSON.stringify({ results: [] }), { status: 200 })) as unknown as typeof fetch;

  const weick: RefEntry = {
    key: "weick1995", title: "Sensemaking in organizations", authors: ["Weick"], year: "1995",
    journal: "", doi: "",
    raw: "Weick, K. E. 1995. Sensemaking in organizations (Vol. 3). Thousand Oaks, CA: Sage.",
  };

  test("a book the article index cannot confirm is found in Open Library", async () => {
    const r = await auditEntry(weick, {
      fetchFn: olDocs([{ title: "Sensemaking in organizations", author_name: ["Karl E. Weick"], first_publish_year: 1995, edition_count: 1, key: "/works/OL1W" }]),
    });
    expect(r.verdict).toBe("CONSISTENT");
    expect(r.match_basis).toBe("book");
    expect(r.truth_id).toBe("https://openlibrary.org/works/OL1W");
  });

  test("a year gap on a multi-edition work is an edition, not an error", async () => {
    // Cited as the 2009 printing; Open Library records the 1967 first edition.
    const grounded: RefEntry = {
      key: "glaser2009", title: "The discovery of grounded theory", authors: ["Glaser", "Strauss"],
      year: "2009", journal: "", doi: "",
      raw: "Glaser, B. G., & Strauss, A. L. 2009. The discovery of grounded theory. New Brunswick, NJ: Aldine.",
    };
    const r = await auditEntry(grounded, {
      fetchFn: olDocs([{ title: "The discovery of grounded theory", author_name: ["Barney G. Glaser", "Anselm L. Strauss"], first_publish_year: 1967, edition_count: 4, key: "/works/OL2W" }]),
    });
    // The record carries no edition years here, so the gap cannot be settled: it is
    // an edition question for the author, which is review, not drift.
    expect(r.verdict).toBe("AMBIGUOUS_MATCH");
    expect(r.notes[0]).toContain("4 editions");
    expect(BLOCKING_VERDICTS).not.toContain(r.verdict);
  });

  test("a clear journal article is never sent to the book index", async () => {
    let hitBooks = false;
    const fetchFn = (async (url: string) => {
      if (String(url).includes("openlibrary.org")) hitBooks = true;
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await auditEntry({
      key: "t1983", title: "Institutional sources of change", authors: ["Tolbert"], year: "1983",
      journal: "Administrative Science Quarterly", doi: "",
      raw: "Tolbert, P. S. 1983. Institutional sources of change. Administrative Science Quarterly, 28(1), 22-39.",
    }, { fetchFn });
    expect(hitBooks).toBe(false);
  });
});

test("edition furniture is stripped before querying the book index", () => {
  // Open Library returned ZERO documents for the title with "(Vol. 3)" left in.
  expect(bookQuery({ key: "w", title: "Sensemaking in organizations (Vol. 3)", authors: ["Weick"], year: "1995", journal: "", doi: "", raw: "x" }))
    .toBe("Sensemaking in organizations Weick");
  expect(bookQuery({ key: "r", title: "Case study research: Design and methods, 3rd edition", authors: ["Yin"], year: "2003", journal: "", doi: "", raw: "x" }))
    .toBe("Case study research Design and methods Yin");
});

describe("Crossref is the only article registry", () => {
  const entry: RefEntry = {
    key: "tolbert1983", title: "A Real Paper", authors: ["Doe"], year: "2010",
    journal: "Some Journal", doi: "",
    raw: "Doe, J. 2010. A real paper. Some Journal, 28(1), 22-39.",
  };

  test("a DOI-less article is resolved in a single Crossref call", async () => {
    let calls = 0;
    const fetchFn = (async (u: any) => {
      const url = String(u);
      if (url.includes("api.crossref.org")) { calls++; return new Response(JSON.stringify({ message: { items: [xref()] } }), { status: 200 }); }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const r = await auditEntry(entry, { fetchFn });
    expect(r.verdict).toBe("CONSISTENT");
    expect(r.truth_source).toBe("crossref");
    // One call. The retraction record rides along in the search response, so there
    // is no second lookup to confirm it.
    expect(calls).toBe(1);
  });

  test("a retraction is read from the search response itself", async () => {
    const retracted = xref({ "updated-by": [{ type: "retraction", source: "retraction-watch", DOI: "10.1234/notice" }] });
    const r = await auditEntry(entry, { fetchFn: xrefStub(retracted) });
    expect(r.verdict).toBe("RETRACTED");
  });

  test("a correction notice is not a retraction", async () => {
    const corrected = xref({ "updated-by": [{ type: "correction", source: "retraction-watch", DOI: "10.1234/notice" }] });
    const r = await auditEntry(entry, { fetchFn: xrefStub(corrected) });
    expect(r.verdict).toBe("CONSISTENT");
  });

  test("a Crossref outage fails closed rather than passing", async () => {
    const down = (async (u: any) =>
      String(u).includes("api.crossref.org")
        ? new Response("", { status: 503 })
        : new Response(JSON.stringify({ docs: [] }), { status: 200 })) as unknown as typeof fetch;
    const r = await auditEntry(entry, { fetchFn: down });
    expect(r.verdict).toBe("REGISTRY_UNREACHABLE");
    expect(BLOCKING_VERDICTS).not.toContain(r.verdict);
  });
});

test("institutional words in an author run are not treated as surnames", () => {
  expect(familyNames("Murphy, L. M., Edwards, P. L., National Renewable Energy Laboratory, & Acme LLC, "))
    .toEqual(["Murphy", "Edwards"]);
});

test("an APA date carrying a month still parses", () => {
  // Trade press and reports date to the month, and a year-only parenthesis test
  // dropped them silently: the entry never reached the registry at all.
  const refs = parseTextRefs([
    "Christensen, C. M. (2015, December). What is disruptive innovation? Harvard Business Review. https://hbr.org/2015/12/what-is-disruptive-innovation",
    "Blank, S. (2013, May 1). Why the lean start-up changes everything. Harvard Business Review, 91(5), 63-72.",
  ].join("\n\n"));
  expect(refs.length).toBe(2);
  expect(refs[0]?.year).toBe("2015");
  expect(refs[0]?.title).toBe("What is disruptive innovation?");
  expect(refs[1]?.year).toBe("2013");
});

// ---------- the published state (2026-10-15 audit of Logue & Grimes 2022) ----------
//
// Six "year off by 1" flags on that manuscript cited the correct print year. The
// tool read only Crossref's `issued`, which is the earlier of print and online, so
// every online-first paper looked a year out. Six more multi-year gaps were called
// benign although they were different records, and the one blocking verdict was a
// search that had found a different paper by the same authors.

describe("the print year is the published state", () => {
  const grodal: RefEntry = {
    key: "grodal2018", title: "Field expansion and contraction: How communities shape social and symbolic boundaries",
    authors: ["Grodal"], year: "2018", journal: "Administrative Science Quarterly", doi: "", raw: "x",
  };
  // Crossref's real shape for this paper: online November 2017, in print December 2018.
  const onlineFirst = xref({
    DOI: "10.1177/0001839217744555", title: ["Field Expansion and Contraction: How Communities Shape Social and Symbolic Boundaries"],
    author: [{ family: "Grodal" }], "container-title": ["Administrative Science Quarterly"],
    issued: { "date-parts": [[2017, 11, 27]] },
    "published-online": { "date-parts": [[2017, 11, 27]] },
    "published-print": { "date-parts": [[2018, 12]] },
  });

  test("the search asks Crossref for the print and online dates", async () => {
    const seen: string[] = [];
    const base = xrefStub(onlineFirst);
    await auditEntry(grodal, { fetchFn: (async (u: any) => { seen.push(String(u)); return base(u); }) as typeof fetch });
    const search = seen.find((u) => u.includes("api.crossref.org/works?")) ?? "";
    expect(search).toContain("published-print");
    expect(search).toContain("published-online");
  });

  test("citing the print year of an online-first paper is consistent", async () => {
    const r = await auditEntry(grodal, { fetchFn: xrefStub(onlineFirst) });
    expect(r.verdict).toBe("CONSISTENT");
    expect(r.notes).toEqual([]);
    expect(r.truth_year).toBe("2018");
  });

  test("citing the online year of a paper that has a print year is drift, and says so", async () => {
    // The print year is the published state. The online year is not wrong, so it
    // is not blocking, but it is not the published state either.
    const r = await auditEntry({ ...grodal, year: "2017" }, { fetchFn: xrefStub(onlineFirst) });
    expect(r.verdict).toBe("BENIGN_DRIFT");
    expect(r.notes).toEqual(["cited the online-first year (2017); the print year is 2018"]);
  });

  test("an online-first year three years before print is drift, not a record question", async () => {
    // kirtley2020 and logue2019a: online 2020 and 2019, in print 2023 and 2022.
    for (const [cited, online, print] of [["2020", 2020, 2023], ["2019", 2019, 2022]] as const) {
      const item = xref({
        DOI: undefined, title: ["What is a pivot?"], author: [{ family: "Kirtley" }], "container-title": ["Strategic Management Journal"],
        issued: { "date-parts": [[online]] }, "published-online": { "date-parts": [[online]] }, "published-print": { "date-parts": [[print]] },
      });
      const r = await auditEntry({
        key: "kirtley", title: "What is a pivot?", authors: ["Kirtley"], year: cited,
        journal: "Strategic Management Journal", doi: "", raw: "x",
      }, { fetchFn: xrefStub(item) });
      expect(r.verdict).toBe("BENIGN_DRIFT");
      expect(r.notes).toEqual([`cited the online-first year (${online}); the print year is ${print}`]);
      expect(r.truth_year).toBe(String(print));
    }
  });

  test("a record with no print year accepts any year it carries", () => {
    // Online-only journals and books have no print year to prefer.
    const t: Truth = { ...truth, year: "1999", years: [1998, 1999] };
    expect(compare(entry({ year: "1998" }), t)).toEqual({ verdict: "CONSISTENT", notes: [] });
  });

  test("a one-year gap that neither date explains is still drift, measured from the nearest year", async () => {
    const r = await auditEntry({ ...grodal, year: "2019" }, { fetchFn: xrefStub(onlineFirst) });
    expect(r.verdict).toBe("BENIGN_DRIFT");
    expect(r.notes.join(" ")).toContain("year off by 1: 2019 vs 2018");
  });

  test("compare accepts any year the record carries", () => {
    const t: Truth = { ...truth, year: "1999", years: [1998, 1999] };
    expect(compare(entry({ year: "1998" }), t)).toEqual({ verdict: "CONSISTENT", notes: [] });
    expect(compare(entry({ year: "1999" }), t)).toEqual({ verdict: "CONSISTENT", notes: [] });
    expect(compare(entry({ year: "1996" }), t).verdict).toBe("INCONSISTENT");
  });

  test("a book cited in a year one of its editions carries is consistent", async () => {
    const olDocs = (docs: unknown[]) => (async (url: string) =>
      String(url).includes("openlibrary.org")
        ? new Response(JSON.stringify({ docs }), { status: 200 })
        : new Response(JSON.stringify({ message: { items: [] } }), { status: 200 })) as unknown as typeof fetch;
    const r = await auditEntry({
      key: "glaser2009", title: "The discovery of grounded theory", authors: ["Glaser", "Strauss"],
      year: "2009", journal: "", doi: "",
      raw: "Glaser, B. G., & Strauss, A. L. 2009. The discovery of grounded theory. New Brunswick, NJ: Aldine.",
    }, {
      fetchFn: olDocs([{
        title: "The discovery of grounded theory", author_name: ["Barney G. Glaser", "Anselm L. Strauss"],
        first_publish_year: 1967, publish_year: [1967, 1999, 2009, 2017], edition_count: 4, key: "/works/OL2W",
      }]),
    });
    expect(r.verdict).toBe("CONSISTENT");
    expect(r.notes).toEqual([]);
  });
});

describe("Open Library ranking", () => {
  test("a record listing only the first author competes on equal terms, and the cited edition decides", async () => {
    // marshall1995: Open Library holds two work records for the book. The one with
    // both authors is the 2010 edition; the one listing only Marshall carries the
    // 1995 edition that was cited. Counting only full author lists picked 2010.
    const docs = [
      { title: "Designing Qualitative Research", author_name: ["Catherine Marshall", "Gretchen B. Rossman"],
        first_publish_year: 2010, publish_year: [2010, 2021, 2014, 2015], edition_count: 4, key: "/works/OL21092718W" },
      { title: "Designing qualitative research", author_name: ["Catherine Marshall"],
        first_publish_year: 1989, publish_year: [1995, 1989, 2006, 1999], edition_count: 5, key: "/works/OL1964270W" },
    ];
    const fetchFn = (async (url: string) =>
      String(url).includes("openlibrary.org")
        ? new Response(JSON.stringify({ docs }), { status: 200 })
        : new Response(JSON.stringify({ message: { items: [] } }), { status: 200 })) as unknown as typeof fetch;
    const r = await auditEntry({
      key: "marshall1995", title: "Designing Qualitative Research", authors: ["Marshall", "Rossman"], year: "1995",
      journal: "", doi: "", raw: "Marshall, C., & Rossman, G. B. 1995. Designing qualitative research. Thousand Oaks, CA: Sage.",
    }, { fetchFn });
    expect(r.truth_id).toBe("https://openlibrary.org/works/OL1964270W");
    expect(r.verdict).toBe("CONSISTENT");
  });
});

describe("the CLI report", () => {
  test("a record with no authors prints no 'undefined'", async () => {
    const { render } = await import("../src/cli.ts");
    const out = render([{
      key: "lamy2021", title: "The Next Ten Years of Impact Investment", year: "2021", verdict: "AMBIGUOUS_MATCH",
      notes: ["x"], truth_source: "crossref", truth_title: "Uniqlo: the next ten years", match_basis: "search",
      kind: "unknown", match_confidence: 0.75, truth_authors: null, truth_year: "2024",
      truth_doi: "10.1093/x", truth_id: null, local_id: null, local_pdf: null,
    }], "t");
    expect(out).not.toContain("undefined");
    expect(out).toContain('record: "Uniqlo: the next ten years" — 2024');
  });
});

describe("a search that found a different work is not a finding", () => {
  // The HBR summary was cited; the search found the PLOS ONE paper the same
  // authors wrote. Title similarity 0.50, accepted on the author overlap alone.
  const johnson: RefEntry = {
    key: "johnson2019", title: "Has sexual harassment at work decreased since #metoo?",
    authors: ["Johnson", "Keplinger", "Kirk", "Barnes"], year: "2019", journal: "Harvard Business Review", doi: "", raw: "x",
  };
  const plos = xref({
    DOI: "10.1371/journal.pone.0218313",
    title: ["Women at work: Changes in sexual harassment between September 2016 and September 2018"],
    author: [{ family: "Keplinger" }, { family: "Johnson" }, { family: "Kirk" }, { family: "Barnes" }],
    issued: { "date-parts": [[2019]] }, "container-title": ["PLOS ONE"],
  });

  test("a weak title match is reported as unverified, not as an error", async () => {
    const r = await auditEntry(johnson, { fetchFn: xrefStub(plos) });
    expect(r.verdict).toBe("UNVERIFIED");
    expect(BLOCKING_VERDICTS).not.toContain(r.verdict);
    const notes = r.notes.join(" ");
    expect(notes).toContain("different work");
    expect(notes).toContain("not evidence of an error");
    expect(notes).not.toContain("venue mismatch");
  });

  test("a strong title match whose venue disagrees is still field mixing", async () => {
    const r = await auditEntry({ ...johnson, title: (plos.title as string[])[0]! }, { fetchFn: xrefStub(plos) });
    expect(r.verdict).toBe("INCONSISTENT");
    expect(r.notes.join(" ")).toContain("venue mismatch");
  });

  test("when one registry returns a different work, the other is still asked", async () => {
    const weber: RefEntry = {
      key: "weber1947", title: "The theory of social and economic organization", authors: ["Weber"], year: "1947",
      journal: "", doi: "", raw: "x",
    };
    const fetchFn = (async (u: any) => {
      const url = String(u);
      if (url.includes("api.crossref.org/works?"))
        return new Response(JSON.stringify({ message: { items: [xref({
          // Shares half its words with the cited title, and the author, so it clears
          // the search bar while being a different work.
          DOI: "10.9999/other", title: ["Economic theory in modern states"], author: [{ family: "Weber" }],
          issued: { "date-parts": [[1947]] }, "container-title": [""],
        })] } }), { status: 200 });
      if (url.includes("openlibrary.org"))
        return new Response(JSON.stringify({ docs: [{
          title: "The theory of social and economic organization", author_name: ["Max Weber"],
          first_publish_year: 1947, edition_count: 1, key: "/works/OL9W",
        }] }), { status: 200 });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const r = await auditEntry(weber, { fetchFn });
    expect(r.verdict).toBe("CONSISTENT");
    expect(r.match_basis).toBe("book");
  });
});

describe("a year gap of two or more on a search match is a record question", () => {
  test("a 25-year gap on a strong title match asks which record was cited", async () => {
    const r = await auditEntry({
      key: "cialdini1993", title: "The Psychology of Persuasion", authors: ["Cialdini"], year: "1993",
      journal: "", doi: "", raw: "x",
    }, {
      fetchFn: xrefStub(xref({
        DOI: "10.1037/e507392018-001", title: ["Speaking of Psychology: The Power of Persuasion"],
        author: [{ family: "Cialdini" }], issued: { "date-parts": [[2018]] }, "container-title": [""],
      })),
    });
    expect(r.verdict).toBe("AMBIGUOUS_MATCH");
    expect(BLOCKING_VERDICTS).not.toContain(r.verdict);
    const notes = r.notes.join(" ");
    expect(notes).toContain("2018");
    expect(notes).toMatch(/which (edition|record)/);
  });

  test("a library match with a year gap of two or more is a record question too", async () => {
    const down = (async () => new Response("", { status: 429 })) as unknown as typeof fetch;
    const r = await auditEntry({
      key: "battilana2010", title: "Building Sustainable Hybrid Organizations", authors: ["Battilana", "Dorado"],
      year: "2010", journal: "Academy of Management Journal", doi: "", raw: "x",
    }, {
      fetchFn: down, maxRetries: 0, retryBaseMs: 1,
      local: { lookup: () => ({ id: 1, title: "Building Sustainable Hybrid Organizations", year: "2007",
        journal: "Academy of Management Journal", authors: ["Battilana", "Dorado"], doi: "", pdf: null }) },
    });
    expect(r.verdict).toBe("AMBIGUOUS_MATCH");
    expect(r.notes.join(" ")).toContain("2007");
  });
});

describe("the version of record beats a preprint", () => {
  const paper: RefEntry = {
    key: "doe2010", title: "A Real Paper", authors: ["Doe"], year: "2010", journal: "", doi: "", raw: "x",
  };
  const searchStub = (items: unknown[]) => (async (u: any) => {
    const url = String(u);
    if (url.includes("api.crossref.org/works?")) return new Response(JSON.stringify({ message: { items } }), { status: 200 });
    return new Response(JSON.stringify({ docs: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  // The journal record is a year off the cited year, so the preprint wins on the
  // year bonus alone: that is the case the preference exists for.
  const journal = xref({ DOI: "10.1234/vor", issued: { "date-parts": [[2012]] } });

  test("an SSRN record ranked first loses to the journal article", async () => {
    // SSRN deposits as "journal-article" in "SSRN Electronic Journal", so the
    // prefix is the reliable sign.
    const ssrn = xref({ DOI: "10.2139/ssrn.1234567", "container-title": ["SSRN Electronic Journal"] });
    const r = await auditEntry(paper, { fetchFn: searchStub([ssrn, journal]) });
    expect(r.truth_doi).toBe("10.1234/vor");
  });

  test("a posted-content record ranked first loses to the journal article", async () => {
    const preprint = xref({ DOI: "10.31235/osf.io/abcde", type: "posted-content", "container-title": [] });
    const r = await auditEntry(paper, { fetchFn: searchStub([preprint, journal]) });
    expect(r.truth_doi).toBe("10.1234/vor");
  });

  test("a preprint that matches far better than any journal record is kept", async () => {
    const ssrn = xref({ DOI: "10.2139/ssrn.1234567" });
    const other = xref({ DOI: "10.1234/other", title: ["Something else about real papers entirely"], author: [{ family: "Roe" }] });
    const r = await auditEntry(paper, { fetchFn: searchStub([ssrn, other]) });
    expect(r.truth_doi).toBe("10.2139/ssrn.1234567");
  });
});
