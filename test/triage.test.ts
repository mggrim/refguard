import { describe, expect, test } from "bun:test";
import { auditEntry } from "../src/core/audit.ts";
import { attentionFor } from "../src/core/attention.ts";
import { referenceKind } from "../src/core/parse.ts";
import type { AuditResult, RefEntry, Truth } from "../src/core/types.ts";

// The Remaking Capitalism run returned 29 non-consistent results out of 132, and
// about two were worth the author's time. These tests pin down the rules that
// separate the two, case by case from that run.

const crossrefItem = (over: Record<string, unknown> = {}) => ({
  DOI: "10.1234/abcd", title: ["A Real Paper"], author: [{ family: "Doe" }],
  issued: { "date-parts": [[2010]] }, "container-title": ["Some Journal"], type: "journal-article", ...over,
});

/** Serves the given Crossref items to a search, nothing from Open Library, and counts calls. */
function registry(items: unknown[], docs: unknown[] = []) {
  const calls: string[] = [];
  const fetchFn = (async (u: any) => {
    const url = String(u);
    calls.push(url);
    if (url.includes("api.crossref.org/works?")) return new Response(JSON.stringify({ message: { items } }), { status: 200 });
    if (url.includes("openlibrary.org")) return new Response(JSON.stringify({ docs }), { status: 200 });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const ref = (over: Partial<RefEntry>): RefEntry => ({
  key: "k", title: "A Real Paper", authors: ["Doe"], year: "2010", journal: "", doi: "", raw: "x", ...over,
});

describe("sources no registry indexes are not searched", () => {
  test("a web page is reported as outside the registry with no record shown", async () => {
    const { fetchFn, calls } = registry([crossrefItem({ title: ["Getting the word out about lab animal science"], author: [{ family: "Roe" }] })]);
    const r = await auditEntry(ref({
      key: "blab2021a", title: "About B Corps", authors: [], year: "2021",
      raw: "B Lab. 2021a. About B Corps. Certified B Corporation. https://bcorporation.net/about-b-corps.",
    }), { fetchFn });
    expect(calls.filter((u) => u.includes("api.crossref.org") || u.includes("openlibrary.org"))).toEqual([]);
    expect(r.verdict).toBe("UNVERIFIED");
    expect(r.truth_title).toBeNull();
    expect(r.attention?.level).toBe("cant");
    expect(r.attention?.reason).toContain("web page");
  });

  test("a title with a subtitle is not mistaken for a book's place and publisher", () => {
    expect(referenceKind("Logue, D., & Grimes, M. 2019. Platforms for the people: Enabling civic crowdfunding through the cultivation of institutional infrastructure. Strategic Management Journal, 1–31.")).not.toBe("book");
    expect(referenceKind("Gehman, J., Treviño, L. K., & Garud, R. 2013. Values work: A process study of the emergence and performance of organizational values practices. Academy of Management Journal, 56: 84–112.")).not.toBe("book");
    expect(referenceKind("Weick, K. E. 1995. Sensemaking in organizations. Thousand Oaks, CA: Sage.")).toBe("book");
  });

  test("a short record title inside a long cited one, by other authors, is not field mixing", async () => {
    const { fetchFn } = registry([crossrefItem({ title: ["Benefit Corporation Legislation"], author: [{ family: "Resor" }], issued: { "date-parts": [[2012]] } })]);
    const r = await auditEntry(ref({
      key: "asmus2017", title: "Finding the benefit in a new administration: A uniform B Corporation legislation notes", authors: ["Asmus"], year: "2017",
      raw: "Asmus, K. 2017. Finding the benefit in a new administration: A uniform B Corporation legislation notes. Journal of Corporation Law, 43(2): 375–394.",
    }), { fetchFn });
    expect(r.verdict).toBe("UNVERIFIED");
    expect(r.attention?.level).toBe("cant");
  });

  test("a record listing no authors does not confirm a reference that names some", async () => {
    const { fetchFn } = registry([crossrefItem({ title: ["Corporations: Exercise of Eminent Domain by Domestic Corporation for Benefit of Foreign Corporation"], author: [], issued: { "date-parts": [[1930]] } })]);
    const r = await auditEntry(ref({
      key: "khatib2015", title: "The harms of the benefit corporation", authors: ["Khatib"], year: "2015",
      raw: "El Khatib, K. 2015. The harms of the benefit corporation. American University Law Review, 65(1): 151–190.",
    }), { fetchFn });
    expect(r.verdict).toBe("UNVERIFIED");
  });

  test("a chapter deposited without authors still matches when its title matches outright", async () => {
    const { fetchFn } = registry([crossrefItem({ DOI: "10.4337/9781839105340.00034", type: "book-chapter", author: [],
      title: ["Becoming a generalized specialist: A strategic model for increasing your organization’s SDG impact while minimizing externalities"],
      issued: { "date-parts": [[2022]] }, "container-title": ["Handbook"] })]);
    const r = await auditEntry(ref({
      key: "park2022", title: "Becoming a Generalized Specialist: A Strategic Model for Increasing Your Organization’s SDG Impact While Minimizing Externalities",
      authors: ["Park", "Grimes", "Gehman"], year: "2022", raw: "x",
    }), { fetchFn });
    expect(r.verdict).toBe("CONSISTENT");
  });

  test("a teaching case is a report", () => {
    expect(referenceKind("Marquis, C., Klaber, A., & Thomason, B. 2010. B Lab: Building a new sector of the economy. Harvard Business School Case, 411047.")).toBe("report");
  });

  test("a reference ending on its publisher is a book", () => {
    expect(referenceKind("Henderson, R. 2020. Reimagining Capitalism in a World on Fire. Penguin UK.")).toBe("book");
    expect(referenceKind("Adler, P. S. 2019. The 99 percent economy: How democratic socialism can overcome the crises of capitalism. Oxford University Press.")).toBe("book");
  });
});

describe("a record with no author in common is not a candidate", () => {
  test("no shared author and no DOI is not found, and no record is shown", async () => {
    const { fetchFn } = registry([crossrefItem({ DOI: "10.2307/1280755", title: ["The harms of the benefit corporation"], author: [{ family: "Smith" }], issued: { "date-parts": [[1930]] } })]);
    const r = await auditEntry(ref({
      key: "khatib2015", title: "The harms of the benefit corporation", authors: ["Khatib"], year: "2015",
      raw: "El Khatib, K. 2015. The harms of the benefit corporation. American University Law Review, 65(1): 151–190.",
    }), { fetchFn });
    expect(r.verdict).toBe("UNVERIFIED");
    expect(r.truth_title).toBeNull();
    expect(r.attention?.level).toBe("cant");
  });

  test("a distinctive journal title that matches exactly under other authors is still field mixing", async () => {
    const { fetchFn } = registry([crossrefItem({
      title: ["Building sustainable hybrid organizations: The case of commercial microfinance organizations"],
      author: [{ family: "Pache" }, { family: "Santos" }], issued: { "date-parts": [[2010]] }, "container-title": ["Academy of Management Journal"],
    })]);
    const r = await auditEntry(ref({
      key: "smith2010", title: "Building sustainable hybrid organizations: The case of commercial microfinance organizations",
      authors: ["Smith", "Jones"], year: "2010",
      raw: "Smith, A., & Jones, B. 2010. Building sustainable hybrid organizations: The case of commercial microfinance organizations. Academy of Management Journal, 53(6): 1419–1440.",
    }), { fetchFn });
    expect(r.verdict).toBe("INCONSISTENT");
    expect(r.attention?.level).toBe("fix");
  });

  test("a generic title with an author in common but other fields different stays an ambiguous match", async () => {
    const { fetchFn } = registry([crossrefItem({ title: ["Designing case studies"], author: [{ family: "Yin" }], issued: { "date-parts": [[2003]] }, "container-title": ["Some Handbook"] })]);
    const r = await auditEntry(ref({
      key: "yin2003", title: "Designing case studies", authors: ["Yin"], year: "2003", journal: "Qualitative Research Methods",
      raw: "Yin, R. K. 2003. Designing case studies. Qualitative Research Methods, 5(14): 359-386.",
    }), { fetchFn });
    expect(r.verdict).toBe("AMBIGUOUS_MATCH");
    expect(r.attention?.level).toBe("fine");
  });
});

describe("a book is never matched to a journal article", () => {
  test("a review carrying the book's title, and the author's own article of a similar name, are both passed over", async () => {
    const { fetchFn } = registry([
      crossrefItem({ DOI: "10.1177/00943061211021084", title: ["The 99 Percent Economy: How Democratic Socialism Can Overcome the Crises of Capitalism"], author: [{ family: "Leveille" }], issued: { "date-parts": [[2021]] } }),
      crossrefItem({ DOI: "10.1177/2694105820210101004", title: ["The 99 percent economy"], author: [{ family: "Adler" }], issued: { "date-parts": [[2021]] } }),
    ]);
    const r = await auditEntry(ref({
      key: "adler2019", title: "The 99 percent economy: How democratic socialism can overcome the crises of capitalism",
      authors: ["Adler"], year: "2019",
      raw: "Adler, P. S. 2019. The 99 percent economy: How democratic socialism can overcome the crises of capitalism. Oxford University Press.",
    }), { fetchFn });
    expect(r.truth_doi).toBeNull();
    expect(r.attention?.level).toBe("cant");
  });
});

describe("attention levels", () => {
  const truth = (over: Partial<Truth>): Truth => ({
    source: "crossref", title: "Platforms for the people", year: "2022", years: [2019, 2022], printYear: 2022,
    journal: "Strategic Management Journal", volume: "43", issue: "3", doi: "10.1002/smj.3110", authors: ["Logue", "Grimes"],
    retracted: false, type: "journal-article", ...over,
  });
  const result = (over: Partial<AuditResult>): AuditResult => ({
    key: "k", title: "", year: "", verdict: "BENIGN_DRIFT", notes: [], truth_source: "crossref", truth_title: "x",
    match_basis: "search", kind: "journal", match_confidence: 1, truth_authors: null, truth_year: null, truth_doi: null,
    truth_id: null, local_id: null, local_pdf: null, ...over,
  });
  const logue = ref({ title: "Platforms for the people", authors: ["Logue", "Grimes"], year: "2019",
    raw: "Logue, D., & Grimes, M. 2019. Platforms for the people. Strategic Management Journal, 1–31." });

  test("consistent needs nothing", () => {
    expect(attentionFor(logue, "journal", result({ verdict: "CONSISTENT" }), truth({}))).toBeNull();
  });

  test("an online-first year where a version of record exists is worth a look, with both years and the venue", () => {
    const a = attentionFor(logue, "journal", result({}), truth({}));
    expect(a).toEqual({ level: "look", reason: "You cited the online-first year (2019). The version of record is Strategic Management Journal, 43(3), 2022." });
  });

  test("a citation made before publication, now published, is worth a look", () => {
    const radoynovska = ref({ title: "A matter of transition", authors: ["Radoynovska", "Ruttan"], year: "2021",
      raw: "Radoynovska, N., & Ruttan, R. 2021. A matter of transition. Organization Science." });
    const a = attentionFor(radoynovska, "unknown", result({ verdict: "AMBIGUOUS_MATCH" }),
      truth({ title: "A matter of transition", authors: ["Radoynovska", "Ruttan"], year: "2023", years: [2023], printYear: 2023, journal: "Organization Science", volume: "34", issue: "4" }));
    expect(a?.level).toBe("look");
    expect(a?.reason).toContain("Organization Science, 34(4), 2023");
  });

  test("a reprint of a work cited with its volume and pages is probably fine", () => {
    const king = ref({ title: "Strategic responses to the reputation commons problem", authors: ["King", "Lenox", "Barnett"], year: "2002",
      raw: "King, A. A., Lenox, M. J., & Barnett, M. L. 2002. Strategic responses to the reputation commons problem. Organizations, Policy and the Natural Environment, 43(1): 393–406." });
    const a = attentionFor(king, "journal", result({ verdict: "AMBIGUOUS_MATCH" }),
      truth({ title: "Strategic responses to the reputation commons problem", authors: ["King", "Lenox", "Barnett"], year: "2018", years: [2018], printYear: 2018, type: "book-chapter" }));
    expect(a?.level).toBe("fine");
  });

  test("a handbook chapter online after its printed volume is probably fine", () => {
    const cog = ref({ title: "Business and environmental law", authors: ["Coglianese", "Anderson"], year: "2012" });
    const a = attentionFor(cog, "unknown", result({}), truth({ title: "Business and environmental law", authors: ["Coglianese", "Anderson"], year: "2011", years: [2011, 2012], printYear: 2011, type: "book-chapter" }));
    expect(a?.level).toBe("fine");
    expect(a?.reason).toContain("Either year is defensible");
  });

  test("a cited year earlier than every edition the registry knows is probably fine", () => {
    const schein = ref({ title: "Organizational culture and leadership", authors: ["Schein"], year: "1985" });
    const a = attentionFor(schein, "book", result({ verdict: "AMBIGUOUS_MATCH", match_basis: "book" }),
      { ...truth({}), source: "openlibrary", title: "Organizational culture and leadership", authors: ["Schein"], year: "1992", years: [1992, 2004, 2010], printYear: undefined, type: undefined });
    expect(a?.level).toBe("fine");
    expect(a?.reason).toContain("earlier edition");
  });

  test("blocking verdicts are fix this, and not-found is can't check here", () => {
    expect(attentionFor(logue, "journal", result({ verdict: "RETRACTED" }), null)?.level).toBe("fix");
    expect(attentionFor(logue, "journal", result({ verdict: "FABRICATED_CANDIDATE" }), null)?.level).toBe("fix");
    expect(attentionFor(logue, "journal", result({ verdict: "UNVERIFIED" }), null)?.level).toBe("cant");
    expect(attentionFor(logue, "web", result({ verdict: "UNVERIFIED" }), null)?.reason).toContain("No registry indexes these");
  });
});

describe("the CLI groups results by attention", () => {
  test("fix this comes first, then worth a look, and the summary names how many need attention", async () => {
    const { render } = await import("../src/cli.ts");
    const base = { title: "T", year: "2019", notes: ["n"], truth_source: null, truth_title: null, match_basis: null, kind: "journal" as const,
      match_confidence: null, truth_authors: null, truth_year: null, truth_doi: null, truth_id: null, local_id: null, local_pdf: null };
    const out = render([
      { ...base, key: "web1", verdict: "UNVERIFIED", attention: { level: "cant", reason: "A web page." } },
      { ...base, key: "edition1", verdict: "AMBIGUOUS_MATCH", attention: { level: "fine", reason: "An edition." } },
      { ...base, key: "online1", verdict: "BENIGN_DRIFT", attention: { level: "look", reason: "Online-first year." } },
      { ...base, key: "mixed1", verdict: "INCONSISTENT", attention: { level: "fix", reason: "Fields mixed." } },
      { ...base, key: "ok1", verdict: "CONSISTENT", attention: null },
    ], "t");
    expect(out).toContain("Needs your attention: 2 (Fix this 1 · Worth a look 1) · Probably fine 1 · Can't check here 1 · Consistent 1");
    const at = (s: string) => out.indexOf(s);
    expect(at("FIX THIS")).toBeLessThan(at("WORTH A LOOK"));
    expect(at("WORTH A LOOK")).toBeLessThan(at("PROBABLY FINE"));
    expect(at("PROBABLY FINE")).toBeLessThan(at("CAN'T CHECK HERE"));
    expect(out).toContain("mixed1 \"T\": Fields mixed.");
  });
});
