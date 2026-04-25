# Reckon — Azure FinOps health check

> Drop in an Azure cost export. Get back a defensible health-check report,
> three audience-tuned narratives, a CSV of every finding, and a
> consulting-grade slide deck — all grounded in invoice rows you can point
> at, with no LLM hallucination in the loop.

A local desktop application built for FinOps consultants who need to turn
an Azure portal "Cost analysis" export into a customer-ready review by
the end of the day, not the end of the week.

---

## What it does

You give it: one Azure cost-analysis export (`.xlsx` or `.csv`) — the
same file you can pull from the Azure portal in two clicks.

It gives you back:

- A self-contained **HTML health-check report** in three audience voices
  (Customer, Consultant, Informational), each with genuinely different
  prose.
- **CSV findings** + **CSV evidence** for downstream tools and ticket
  systems.
- A **consulting-style slide deck** with action titles, executive summary,
  and a four-section narrative arc.
- Every finding is **traceable to invoice rows** — no number on the page
  exists without a line in the data behind it.

No LLM calls. No external services. No customer data leaves the laptop.

---

## Why it exists

Most Azure FinOps reviews fall into one of two failure modes:

1. **The pretty deck that hides the maths.** Bullet points without
   evidence rows behind them, so any number can be challenged and the
   consultant has nothing to point at.
2. **The hand-rolled spreadsheet that never ships.** Engineering-quality
   analysis trapped in someone's working file, never turned into something
   a CFO will read.

Reckon closes the gap. Every finding declares which optimisation rule it
implements, every dollar reconciles to invoice rows, and every output
artefact (HTML, CSV, slide deck) comes from the same engine — so what
the consultant defends in detail and what the customer reads on a slide
are the same finding, just shaped for the audience.

---

## The opinion

Reckon is opinionated about three things, and they are non-negotiable.

**1. Pricing levers run in a fixed order.** Hybrid Benefit first,
commitments second, compute plans third. The order reflects how the
decisions compound, not the dollar value of any single line. The engine
emits findings in this sequence regardless of which has the bigger
saving.

**2. Severity is honest.** Three labels and they mean what they say:

- `confirmed` — recoverable from the invoice alone.
- `conditional` — gated on one discovery question; saving shown as a
  range, the question is the gate.
- `investigate` — worth surfacing, but action depends on context outside
  the billing data. Excluded from headline totals by validator rule.

**3. Discovery questions are part of the deliverable.** Any finding that
could impact production or requires configuration knowledge ships with
at least one discovery question. The engine never recommends action
blind.

---

## Three artefacts, three audiences

Each finding carries three narratives. They are not stylistic tweaks of
the same paragraph — the renderer applies a voice filter that strips
jargon for the customer, retains technical idiom for the consultant, and
appends the engine's working for the informational view.

| Audience | Tone | What's on the page |
|---|---|---|
| **Customer** | Sales-led, plain English | Lead with money saved, technical terms substituted ("the licence-discount programme" not "Hybrid Benefit"), severity-first stance ("Worth doing now."), no internal acronyms, no evidence tables. |
| **Consultant** | Recommendation-led, technical | SKUs, meter names, resource groups visible. Evidence rows expanded by default. Discovery questions cited. Framework rule numbers shown. |
| **Informational** | Analytical, exhaustive | Every consultant detail plus framework lineage with verbatim source guidance, evidence-row reconciliation totals, range-formula explanations, severity-aggregation notes, and discovery questions inline. |

---

## Quick start

```bash
git clone <repo>
cd reckon
npm install
npm test                    # 76 tests, all green
npm run engine:smoke        # picks up any *.xlsx in the project root
npm run electron:dev        # builds and launches the desktop app
```

The app:
1. Drop or pick an Azure cost export (`.xlsx` or `.csv`).
2. Choose audience: Customer, Consultant, Informational.
3. Click **Analyse**.
4. Preview re-renders live as you switch audience.
5. Export buttons:
   - **Save HTML report** — current audience to a single self-contained file.
   - **Save CSV findings** — `*_finops.csv` plus `*_finops_evidence.csv`.
   - **Generate slide deck** — consulting-style HTML deck.
   - **Save everything** — all three audiences, both CSVs, and the slide
     deck into one folder.

---

## What you ship to the customer

### The HTML report

Single file, no external assets, opens in any browser, lands at ~470KB.
The same HTML carries all three audiences — a body class
(`aud-customer` / `aud-consultant` / `aud-informational`) selects which
prose blocks display. The `_customer.html` you send to the customer is
visually unchanged from the others on the surface; what differs is the
voice in the narratives.

The report structure follows the McKinsey-style headline pattern: every
section title states a conclusion ("Pricing levers deliver the bulk of
the recoverable value") not a topic ("Levers"). The hero carries an
audience-shaped action title; the savings ladder shows the floor → ceiling
range; each finding shows its action, value, evidence, and discovery
questions; the report closes with the explicit limits of an invoice-only
view.

### The slide deck

Generated by `src/render/slides.ts` (or the **Generate slide deck**
button in the app). Sixteen slides in a four-section arc:

1. **Snapshot** — Cover, Executive summary, Estate snapshot.
2. **Approach** — Framework (ten principles, those invoked highlighted),
   three-lever pipeline.
3. **Actions** — One slide per top-six finding with action title,
   annualised value, customer narrative; recommended sequencing.
4. **Next steps** — Limits of the analysis, three-step plan, close.

Conservative consulting palette (white + deep navy + single muted accent),
section tracker chip on every slide, source line at the bottom of every
data slide, action titles throughout. Self-contained HTML, scroll-snap
deck, keyboard navigable. Customer narratives go through the same voice
filter as the customer-audience HTML report, so the deck and the report
read in the same voice.

### The CSVs

Two files, both stable schemas:

- `*_finops.csv` — one row per finding with id, category, rule number,
  order, title, severity, confidence, monthly/annual saving (low/high
  for ranges), effort, evidence count, evidence total, confirmation
  asks, discovery questions, and action description.
- `*_finops_evidence.csv` — one row per evidence line with finding id,
  resource id, meter, cost, and reason.

These are designed to feed Linear / Jira / Azure DevOps without further
processing.

---

## How the engine is shaped

```
src/
  engine/
    index.ts            # the orchestrator: runs all rules in framework order
    framework.ts        # the 10 optimisation principles, source of truth
    parse.ts            # XLSX/CSV → ParsedInvoice
    rates.ts            # hourly-rate lookup table for runtime derivation
    validate.ts         # cross-checks; enforces the framework invariants
    rules/              # one file per rule, 22 today
  render/
    html.ts             # audience-aware HTML report
    slides.ts           # consulting-style HTML slide deck
    csv.ts              # findings + evidence CSVs
    template.ts         # design system, fonts, reveal-on-scroll JS
    voice.ts            # render-time voice filter (humaniser + audience shape)
    escape.ts           # primitives: HTML escape, money formatting
  main/                 # Electron main process
  preload/              # IPC surface
  renderer/             # the desktop UI
  test/                 # 76 vitest tests
tools/
  fetch-rates.py        # rates table refresh helper (developer-only)
```

The engine has zero LLM calls. Every finding is the deterministic output
of a pure function over the parsed invoice. Every artefact (HTML, CSVs,
slide deck) is rendered from the same `AnalysisResult` by pure-TypeScript
renderers — no external runtimes, no shell-outs, no Python on the host.
Tests pin the framework invariants so they cannot be silently violated.

---

## Documentation

- **[Optimisation rules reference](docs/RULES.md)** — the 10 framework
  principles, the 22 implementations that operationalise them, and the
  invariants the validator enforces.
- **[Adding or updating a rule](docs/RULE_AUTHORING.md)** — the recipe.
  Includes the type contract, the testing requirements, and the
  framework-rule citation requirement.

---

## Provenance

The framework rules in `src/engine/framework.ts` originate from a recorded
conversation with a senior FinOps practitioner; the verbatim source
guidance is preserved next to each rule for audit, but the customer-facing
output never names the source — these are FinOps optimisation rules
applied to an Azure health check, full stop.

The hourly-rate table in `src/engine/rates.ts` is approximate retail list
pricing captured at a fixed date; it should be refreshed quarterly. A
future version will fetch live from the Azure retail pricing API.
`tools/fetch-rates.py` exists to make that refresh ergonomic when the
data source is wired in.

---

## Status

- 22 rules, 10 framework principles, 76 passing tests.
- Validated end-to-end against a real Azure cost-export invoice
  (~5,000 rows, 88 findings, validation passing).
- Electron desktop app on macOS Apple Silicon (primary), with
  electron-builder configured for Windows (NSIS) and Linux (AppImage).
- Self-contained: every artefact (report, CSVs, slide deck) renders in
  pure TypeScript inside the Electron main process. No Python, no
  external runtimes, no host dependencies beyond the OS.
- GitHub Actions workflow builds DMG + EXE on every tag push and PR
  (`.github/workflows/build.yml`). Builds are unsigned for now; signing
  certificates land later.

---

## License

Internal Altra Cloud tooling. Not for redistribution.
