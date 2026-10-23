# Memory benchmark protocol

## Research question

Under a fixed GPT writer, a fixed multilingual embedding service, identical chronological source conversations, and identical memory token budgets, which available memory system returns the required coding facts most reliably and quickly?

This experiment tests a bounded claim about automatic memory context for a bilingual coding assistant. It does **not** estimate a universal memory-system ranking. In particular, a static startup summary is not a semantic search engine, and a paper result from a different dataset/model is not a measurement in this experiment.

## Systems and implementation boundary

| System | Actual implementation | Measured surface |
|---|---|---|
| omp Local markdown | `@oh-my-pi/pi-coding-agent@18.11.0`, genuine historical-session extraction and consolidation | Native `memory_summary.md` / `learned.md` automatic developer injection |
| Sharpshooter | Same pinned omp package, native prompt extraction and consolidation | Native architecture/product/style automatic injection |
| Mnemopi | `@oh-my-pi/pi-mnemopi@18.11.0` | Native host `recallEnhanced` path, `includeFacts=true`, recall limit 8; optional graph features remain disabled |
| Hindsight | `ghcr.io/vectorize-io/hindsight:0.9.2`, isolated embedded PostgreSQL | Native recall with compute budget fixed at `mid`; numeric `max_tokens` varies |
| Mastra Observational Memory | `@mastra/core@1.78.0`, `@mastra/memory@1.38.0`, `@mastra/libsql@1.26.2` | Actual Observer/Reflector observations plus unobserved recent raw messages |
| Mem0 OSS | `mem0ai==2.2.1`, isolated Qdrant and SQLite | Real LLM extraction/update, then native dense/BM25 hybrid retrieval without reranking |
| BM25 reference | Bun SQLite FTS5 built-in BM25, trigram tokenizer | Raw conversation-session retrieval; a control, not Mnemopi |
| No-memory reference | Empty supplied context | Negative control for accidental answer leakage |
| Chronos | Official paper, no located author-released executable implementation | Explicitly unavailable; no replica, copied paper score, or synthetic result |

The local backend can also read `MEMORY.md` and skills on demand in a full coding-agent session. Those extra tool actions are **outside** this automatic-context experiment and are listed in diagnostics rather than silently added as an invented retrieval implementation. The result must not be described as the total capacity of Local markdown.

## Standard workload

- Four isolated Atlas workspaces, two primarily English and two primarily Chinese.
- 48 chronological sessions per workspace, 192 sessions total.
- 392 extractive gold facts; the identifiers are opaque, unique, and generated deterministically from seed `20261018`.
- 96 held-out questions, including direct lookup, paraphrase, cross-language lookup, multi-hop, knowledge updates, historical values, short corrections, rejected decisions, scope isolation, abstention, and long-tail facts.
- Approximately 43k `o200k_base` tokens per workspace. Exact counts are recorded in `dataset.provenance.corpusTokens`; no estimate is substituted for the actual count.
- Realistic signal: regression guards, failover routes, explicit operational reversals, and short follow-up corrections.
- Disposable diagnostic transcripts supply distractors. This is an intentionally controlled coding workload, not a representative sample of all real conversations.
- Source timestamps are 6–9 days before the run. This is a historical replay satisfying Local markdown's native idle/age policy, not evidence that it stores fresh information immediately.

### Gold separation

Adapters ingest only `Corpus`: workspace identifiers, dated documents, roles, and source text. They never receive questions, answers, fact IDs, required-source labels, `has_answer` markers, or score annotations. Retrieval receives only `RecallQuery`, not `EvalQuery`.

Gold values appear in the source conversations because they are the facts to remember. Gold **membership labels** do not. The held-out question itself is never retained. Query-time memory writes are disabled by calling retrieval APIs directly against settled stores. The common answer model has no conversation history or tools beyond supplied memory.

### Why literal fact coverage

For coding memory, exact commands, route names, and opaque operational identifiers are often the user-visible contract. Unique literal values give deterministic, auditable evidence coverage without using the same LLM both to invent and to grade the facts. Identifier boundaries are enforced: `prefix-v42-suffix` is not evidence for `v42`.

This metric does not measure every semantically equivalent paraphrase or general knowledge. The dashboard names it **literal fact coverage**, not general semantic recall. Independent GPT QA judging adds a separate check for role, polarity and temporal correctness.

## Experiment matrix

For every executable system:

1. Construct a new isolated store from all chronological source sessions.
2. Wait for the actual engine's write/extraction/observation work to settle.
3. Freeze the store for retrieval; do not retain evaluation questions.
4. Retrieve all 96 questions at 1,024 and 4,096 memory tokens.
5. Execute two passes in seeded shuffled order: a first query/budget pass and a repeated warm pass.
6. Run the same GPT reader for every question at the largest token budget, using the **actual warm-pass context**.
7. Evaluate the answer with an independent GPT judge and deterministic source-value checks.
8. Save raw requests' results, contexts, gold evidence, answer/judge records, usage, configuration, versions, and aggregates.
9. Render only those persisted records in the dashboard and verify exports against them.

With eight executable systems this yields 3,072 retrieval requests and 768 common-reader answers. Chronos contributes an unavailable status row, never a fabricated zero or paper-derived result. The smoke profile is a much smaller integration workload and must never be interpreted as a quality ranking.

Two timing passes are **not** two independent memory builds. Extraction/consolidation is stochastic, and this run has one build per system/workspace. Confidence intervals therefore describe corpus variation conditional on those built memories, not run-to-run writer variance. A user can repeat the whole experiment with another seed/run ID; results must remain separate rather than pooled as independent timing repetitions.

### Native Local catch-up and corrected measurements

The native `runningConcurrencyCap` also bounds the number of jobs claimed by one startup task. A
completed startup therefore does not imply that every eligible historical session has been processed.
The adapter repeats the genuine startup task until all eligible session jobs are `done`, preserving
native concurrency, prompts, idle/age rules and consolidation. It fails on errors or no progress
instead of silently scoring a partially processed history. Diagnostics separate completed, pending
and successfully processed no-output sessions.

The initial standard run exposed this issue: only 8 of 48 eligible sessions per workspace were
processed for Local. Its Local score is not a settled-history result. The corrected Local experiment
loads the original `dataset.json` without changing timestamps, facts or questions. A corrected
comparison can retain the seven unaffected methods' original measurements and replace only Local,
with an explicit per-backend source-run map, measurement window and correction notice. Original
artifacts remain intact; the combined report is not labelled as one uninterrupted run.

### Evaluation-output contract

The reader and independent judge use typed answer schemas. Future executions enforce them with
provider-native required structured function output rather than relying only on JSON instructions.
The completed initial run used JSON response mode; one Local evaluation returned plain `UNKNOWN`.
Only that format failure was explicitly replayed against the unchanged question and frozen context.
Its original failure and the real replay calls remain in `evaluation-replay.json`. This is not an
automatic retry policy, and incorrect scored answers were not retried. The repair did not increase
QA accuracy. The corrected comparison records the replay artifact in its environment metadata.


### Frozen-store causal probes and same-bank growth

`bun run study` extends the standard comparison without rebuilding its original
memories. Independent writable copies preserve the source state, scope IDs,
timestamps, extracted text, vectors and relative database-library symlinks.
Every variant uses a 4,096-token output budget, three shuffled normal timing
passes, and a separate diagnostic request per query. QA uses the actual first
warm-pass context. Profiles never enter the normal latency aggregates.

The native Hindsight settings vary one retrieval configuration at a time:
`mid` versus `low`; cross-encoding versus RRF; unchanged
`cross-encoder/ms-marco-MiniLM-L-6-v2` with CPU length-bucket batching; and
`cross-encoder/mmarco-mMiniLMv2-L12-H384-v1` for multilingual cross-encoding.
The multilingual model differs in architecture as well as training languages,
so its result is not a pure causal estimate of language support. Candidate IDs
from separate traces must match before interpreting a reranker comparison as
same-candidate. Native traces include overlapping/nested phases; their
percentiles are not additive.

Mem0 instrumentation wraps the actual embedding, dense search, BM25 search and
entity-boost calls only during the separate profiling request. It does not replace
the native ranker. Its internal candidate limit can cover an entire small bank;
the scaling study records actual candidate and vector counts to test that effect.

At factor 10, 432 new sessions are appended chronologically to each original
48-session bank. Source-only subsystem qualifiers and independently seeded
opaque identifiers avoid accidental collisions. Original documents, facts and
96 anchor questions remain unchanged; 144 held-out new questions are sampled
across the additional workload. The dashboard separates anchor and new-question
coverage, QA, p50 and p95, and reports actual extracted memories per bank. Paired
growth comparisons use the unchanged anchor cohort; the combined 240-question
latency has a different query mix from the 96-question baseline. Increasing
isolated bank count alone would not test a larger retrieval search space.

This remains a synthetic workload and one native memory build per system, with
CPU inference, sequential variants and finite warm repetitions. It is not a
million-memory stress test, a concurrent throughput test, independent-build
replication, or a GPU comparison. Failed variants, incomplete QA and candidate
mismatches must remain visible. Smoke studies validate execution only.

### Interrupted native ingestion

An interrupted store is not a completed frozen source. Explicit programmatic
recovery uses `HindsightResumeCheckpoint`, containing the source run, native
worker identity and document IDs verified against the native database and
successful retain acknowledgments. Only a new store copy is resumed. Remaining
documents are ingested, and pending consolidation must drain even when a bank
has no new documents to write. The native worker recovers its own interrupted
operation; the harness does not rewrite operation statuses.

Hindsight requests use explicit `AbortSignal` deadlines with Bun's competing
socket-idle timer disabled. A per-run `consolidationTimeoutMs` changes only the
readiness allowance, not consolidation prompts, extraction or retrieval settings.
Failed attempts remain available, and resumed build time excludes earlier work.
A composite study identifies the measurement run of every row rather than
claiming one uninterrupted execution.


## Controls and fixed variables

- Writer: authenticated `openai-codex/gpt-6-luna`.
- Common reader: the same model; it sees only the current question, workspace, date and capped context.
- Independent answer judge: `openai-codex/gpt-6.1-sol`; backend names and latency are withheld.
- Embeddings: one shared local CPU FastEmbed `intfloat/multilingual-e5-large` model, 1,024 dimensions. The gateway applies `passage:` during ingestion and `query:` during recall unless the input already has a prefix.
- Hindsight retains its actual local cross-encoder reranker. This is recorded; the common embedding constraint does not claim every engine has identical internal algorithms.
- Token accounting: `o200k_base` for **all** memory context, including static injection, observations, raw messages and separators. Provider-billed token usage is recorded separately.
- Native ranking is preserved. The harness clips ordered output; it does not oracle-select relevant facts or rerank using gold labels.
- No harness retrieval cache. Native caches stay at their recorded implementation settings.
- Retrieval concurrency is one to avoid turning response time into an unlabelled load test. Reader/judge concurrency is four after retrieval.
- Existing omp settings, user sessions and the user's Hindsight bank on port 8888 are not modified. Benchmark services bind to loopback; Hindsight uses a dedicated container and database.

All deviations, forced-settling operations, limits, source IDs actually supplied by engines, and missing instrumentation are exposed in per-backend diagnostics. Generated summaries do not receive fabricated source provenance.

## Metrics and denominators

Let `G(q)` be the required fact IDs, and `D(q)` the tracked facts whose exact unique values occur in the capped memory context.

- **Literal fact coverage**: `|G(q) ∩ D(q)| / |G(q)|`, averaged across answerable questions and actual passes. Abstention questions have no gold retrieval location and are excluded from this denominator.
- **Complete evidence rate**: fraction of answerable questions with all required values returned; multi-hop questions require every constituent fact.
- **Tracked-fact precision**: `|G(q) ∩ D(q)| / |D(q)|` where defined. The denominator is tracked facts, not all natural-language assertions. This is not a hallucination rate.
- **Wrong-state exposure**: an incompatible old/current value occurs anywhere in context. Even correctly labelled obsolete values count as exposure; final-answer correctness is measured separately.
- **Scope leakage**: any tracked fact from another workspace is returned. Adapters use explicit per-workspace scopes, including separate agent directories/databases where required. Zero leakage validates this experiment's isolation, not native policy in a shared user bank or authentication/authorization security.
- **QA accuracy**: the blind judge accepts the answer, all requested values are present in both the memory and answer, no forbidden/foreign answer is given, and abstention state is correct.
- **Abstention behavior**: inspect unanswerable-query answer records and accuracy; non-empty context alone is not a false factual answer.
- **Warm p50 / p95 retrieval latency**: monotonic wall-clock time around the full adapter call and common context packing, including query embedding, reranking, service/network/worker hops and any query-time LLM work. Answer/judge latency is excluded. Every panel uses the same shared linear-interpolated quantile, with zero-based position `(n - 1) * p`; filtered Pareto/budget points still use only successful repeated warm rows.
- **First scoped-query latency**: the first occurrence of an exact query within its workspace is tagged independently of token-budget/pass order. Query/budget pairs are shuffled together, so first occurrences span both budgets. It is not a guaranteed native-cache miss: an engine may share an embedding cache across workspaces. The dashboard switches between these samples and repeated warm passes. This is not process-cold, OS-cache-cold, or model-download time; no p99 claim is made.
- **Build-to-readable time**: backend construction, ingestion and settling. Shared embedding-service download/load occurs outside this interval and is not claimed as measured by this run.
- **Storage bytes**: actual backend work directory, with shared model cache excluded. Diagnostics identify included model/cache artifacts.
- **Peak runner RSS**: the Bun runner process only. Python, Docker, PostgreSQL and shared embeddings are excluded. It is shown for observability, **not** used for cross-system total-memory ranking.
- **Model usage**: provider-reported input/output/cache tokens and provider-estimated USD by backend/purpose. USD is not a verified invoice or subscription marginal cost.
- **Failure rate**: retrieval exceptions remain visible. An answerable retrieval failure gets zero coverage rather than disappearing from the denominator. A backend build failure has no invented quality/latency point and remains explicitly failed.

The dashboard also distinguishes pooled micro fact coverage from mean-per-question macro coverage. These are not interchangeable; the headline runner aggregate is mean-per-question coverage.

### Uncertainty

The harness uses 1,000 deterministic cluster-bootstrap resamples of independent workspaces. It does not resample repeated cached queries as independent people/histories. With only four clusters, intervals are exploratory and may be wide or discrete. A single successful run does not establish writer-seed stability, large-scale performance, or a universal winner.

## Closed-loop visualization and evidence

- Actual run selector, status, model/configuration and dataset provenance.
- Available/failed/unavailable backends, including Chronos's missing implementation.
- Backend/budget/category/language filters.
- Coverage versus warm p95 Pareto scatter with uncertainty and sample counts.
- Category heatmap, latency CDF/distribution, coverage versus budget, QA chart.
- Independent linear/log10 X/Y controls for numerical scatter/line axes; log-capable QA and
  histogram Y axes, with categorical/bin X axes kept categorical.
- English/Simplified Chinese interface, chart text, tooltips, accessibility and localized formatting;
  source evidence, errors, diagnostics and exported records remain original.
- Build time, storage, limited-scope RSS and actual model usage tables.
- Per-question source transcripts, required facts, retrieved/capped context, found/missing evidence, wrong-state and foreign values, timings, raw record, common-reader answer and judge explanation.
- Downloadable full JSON and per-request CSV; raw JSONL files remain on disk.

There are no demo points, interpolated missing scores, hidden failed methods, or copied leaderboard values. The final recommendation uses Pareto tradeoffs and the measured scope, not an arbitrary weighted composite score.

Scale changes affect only rendering. Log axes exclude non-positive coordinates with explicit
notices; no epsilon values are substituted. Undrawable non-positive CI endpoints do not remove
an otherwise positive point. CDF omissions preserve the original sample denominator. Logarithmic
bars start at the positive axis minimum rather than the logarithmic default origin. All tables,
metrics and JSON/CSV exports retain the original measurements.

## Public-benchmark comparability boundary

LongMemEval is a useful external protocol: official histories are timestamped; answer/source labels must be withheld from ingestion; retrieval metrics exclude the 30 abstention questions; QA has its own evaluation. LoCoMo is another natural-conversation benchmark. Their published results are background research, not rows in this run.

This delivered experiment is deliberately named `coding-literals-v1`. It must not be labelled a LongMemEval-S reproduction, given a vendor's confidence interval, or compared numerically to Chronos/Mastra/Hindsight paper scores. A public-dataset reproduction would be a distinct experiment with its own exact dataset version, model, source-granularity metric and full run manifest.

## Reproduction and acceptance

The project README records the commands exercised successfully on this host. Acceptance requires:

- Real ingest and retrieval for all six available memory systems and both controls.
- Every specified query/budget/pass cell present, or an explicit preserved error; no silent omission.
- Exact context budget invariant and scoring identifier-boundary tests pass.
- Source/answer separation and separate real storage are visible in code/data.
- Dashboard builds, loads a real completed report in a real browser, renders actual charts,
  switches independent axis scales and interface language, and supports source/record drilldown
  and JSON/CSV exports without changing underlying measurements.
- Exported row counts and summary aggregates reconcile with persisted raw records.
- Chronos unavailability and every meaningful validity limitation remain visible.
