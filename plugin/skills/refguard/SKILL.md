---
name: refguard
description: Citation and reference verification for academic manuscripts. Deterministic bibliography audit against OpenAlex (fabricated DOIs, mixed-up fields, wrong authors/years/venues, retracted papers, fail-closed verdicts) plus independent claim-vs-source verification via fresh-context agents. USE WHEN verify references, check citations, audit bibliography, did I hallucinate citations, fake references, are these papers real, retraction check, does the cited paper actually say that, citation-context check, pre-submission citation gate.
---

# RefGuard

Two distinct failure classes, two checks. The **bibliography audit** asks: is every entry an accurate description of a real, non-retracted paper? The **claim check** asks: does each cited paper actually say what the manuscript claims it says?

## Bibliography audit (deterministic — run this first)

```bash
bun <plugin-root>/../../src/cli.ts --bib refs.bib --out report.json
# or --text pasted-refs.txt | --docx manuscript.docx
# optional: --zotero <path-to-zotero.sqlite> to also match against a local Zotero library
```

If the CLI is installed as a package, `refguard --bib refs.bib` works directly. Exit codes: 0 = all pass, 1 = blocking findings (INCONSISTENT / FABRICATED_CANDIDATE / RETRACTED), 2 = cannot certify (registry unreachable — never soften this into a pass). Present the severity-tiered output to the author; never edit their bibliography file yourself.

## Claim check (agentic)

Independence contract: verifier agents NEVER receive the manuscript, sibling claims, other verdicts, or your expectations — one claim, one substrate, the metadata, nothing else. That is the entire mechanism (Chain-of-Verification, Dhuliawala et al. 2023).

1. **Extract claims** (you may see the manuscript here — the output is a list, not a verdict). Split into atomic propositions about cited papers, mechanically: do not evaluate, do not paraphrase beyond isolation.
2. **Locate the cited paper's text** per claim: local PDF (the audit report's `local_pdf` field when a Zotero library was matched), open-access full text via the DOI, or the user's own files. No text found → verdict `UNVERIFIABLE_NO_SUBSTRATE`, route to the author. Never pass by default.
3. **Dispatch one `citation-context-verifier` agent per claim** (parallel), passing claim + substrate + metadata.
4. **Aggregate fail-closed.** BLOCKING = WRONG_PAPER, UNSUPPORTED. REVIEW = DRIFT, UNVERIFIABLE_NO_SUBSTRATE, and any verdict string not in the known set (malformed output is a finding, not a pass). PASSING = SUPPORTED with a concrete quote/page rationale; a SUPPORTED verdict with a vague rationale gets one redispatch, then REVIEW.

## Gotchas

- OpenAlex's year is often the online-first year; ±1 is BENIGN_DRIFT by design, only ±2 blocks.
- A DOI missing from OpenAlex is not fabrication by itself (DataCite, books); the audit cross-checks doi.org handles before saying FABRICATED_CANDIDATE.
- WRONG_PAPER and UNSUPPORTED overlap at the boundary; both are blocking, so verifier disagreement between them is harmless.
- Set `OPENALEX_MAILTO` in the environment to join the OpenAlex polite pool.

## Attribution

Adapted from Katie Apker's VerifyClaims pipeline, Pedro Sant'Anna's claude-code-my-workflow, Dhuliawala et al. 2023 (arXiv 2309.11495), and Scott Cunningham's mixtapetools bibcheck.
