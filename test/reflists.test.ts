import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readReferenceList, parseTextRefs } from "../src/core/parse.ts";
import { compare } from "../src/core/audit.ts";
import { crossrefSearch } from "../src/core/crossref.ts";
import type { RefEntry, Truth } from "../src/core/types.ts";

// One realistic list per format scholars paste, plus two real lists: the Hype
// manuscript's APA references as Word stores them, and the Remaking Capitalism
// references copied out of an AMJ proof PDF, page furniture, line numbers,
// tables and all. The expected counts were established by hand, entry by entry.

const fixture = (name: string) => Bun.file(join(import.meta.dir, "fixtures", "reflists", name)).text();

type Sample = { key: string; authors?: string[]; year?: string; title?: string; doi?: string };

function expectSamples(entries: RefEntry[], samples: Sample[]) {
  for (const s of samples) {
    const e = entries.find((x) => x.key === s.key);
    expect(e, `no entry keyed ${s.key}; keys were ${entries.map((x) => x.key).join(" ")}`).toBeDefined();
    if (s.authors) expect(e!.authors).toEqual(s.authors);
    if (s.year !== undefined) expect(e!.year).toBe(s.year);
    if (s.title) expect(e!.title).toBe(s.title);
    if (s.doi) expect(e!.doi).toBe(s.doi);
  }
}

describe("reference lists in the formats scholars paste", () => {
  test("APA 7, one reference per paragraph", async () => {
    const list = readReferenceList(await fixture("apa7.txt"));
    expect(list.style).toBe("author-date");
    expect(list.entries.length).toBe(13);
    expect(list.warnings).toEqual([]);
    expectSamples(list.entries, [
      { key: "aragoncorrea2003", authors: ["Aragón-Correa", "Sharma"], year: "2003" },
      { key: "blabnd", authors: [], year: "", title: "About B Corps" },
      { key: "backstrand2006", authors: ["Bäckstrand"], year: "2006", doi: "10.1002/eet.425" },
      { key: "blank2013", year: "2013", title: "Why the lean start-up changes everything" },
      { key: "eisenhardt1989a", year: "1989", title: "Building theories from case study research" },
      { key: "eisenhardt1989b", year: "1989", title: "Making fast strategic decisions in high-velocity environments" },
      { key: "gehman2018", authors: ["Gehman", "Glaser", "Eisenhardt", "Gioia", "Langley", "Corley"],
        title: "Finding theory–method fit: A comparison of three qualitative approaches to theory building" },
      { key: "lucasinpress", authors: ["Lucas", "Grimes", "Gehman"], year: "" },
      { key: "werven2015", authors: ["Werven", "Bouwmeester", "Cornelissen"], year: "2015" },
      { key: "worldeconomicforum2020", authors: [], year: "2020", title: "The global risks report 2020 (15th ed.)" },
    ]);
  });

  test("AMJ and ASQ style: bare year, letters, in press, forthcoming, n.d., corporate authors", async () => {
    const list = readReferenceList(await fixture("amj.txt"));
    expect(list.style).toBe("author-date");
    expect(list.entries.length).toBe(14);
    expect(list.warnings).toEqual([]);
    expectSamples(list.entries, [
      { key: "blab2021a", authors: [], year: "2021", title: "About B Corps" },
      { key: "blab2021b", year: "2021", title: "About B Lab" },
      { key: "barnett2008", authors: ["Barnett", "King"],
        title: "Good fences make good neighbors: A longitudinal analysis of an industry self-regulatory institution" },
      { key: "blank2013", year: "2013", title: "Why the lean start-up changes everything" },
      { key: "gartnernd", year: "", title: "Gartner hype cycle" },
      { key: "lehman2019", authors: ["Lehman", "O’Connor", "Kovács", "Newman"], title: "Authenticity" },
      { key: "lockwood2022", authors: ["Lockwood", "Soublière"], title: "Advances in cultural entrepreneurship" },
      { key: "lucasinpress", year: "" },
      { key: "murrayforthcoming", authors: ["Murray", "Fisher"], year: "",
        title: "When more is less: Explaining the curse of too much capital for early-stage ventures" },
      { key: "ven1986", authors: ["Ven"], year: "1986" },
      { key: "weick1995", title: "Sensemaking in organizations" },
    ]);
  });

  test("Chicago author-date: full given names and natural-order co-authors", async () => {
    const list = readReferenceList(await fixture("chicago.txt"));
    expect(list.style).toBe("author-date");
    expect(list.entries.length).toBe(11);
    expect(list.warnings).toEqual([]);
    expectSamples(list.entries, [
      { key: "dimaggio1983", authors: ["DiMaggio", "Powell"], year: "1983",
        title: "The Iron Cage Revisited: Institutional Isomorphism and Collective Rationality in Organizational Fields" },
      { key: "espeland2007", authors: ["Espeland", "Sauder"], year: "2007" },
      { key: "fligstein2012", authors: ["Fligstein", "McAdam"], title: "A Theory of Fields" },
      { key: "padgett1993", title: "Robust Action and the Rise of the Medici, 1400–1434" },
      { key: "stinchcombe1965", title: "Social Structure and Organizations" },
      { key: "weber1978", authors: ["Weber"], title: "Economy and Society: An Outline of Interpretive Sociology" },
    ]);
  });

  test("Harvard, with the year in parentheses and with a bare year and a comma", async () => {
    const list = readReferenceList(await fixture("harvard.txt"));
    expect(list.style).toBe("author-date");
    expect(list.entries.length).toBe(10);
    expect(list.warnings).toEqual([]);
    expectSamples(list.entries, [
      { key: "battilana2010", authors: ["Battilana", "Dorado"], year: "2010",
        title: "Building sustainable hybrid organizations: the case of commercial microfinance organizations" },
      { key: "dacin2010", authors: ["Dacin", "Dacin", "Matear"],
        title: "Social entrepreneurship: why we don’t need a new theory and how we move forward from here" },
      { key: "oliver1991", year: "1991", title: "Strategic responses to institutional processes" },
      { key: "pache2013", authors: ["Pache", "Santos"] },
      { key: "thornton2012", authors: ["Thornton", "Ocasio", "Lounsbury"],
        title: "The institutional logics perspective: a new approach to culture, structure and process" },
      { key: "worldeconomicforum2012", year: "2012" },
    ]);
  });

  test("MLA: the year comes after the venue", async () => {
    const list = readReferenceList(await fixture("mla.txt"));
    expect(list.style).toBe("mla");
    expect(list.entries.length).toBe(9);
    expect(list.warnings).toEqual([]);
    expectSamples(list.entries, [
      { key: "battilana2010", authors: ["Battilana", "Dorado"], year: "2010",
        title: "Building Sustainable Hybrid Organizations: The Case of Commercial Microfinance Organizations" },
      { key: "espeland2007", authors: ["Espeland", "Sauder"], year: "2007" },
      { key: "gehman2018", authors: ["Gehman"], year: "2018" },
      { key: "ostrom1990", year: "1990", title: "Governing the Commons: The Evolution of Institutions for Collective Action" },
      { key: "weick1995", authors: ["Weick"], year: "1995", title: "Sensemaking in Organizations" },
    ]);
  });

  test("numbered, IEEE style, including two entries on one line and one wrapped", async () => {
    const list = readReferenceList(await fixture("ieee.txt"));
    expect(list.style).toBe("numbered");
    expect(list.entries.length).toBe(9);
    expect(list.warnings).toEqual([]);
    expectSamples(list.entries, [
      { key: "eisenhardt1989", authors: ["Eisenhardt"], year: "1989", title: "Building theories from case study research" },
      { key: "christensen1997", year: "1997", title: "The Innovator’s Dilemma" },
      { key: "teece1997", authors: ["Teece", "Pisano", "Shuen"], title: "Dynamic capabilities and strategic management" },
      { key: "march1991", year: "1991" },
      { key: "henderson1990", authors: ["Henderson", "Clark"], year: "1990" },
    ]);
  });

  test("numbered, Vancouver style, wrapped across lines", async () => {
    const list = readReferenceList(await fixture("vancouver.txt"));
    expect(list.style).toBe("numbered");
    expect(list.entries.length).toBe(10);
    expect(list.warnings).toEqual([]);
    expectSamples(list.entries, [
      { key: "eisenhardt1989", authors: ["Eisenhardt"], year: "1989", title: "Building theories from case study research" },
      { key: "battilana2010", authors: ["Battilana", "Dorado"], year: "2010",
        title: "Building sustainable hybrid organizations: the case of commercial microfinance organizations" },
      { key: "wernerfelt1984", year: "1984", title: "A resource-based view of the firm" },
      { key: "nelson1982", authors: ["Nelson", "Winter"], year: "1982" },
      { key: "kahneman1979", year: "1979" },
    ]);
  });

  test("copied from a PDF: wrapped, run together, a page header, a broken DOI and a bio", async () => {
    const list = readReferenceList(await fixture("pdf-wrapped.txt"));
    expect(list.entries.length).toBe(11);
    expect(list.warnings).toEqual([]);
    expectSamples(list.entries, [
      { key: "aldrich1994", title: "Fools rush in? The institutional context of industry creation" },
      { key: "ansari2013", authors: ["Ansari", "Wijen", "Gray"], year: "2013" },
      { key: "barley1997", title: "Institutionalization and structuration: Studying the links between action and institution" },
      { key: "battilana2010", doi: "10.5465/amj.2010.57318391" },
      { key: "cardinal2001", year: "2001" },
      { key: "king2000", title: "Industry self-regulation without sanctions: The chemical industry’s responsible care program" },
      { key: "tolbert1983", title: "Institutional sources of change in the formal structure of organizations: The diffusion of civil service reform, 1880–1935" },
    ]);
    const brown = list.entries.find((e) => e.key === "brown1997")!;
    expect(brown.raw).not.toContain("Page 41");
    const last = list.entries.at(-1)!;
    expect(last.key).toBe("zuckerman1999");
    expect(last.raw).not.toContain("Jane Doe");
    expect(list.skipped.join(" ")).toContain("Jane Doe");
  });
});

describe("the two real reference lists", () => {
  test("Hype (APA, from the Word manuscript): all 102 references, and the tables after them skipped", async () => {
    const list = readReferenceList(await fixture("hype-apa.txt"));
    expect(list.entries.length).toBe(102);
    expect(list.warnings).toEqual([]);
    expectSamples(list.entries, [
      { key: "abrahamson1991", year: "1991" },
      { key: "gartnergroup1995", authors: [], year: "1995" },
      { key: "kpmg2019", authors: [], year: "2019", title: "Why impact investing is the wave of the future" },
      { key: "lamy2021", authors: ["Lamy", "Leijonhufvud", "O’Donohoe"], year: "2021" },
      { key: "lente2013", year: "2013", title: "Comparing technological hype cycles: Towards a theory" },
      { key: "monitorreport2009", year: "2009" },
      { key: "murrayforthcoming", authors: ["Murray", "Fisher"], year: "" },
      { key: "santos2009", authors: ["Santos", "Eisenhardt"], year: "2009",
        title: "Constructing markets and shaping boundaries: Entrepreneurial power in nascent fields" },
      { key: "seales2018", title: "What has #metoo actually changed?" },
      { key: "worldeconomicforum2012", year: "2012" },
    ]);
    expect(list.entries.at(-1)!.key).toBe("zuzul2020");
    expect(list.entries.at(-1)!.raw).not.toContain("Table 1");
    expect(list.skipped.join(" ")).toContain("Table 1. Overview of Case Studies");
  });

  test("Remaking Capitalism (AMJ, from the proof PDF): all 132 references", async () => {
    const list = readReferenceList(await fixture("remaking-amj-pdf.txt"));
    expect(list.style).toBe("author-date");
    expect(list.expected).toBe(132);
    expect(list.entries.length).toBe(132);
    expect(list.warnings).toEqual([]);
    expectSamples(list.entries, [
      { key: "adler2019", title: "The 99 percent economy: How democratic socialism can overcome the crises of capitalism" },
      { key: "andre2012", year: "2012" },
      { key: "athey2022", authors: ["Athey", "Imbens"] },
      { key: "bacademics2021", authors: [], year: "2021" },
      { key: "blab2021a", year: "2021" }, { key: "blab2021b" }, { key: "blab2021c" },
      { key: "brown2016",
        title: "Benefit Corporations: A Case Study in the Issues of Implementation and Adoption of the Fastest Growing Business Form in the United States" },
      { key: "giorgi2019", authors: ["Giorgi", "Maoret", "Zajac"] },
      { key: "khatib2015", year: "2015" },
      { key: "msci2019", authors: [] },
      { key: "murray2015a", year: "2015" }, { key: "murray2015b", year: "2015" },
      { key: "reay2005", authors: ["Reay", "Hinings"] },
      { key: "vasudeva2013",
        title: "Weaving Together the Normative and Regulative Roles of Government: How the Norwegian Sovereign Wealth Fund’s Responsible Conduct Is Shaping Firms’ Cross-Border Investments" },
      { key: "verhaal2017", authors: ["Verhaal", "Hoskins", "Lundmark"] },
      { key: "wooldridge1999", title: "Distribution-free estimation of some nonlinear panel data models" },
    ]);
    const last = list.entries.at(-1)!;
    expect(last.key).toBe("zietsma2010");
    expect(last.raw).not.toContain("Table");
    expect(list.skipped.join(" ")).toContain("Jane Doe");
  });
});

describe("entries are never lost silently", () => {
  test("two references the splitter cannot separate are flagged, and the count says one is missing", () => {
    const list = readReferenceList([
      "Adler, P. S. 2019. The 99 percent economy: How democratic socialism can overcome the crises of capitalism. Oxford University Press André, R. 2012. Assessing the accountability of the benefit corporation. Journal of Business Ethics, 110(1): 133–150.",
      "Weick, K. E. 1995. Sensemaking in organizations. Thousand Oaks, CA: Sage.",
    ].join("\n"));
    expect(list.entries.length).toBe(2);
    expect(list.expected).toBe(3);
    const kinds = list.warnings.map((w) => w.kind);
    expect(kinds).toContain("count");
    expect(kinds).toContain("merged");
    expect(list.warnings.find((w) => w.kind === "merged")?.key).toBe("adler2019");
  });

  test("text with a year but no author, between references, is reported", () => {
    const list = readReferenceList([
      "Weick, K. E. 1995. Sensemaking in organizations. Thousand Oaks, CA: Sage.",
      "(1994). A block with no author segment at all but plenty of length to pass the filter. Journal, 2(2), 2-9.",
      "Acs, Z. J., & Audretsch, D. B. 1988. Innovation in large and small firms: An empirical analysis. The American Economic Review, 78(4): 678-690.",
    ].join("\n\n"));
    expect(list.entries.map((e) => e.key)).toEqual(["weick1995", "acs1988"]);
    expect(list.skipped.join(" ")).toContain("A block with no author segment");
    expect(list.warnings.map((w) => w.kind)).toContain("skipped-year");
  });

  test("parseTextRefs still returns just the entries", () => {
    expect(parseTextRefs("Weick, K. E. 1995. Sensemaking in organizations. Thousand Oaks, CA: Sage.").map((e) => e.key))
      .toEqual(["weick1995"]);
  });
});

describe("two small registry fixes from the Remaking run", () => {
  const base: Truth = {
    source: "crossref", title: "Business and environmental law", year: "2011", years: [2011, 2012],
    printYear: 2011, journal: "", doi: "10.1093/oxfordhb/9780199584451.003.0008", authors: ["Coglianese", "Anderson"], retracted: false,
  };
  const entry: RefEntry = {
    key: "coglianese2012", title: "Business and environmental law", authors: ["Coglianese", "Anderson"],
    year: "2012", journal: "", doi: "", raw: "x",
  };

  test("an online year later than print is not called online-first", () => {
    expect(compare(entry, base).notes).toEqual(["cited the online year (2012); the print year is 2011"]);
  });

  test("a review of the cited book is never taken as the cited book", async () => {
    const scott: RefEntry = {
      key: "scott2014", title: "Institutions and organizations: Ideas, interests and identities", authors: ["Scott"],
      year: "2014", journal: "", doi: "", raw: "Scott, W. R. 2014. Institutions and organizations: Ideas, interests and identities (4th ed.). Thousand Oaks, CA: Sage.",
    };
    const item = (title: string, family: string, doi: string) => ({
      DOI: doi, title: [title], author: [{ family }], issued: { "date-parts": [[2014]] }, "container-title": ["M@n@gement"], type: "journal-article",
    });
    const fetchFn = (items: unknown[]) => (async () =>
      new Response(JSON.stringify({ message: { items } }), { status: 200 })) as unknown as typeof fetch;
    const review = item("W. Richard SCOTT (1995), Institutions and Organizations. Ideas, Interests and Identities.", "Desreumaux", "10.3917/mana.172.0136");
    const bookReview = item("Book Review: Institutions and organizations: Ideas, interests and identities", "Roe", "10.1234/br");
    expect(await crossrefSearch(scott, { fetchFn: fetchFn([review, bookReview]) })).toBeNull();
    const real = item("Institutions and organizations: Ideas, interests, and identities", "Scott", "10.1234/real");
    expect((await crossrefSearch(scott, { fetchFn: fetchFn([review, real]) }))?.truth.doi).toBe("10.1234/real");
  });
});

describe("the CLI reports the reading before any verdict", () => {
  test("parse warnings and set-aside text are printed", async () => {
    const { renderReading } = await import("../src/cli.ts");
    const list = readReferenceList([
      "Adler, P. S. 2019. The 99 percent economy. Oxford University Press André, R. 2012. Assessing the accountability of the benefit corporation. Journal of Business Ethics, 110(1): 133–150.",
      "Jane Doe (jane.doe@example.edu) is an Assistant Professor of Management at Example University.",
    ].join("\n"));
    const out = renderReading(list).join("\n");
    expect(out).toContain("READ: 1 references");
    expect(out).toContain("appears to hold 2");
    expect(out).toContain("PARSE WARNINGS");
    expect(out).toContain("adler2019 may hold more than one reference");
    expect(out).toContain("Jane Doe");
  });
});
