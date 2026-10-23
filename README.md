# Memory Bench

A real, isolated comparison of omp Local markdown, Hindsight, Mnemopi, Sharpshooter, Mastra Observational Memory, and Mem0 OSS. Includes SQLite FTS5 BM25 and no-memory controls. Chronos remains explicitly unavailable until an official runnable implementation is located; no paper score is used as measured data.

Read [BENCHMARK.md](BENCHMARK.md) for the research question, exact protocol, metrics, validity limits, fairness boundaries, and acceptance criteria.

## Prerequisites

- Bun and uv; Python 3.13 is pinned in `.python-version`.
- Docker with permission to start a dedicated Hindsight container.
- Existing omp authentication with the configured GPT models `openai-codex/gpt-6-luna` and `openai-codex/gpt-6.1-sol`.
- Enough local memory/disk for multilingual E5-large ONNX, local vector stores, PostgreSQL, and Hindsight's CPU reranker.

No provider key is copied into benchmark artifacts. The gateway reuses omp's native authenticated model client in memory and binds only to loopback. Existing omp memories/settings and the user's Hindsight instance on port 8888 are not modified.

## Install

```bash
bun install --frozen-lockfile
uv sync --frozen
```

`onnxruntime-node` and `protobufjs` are trusted dependency installers in `package.json`; their native installation is required by the genuine packages.

## Run

Start the shared embedding service in a terminal:

```bash
.venv/bin/python python/worker.py --serve-embeddings \
  --host 127.0.0.1 --port 9324 \
  --cache-dir .cache/fastembed \
  --model intfloat/multilingual-e5-large --dimensions 1024
```

The model download can be large. Model download/load is outside retrieval latency; the ready line and `/health` identify the actual loaded model. An existing cache can be reused with `--cache-dir` and `BENCH_EMBEDDING_CACHE`.

In another terminal:

```bash
# Integration only; do not rank systems using this small workload.
bun run bench --profile smoke --skip-qa

# Complete standard matrix: 4 corpora, 192 sessions, 392 facts, 96 queries,
# 2 budgets, 2 retrieval passes, and QA at the largest budget.
bun run bench --profile standard
```

Useful flags:

```bash
bun run bench --help
bun run bench --profile standard --seed 20261018 --run-id my-independent-run
bun run bench --profile smoke --backends local,sharpshooter --skip-qa

# Reuse exact source timestamps, facts, and questions for an independent rerun.
bun run bench --profile standard --dataset runs/EXISTING/dataset.json \
  --backends local --run-id my-frozen-local-rerun
```

Each run has a new directory. Existing evidence is not overwritten. Run only one benchmark process at a time: it owns the loopback GPT gateway on port 9323 and its dedicated Hindsight API on 8891. The embedding service is shared on 9324. A normal adapter shutdown closes its isolated handles/container; the manually started embedding service can be stopped with Ctrl-C.

Local catch-up repeats native startup batches until every eligible historical session is processed;
one startup is not treated as a complete bulk import. Diagnostics distinguish pending sessions from
successful extractions with no output. The corrected comparison preserves original measurements and
records per-backend source-run provenance; see [BENCHMARK.md](BENCHMARK.md).

## Recall ablation and scale study

Keep the embedding service running and reuse a completed native Hindsight/Mem0 build:

```bash
# Four-query integration check; never use its timings as a ranking.
bun run study --id my-recall-smoke --source runs/coding-memory-standard-20261018 --smoke

# Frozen-store ablations plus 10x chronological, same-bank growth.
bun run study --id my-recall-study --source runs/coding-memory-standard-20261018 --factor 10
```

Smoke mode excludes scale ingestion; it cannot be combined with the `scale` variant.

The study compares Hindsight `mid`, `low`, native RRF without cross-encoding,
same-model CPU length-bucket batching, and a multilingual cross-encoder. Mem0 uses
its native dense/BM25 hybrid retrieval without reranking. All variants use 4,096
output tokens, three timing passes, and the common reader/judge. `--variants`
accepts `base,low,rrf,bucket,multilingual,scale`; include `base` to audit candidate
identity for reranker comparisons. No GPU result is implied by the CPU experiment.

The source stores are copied, never reused in place. PostgreSQL library symlinks
retain their original targets. The scale variant appends new sessions to the same
four banks; it does not inflate size by creating unrelated retrieval scopes.
At factor 10, each bank has 480 sessions, with 96 unchanged anchor questions and
144 new questions. Actual extracted memory counts can differ by engine.

Normal latency requests and instrumented requests are separate. Native profiles
record phase timers and candidate counts; nested/parallel phase percentiles must
not be added. Candidate-ID equality is checked rather than assumed. A changed
candidate pool is not a controlled reranker-only comparison.

Open any study variant in the dashboard for quality/latency, same-bank scale,
actual memory counts, candidate-set checks, native stage charts, and raw profile
downloads. Scale metrics include coverage, QA, p50 and p95 for the original and
new-question cohorts separately; use the original cohort for paired growth
comparisons. Both continuous axes support independent linear/log10 selection.
Study-level results are saved in `runs/<study-id>/study.json`; each variant keeps
its complete normal run artifacts in `runs/<study-id>-<variant>/`.
Partial failures remain visible and cannot be presented as completed evidence.

Failed native stores are not accepted as completed frozen sources. For an explicit
Hindsight recovery, `runExperiment` accepts a `HindsightResumeCheckpoint` with
verified retained-document IDs and the original native worker identity. Recovery
copies the store, avoids re-extracting acknowledged documents, and waits for native
consolidation even when no new documents remain in a bank. Set
`hindsight.consolidationTimeoutMs` for the workload; a longer readiness allowance
does not change the memory algorithm. Previous failed attempts are preserved, and
resumed build timing does not include their work.

## Visualize

```bash
bun run build
bun run serve
```

Open **http://127.0.0.1:9321**. The dashboard reads actual reports, including running and failed runs. Use the run selector to distinguish smoke/integration evidence from the standard quality experiment.

Available views: backend statuses and modes, coverage/p95 Pareto plot, category heatmap, first-scoped-query versus repeated-warm latency CDF and histogram, coverage versus token budget, QA correctness, ingestion/storage/limited-scope RSS/usage, and per-question source/context/answer/judge drilldown. JSON and CSV exports contain the real records, including query novelty, not demo points.

Heatmap color encodes literal coverage, not request counts. QA bars encode scalar answer accuracy;
counts and provenance remain in their tooltips/tables. Empty scopes remain unavailable rather than
being rendered as 0%.

**Axis scales.** Each chart starts linear. Select X and Y independently in the coverage/p95
scatter, coverage/budget curve, and latency CDF. QA accuracy and histogram counts expose a Y
selector only: their X axes are categories or fixed equal-width bins, not continuous log axes.
Choices are independent per chart; Reset filters does not reset scales. For this report, log X
and linear Y is a useful Pareto view: it separates latency orders of magnitude while keeping
zero-coverage controls visible.

**Logarithmic values.** Log10 axes require strictly positive coordinates. Non-positive values are
omitted only from the plot, never clamped to an epsilon; original tables, statistics and exports
are unchanged. Scatter and budget panels list unplotted points with reasons. A positive point
whose CI touches zero remains visible, but its undrawable CI is omitted and counted; original
intervals remain in tooltips and tables. CDFs retain original ranks and denominators when skipping
non-positive latency, and omit the synthetic zero origin on log axes. Logarithmic bars use the
positive axis minimum as their native ECharts `startValue`, so count-one and constant-100% bars
remain visible without changing their values.

**Language.** The Language selector switches between English and Simplified Chinese, including
chart labels, tooltips, status/mode descriptions, accessibility labels, numbers and dates.
It preserves active filters, selected evidence and axis scales. Initial language follows the
browser (`zh*` selects Simplified Chinese; otherwise English); language and scale choices apply
to the current page and reset on reload. Questions, facts, context, model answers, source
transcripts, errors, diagnostics, report-supplied notes and exports retain their original content.
UI translations use `vue-i18n` with literal English source keys and `web/locales/zh-CN.ts`.

## Artifacts

```text
runs/<run-id>/
  dataset.json       # Exact corpus, held-out questions, gold and provenance
  report.json        # Complete dashboard input, config, diagnostics and aggregates
  retrieval.jsonl    # Every real query/budget/pass result, including errors
  answers.jsonl      # Reader answers and independent judge explanations, when enabled
  profiles.jsonl     # Optional separate diagnostic requests with native traces
  usage.jsonl        # Provider-reported model usage by backend/purpose
  results.csv        # Long-form per-request export
  events.jsonl       # Actual ingestion/evaluation events
  stores/            # Isolated engine state; contains synthetic data only
```

Generated runs, engine stores, model caches, dependencies and frontend bundles are
excluded from Git. The measured results below are documented observations, not
bundled run artifacts. A fresh checkout must generate a run or supply an existing
local `runs/` directory before the dashboard can display reports.

The standard matrix has **3,072 retrieval rows** and **768 QA rows** when all eight executable systems succeed. Unavailable Chronos is a status row, not a fake score. A failed build stays failed and cannot be silently interpreted as a valid comparison.

## Checks

```bash
bun test
bun run build
```

The permanent tests target observable metric boundaries: exact token caps including multibyte text, identifier-boundary false positives, wrong-state/foreign evidence separation, cluster confidence intervals that do not become artificially narrower from repeated cached calls, small-sample percentile interpolation, and filtered warm latency that excludes first-query/cache-miss timings and failed requests. Actual engine ingestion/retrieval and real-browser verification are separate smoke/experiment evidence, not replaced by unit tests.

## Interpretation

- Primary score: mean per-question **literal fact coverage**, not universal semantic recall.
- Static injection latency and dynamic semantic-retrieval latency are labelled separately.
- Every memory surface returned to the reader consumes the same exact budget.
- Wrong-state exposure is not necessarily a wrong answer; tracked-fact precision is not a hallucination rate.
- Scope leakage is measured under explicit per-workspace scopes, sometimes separate stores. A zero does not establish native isolation in a shared user bank.
- Peak runner RSS excludes Python, Docker/PostgreSQL and shared embeddings. Do not rank total engine RAM with that field.
- Estimated USD is provider metadata, not a verified invoice or subscription marginal cost.
- This is a controlled bilingual coding-memory experiment, not a LongMemEval/LoCoMo reproduction or confirmation of published vendor scores.
- Prefer a measured Pareto tradeoff over an arbitrary single weighted score. The final choice depends on tolerated missed facts, p95, ingest delay, and deployment complexity.

## Measured standard result

Open the completed corrected comparison at
**http://127.0.0.1:9321/?run=coding-memory-corrected-20261018**.

The effective comparison contains 3,072 retrieval records, 768 scored QA records and 3,198
provider-reported model-call records. All eight executable methods completed. There are no retrieval
errors or unresolved evaluation-format errors in this corrected comparison.

Coverage at both token caps averages the 88 answerable questions across both passes. QA and latency
below use the 4,096-token cap; QA includes all 96 questions, including eight abstentions.
First-scoped-query p95 has 42 samples per method at that budget; repeated-warm p95 has 96. Both use
the same linear-interpolated quantile. Times exclude the common reader and judge.

| Method | Context mode | Coverage at 1,024 | Coverage at 4,096 | QA at 4,096 | First-scoped p95 (ms) | Warm p95 (ms) | Build-to-readable (s) |
|---|---|---:|---:|---:|---:|---:|---:|
| Local markdown | Automatic summary only | 2.27% | 2.27% | 10.42% | 1.00 | 0.90 | 794.57 |
| Hindsight | Dynamic retrieval | 50.00% | 80.11% | 62.50% | 2,160.11 | 2,208.67 | 2,908.05 |
| Mnemopi | Dynamic retrieval | 88.64% | 88.64% | 78.13% | 174.39 | 18.28 | 467.67 |
| Sharpshooter | Automatic injection | 25.00% | 25.00% | 31.25% | 0.74 | 0.60 | 2,395.45 |
| Mem0 OSS | Dynamic retrieval | 100.00% | 100.00% | 93.75% | 172.83 | 167.52 | 1,697.96 |
| Mastra OM | Precomputed observations | 81.82% | 97.73% | 94.79% | 0.57 | 0.49 | 392.61 |
| SQLite FTS5 BM25 control | Raw-history lexical retrieval | 68.18% | 95.45% | 94.79% | 4.53 | 4.20 | 0.023 |
| No-memory control | Empty context | 0.00% | 0.00% | 8.33% | <0.01 | <0.01 | <0.001 |

Chronos has no measured row because no official runnable implementation was located. Its published
score is not substituted. Sub-millisecond injection times are context-read overhead, not equivalent
dynamic semantic search or end-to-end answer time.

### Interpretation of this run

- Among the four native omp choices, Mnemopi has the strongest observed automatic fact-lookup
  tradeoff here. Hindsight is not the best measured option in this configuration.
- Mem0 has the highest observed literal coverage, but six answers are still incorrect. A returned
  identifier is not sufficient proof of a correct answer.
- Mastra OM is a strong low-query-overhead candidate with nearly complete coverage. Its QA result
  differs from Mem0 by only one question; this is not evidence of a statistically established
  overall QA advantage.
- The simple BM25 control is competitive on this deliberately identifier-heavy workload. It is a
  retrieval reference, not a complete drop-in omp memory backend; complex memory pipelines are not
  automatically superior.
- Local's score is limited to automatic summary injection. All 48 eligible histories per workspace
  were processed after six native startup passes, but `MEMORY.md`/skills tool reads remain outside
  this experiment. The score does not describe Local's full agent-assisted capability.
- Bootstrap intervals use four workspace clusters and one memory build each. Mem0's observed 100%
  does not establish perfect recall on new data, larger stores, or another writer build.

### Correction provenance

- Initial full measurement: `runs/coding-memory-standard-20261018/`.
- Fully settled Local rerun: `runs/coding-memory-local-settled-20261018/`, using the exact original
  dataset, not regenerated timestamps.
- One Local reader returned plain `UNKNOWN` instead of JSON. Its original error remains intact;
  `evaluation-replay.json` records a real reader/judge replay with required structured function output.
  No incorrect answer was retried, and this format repair did not increase QA accuracy.
- Published comparison: `runs/coding-memory-corrected-20261018/`. Its
  `environment.measurementSources` and `environment.evaluationReplaySource` identify every source.
  Original reports are not overwritten. Engine stores remain in their source runs rather than
  being copied into the composite report directory.

The dashboard labels this as a corrected comparison, not one uninterrupted run. Raw JSONL, JSON,
CSV, contexts, source transcripts, gold facts, judging explanations, configuration and usage remain
available for inspection.

To execute a new independent full comparison against the exact same corpus with the corrected
implementation:

```bash
bun run bench --profile standard \
  --dataset runs/coding-memory-standard-20261018/dataset.json \
  --run-id my-full-frozen-rerun
```

GPT extraction and judging are stochastic; this reproduces the protocol and inputs, not a guarantee
of byte-identical scores.

## Measured ablation and growth study

Completed study: **http://127.0.0.1:9322/?run=recall-study-20261021-scale-hindsight**.
The canonical comparison is `runs/recall-study-20261021/study.json`; `analysis.json`
records cohort results, native readiness, supporting audits and measurement provenance.

The growth workload contains 1,920 source sessions, 3,920 labeled facts and
1,784,918 `o200k_base` source tokens. It grows each of the same four banks from
48 to 480 sessions. It does not substitute more isolated small banks.

### Paired growth results

All rows below use the unchanged 96 anchor questions, including eight abstention
questions for QA. Coverage averages the 88 answerable questions. Each latency
row has 192 successful repeated-warm samples at the 4,096-token output budget.

| Engine | Sessions per bank | Anchor coverage | Anchor QA | Anchor p50 (ms) | Anchor p95 (ms) |
|---|---:|---:|---:|---:|---:|
| Mem0 | 48 | 100.00% | 95.83% (92/96) | 82.01 | 155.37 |
| Mem0 | 480 | 60.80% | 55.21% (53/96) | 114.78 | 149.97 |
| Hindsight, mid CPU | 48 | 80.11% | 62.50% (60/96) | 1,626.29 | 2,101.45 |
| Hindsight, mid CPU | 480 | 34.66% | 29.17% (28/96) | 2,449.38 | 2,937.34 |

Mem0 still leads this measured medium-scale comparison, but both engines lose
substantial anchor quality. Small-bank near-perfect coverage does not survive
growth. Mem0's p50 rises despite its similar p95; the latter alone does not prove
unchanged latency. Actual memory counts grow from 385 to 2,177 for Mem0 and from
790 to 8,612 for Hindsight; native memory units are not interchangeable.

The added 144 questions have a different difficulty mix. The dashboard and exports
include their separate metrics and all-240-question metrics, but neither population
is substituted for the paired anchor comparison.

### Frozen small-bank ablations

| Hindsight variant | Coverage | QA | Warm p95 (ms) |
|---|---:|---:|---:|
| Low compute budget | 80.11% | 66.67% | 2,113.25 |
| No cross-encoder, native RRF | 72.73% | 58.33% | 141.32 |
| Same model, CPU length-bucket batching | 80.11% | 66.67% | 2,050.81 |
| Multilingual cross-encoder | 80.11% | 62.50% | 3,639.05 |

The three reranker ablations match baseline candidate IDs on 96/96 queries.
Low budget and bucket batching produce byte-identical QA contexts to baseline on
96/96 queries: their four additional correct answers are reader/judge variation,
not evidence of improved retrieval. Low budget changes the mean merged pool only
from 197.50 to 197.43 candidates. Bucket batching's 2.4% p95 reduction is not a
demonstration of robust acceleration from this single build.

Separate native profiles attribute more than 92% of Hindsight wall time to CPU
cross-encoding at both sizes. Medium-scale Hindsight merges 1,372.08 candidates on
average but reranks 300; this limits reranking work without proving where every
missing fact was lost. Mem0 uses dense/BM25 fusion without that neural reranking
stage. Multilingual reranking changes architecture as well as training languages
and does not improve aggregate coverage in this experiment. No GPU run is claimed.

The native Mem0 audit confirms that all 385 original records remain active with
unchanged text. All 104 required anchor query–fact pairs remain stored. Of 47 pairs
missing from final contexts, 43 are absent from the query's dense candidate pool
and four enter that pool but not the final context. BM25 candidate IDs were not
captured; absence from the dense pool is not proof of absence from every hybrid
candidate branch.

### Completion and recovery provenance

The effective eight-row study contains 3,168 normal retrievals, 1,056 separate
profiles and 1,056 QA records, with no retrieval or evaluation errors. All four
medium Hindsight banks contain 480 documents and have zero pending/failed native
operations and consolidation inputs before retrieval.

Two failed Hindsight attempts remain intact. The completed recovery preserves
480 acknowledged documents in the first bank without re-extracting them, appends
the remaining 1,296 documents, and lets the native worker finish consolidation.
One bank required approximately 61 minutes of final consolidation, exceeding the
old 30-minute allowance. Resumed build timing excludes previous work and is not
presented as a fresh full-build comparison.

This is one controlled synthetic workload with four workspace clusters, one
memory build per engine, sequential CPU measurements and two size points.
It is not evidence of a universal winner, million-memory scalability, GPU
performance or concurrent throughput.

## Verification evidence

- The completed study's browser CSV contains 8 rows and 21 columns; all 168 cells
  matched the canonical study. Independent Python calculations reconciled 96
  overall/anchor/new-cohort coverage, QA and percentile values. The downloaded
  JSON matched the complete canonical study.
- The scaled Hindsight raw-profile download matched its source byte-for-byte:
  240 records, 581,124,112 bytes, SHA-256
  `a50be1c450a0e21557af2b63cd58173cd97f6d7a03964fbb25ef1f4d1633578d`.
- The completed study was exercised in Chromium: eight result rows, independent
  axes, anchor latency and new-question QA selections, missing-cohort omissions,
  native stage timings, English/Chinese labels and real downloads. Its page error
  log was empty and document width remained 636 pixels at a 636-pixel viewport.
  `runs/recall-study-20261021/{coverage,latency,native-stages}.png` preserve the
  settled rendered charts.

- The metric suite passed: 9 tests and 52 assertions, including logarithmic bounds, non-positive
  coordinates and unchanged CDF denominators. The latest dashboard source passed `vue-tsc --noEmit`
  and the Vite production build.
- The corrected report passed 27 raw-data reconciliation checks, including 396 filtered
  backend/category/language/budget points. An independent Python `csv.DictReader` verified all
  3,072 exported rows and all 23 columns against the report.
- Managed Chromium verified the actual recall/QA charts, coverage-encoded heatmap, budget curves,
  first-versus-warm samples, filters, unavailable QA at 1,024 tokens, source transcript expansion,
  and a real incorrect answer with fully retrieved evidence. The page error log was empty.
- Managed Chromium also verified independent X/Y scales, zero-coverage omissions and CI notices,
  a visible constant-100% QA bar on a log axis, zero-count histogram tooltips, empty selections,
  English/Chinese switching, retained filters/evidence/scales, and localized chart accessibility.
  At 636 CSS pixels, document width remained 636 pixels with no document-level horizontal overflow.
  JSON and CSV export SHA-256 hashes were identical across language changes.
- The actual browser CSV download was 15,631,370 bytes and matched the published export:
  SHA-256 `fa0a88f219d5cb18978b1630bec62e003d58c7c90004a324f5dc87daa7975822`.
- The production build retains a non-fatal large-chunk warning for approximately 943 kB of minified
  JavaScript (313 kB gzip); it is not suppressed or reported as a failed build.
