# RefGuard

Deterministic reference-integrity auditing for academic manuscripts. RefGuard checks every entry in a bibliography against the scholarly record and answers: **does this paper exist, do the fields actually belong to it, and has it been retracted?**

No AI is involved in the audit — it is pure registry lookup and field comparison, so it cannot hallucinate. An optional agentic layer (the bundled Claude Code plugin) adds the complementary check: *does each cited paper actually say what the manuscript claims it says?*

## What it catches

- **Fabricated references** — a DOI registered nowhere (checked at both OpenAlex and the doi.org handle registry)
- **Field mixing** — one paper's title with another paper's authors, year, or journal (the most common silent error in inherited bibliographies)
- **Wrong authors, years, venues, DOIs** — including near-twin journal confusions ("… Review" vs "… Journal")
- **Retracted papers** — via OpenAlex retraction flags
- **Benign drift** — online-first vs print years, dropped subtitles (reported, not blocking)

## Fail-closed by design

A network failure is `REGISTRY_UNREACHABLE` (exit 2, "cannot certify") — never a fabrication verdict and never a silent pass. `FABRICATED_CANDIDATE` requires positive evidence: a 404 at **both** OpenAlex and doi.org. Anything unrecognized routes to review, never to passing.

| Verdict | Meaning | Tier |
|---|---|---|
| `CONSISTENT` | Fields match the registry record | pass |
| `BENIGN_DRIFT` | Formatting/online-first differences only | review |
| `INCONSISTENT` | Substantive field mismatch | **blocking** |
| `FABRICATED_CANDIDATE` | DOI registered nowhere | **blocking** |
| `RETRACTED` | Registry marks the work retracted | **blocking** |
| `UNVERIFIED` | Found nowhere; verify by hand | review |
| `REGISTRY_UNREACHABLE` | Network problem; cannot certify | review (exit 2) |

## CLI

Requires [Bun](https://bun.sh).

```bash
bun src/cli.ts --bib refs.bib                 # BibTeX
bun src/cli.ts --text pasted-references.txt   # plain reference list (APA-shaped)
bun src/cli.ts --docx manuscript.docx         # extracts the References section
bun src/cli.ts --locate "title or DOI"        # find a local Zotero PDF for a work
```

If a local [Zotero](https://www.zotero.org) library exists (`~/Zotero/zotero.sqlite`, or `--zotero <path>`), entries are also matched against it (read-only) and PDF paths are reported for downstream claim-checking. Set `OPENALEX_MAILTO=you@example.org` to join the OpenAlex polite pool.

## Web app

A Cloudflare Worker serving a paste-your-bibliography page (`web/`). The browser audits one entry per request, so progress is visible and no entry is skipped.

```bash
bun run web:dev      # local preview
bun run web:deploy   # your Cloudflare account
```

## Claude Code plugin

`plugin/` contains a skill (`refguard`) and an independent `citation-context-verifier` agent implementing Chain-of-Verification claim checking: each verifier is spawned in a fresh context that never sees the manuscript, receives one claim plus the cited paper's text, and must return a verdict (`SUPPORTED` / `DRIFT` / `WRONG_PAPER` / `UNSUPPORTED`) with a quote- or page-cited rationale.

## What it does not do

RefGuard verifies that references are real and accurately described, and (via the plugin) that they are accurately characterized. It does not judge whether they are the *right* references, or find the ones a manuscript should cite but doesn't. That remains a human job.

## Attribution

RefGuard adapts an architecture with this lineage: Katie Apker's VerifyClaims pipeline (Cornell ILR, 2026) — deterministic-first ordering, citation-context checking with the DRIFT verdict, severity-tiered gates; Pedro Sant'Anna's `claude-code-my-workflow` claim-verifier template; Dhuliawala et al. 2023, *Chain-of-Verification Reduces Hallucination in Large Language Models* (arXiv 2309.11495); and Scott Cunningham's `mixtapetools` bibcheck (the field-mixing failure class and the one-narrow-agent-per-entry rationale). This implementation adds fail-closed registry semantics, fail-closed aggregation, author/DOI comparison, distinctive-token venue matching, brace-balanced BibTeX parsing, and retraction checking.

## License

MIT
