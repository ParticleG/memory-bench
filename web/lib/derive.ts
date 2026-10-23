import { quantileSorted } from '../../src/statistics';
import { isNum } from './format';
import type {
  Aggregate,
  AnswerResult,
  Dataset,
  Document,
  EvalQuery,
  FilterState,
  GoldFact,
  QueryResult,
  Report,
  UsageRecord,
} from './types';

export interface IndexedDocument {
  document: Document;
  corpusId: string;
  projectId: string;
  language: string;
}

export type QueryIndex = Map<string, EvalQuery>;
export type FactIndex = Map<string, GoldFact>;
export type DocumentIndex = Map<string, IndexedDocument>;

export function indexQueries(dataset: Dataset): QueryIndex {
  return new Map(dataset.queries.map((query) => [query.id, query]));
}

export function indexFacts(dataset: Dataset): FactIndex {
  return new Map(dataset.facts.map((fact) => [fact.id, fact]));
}

export function indexDocuments(dataset: Dataset): DocumentIndex {
  const index: DocumentIndex = new Map();
  for (const corpus of dataset.corpora) {
    for (const document of corpus.documents) {
      index.set(document.id, {
        document,
        corpusId: corpus.id,
        projectId: corpus.projectId,
        language: corpus.language,
      });
    }
  }
  return index;
}

export function uniqueBudgets(report: Report): number[] {
  const values = new Set<number>();
  for (const budget of report.config.budgets) if (isNum(budget)) values.add(budget);
  for (const aggregate of report.aggregates) if (isNum(aggregate.budget)) values.add(aggregate.budget);
  for (const result of report.results) if (isNum(result.budget)) values.add(result.budget);
  for (const answer of report.answers) if (isNum(answer.budget)) values.add(answer.budget);
  return [...values].sort((a, b) => a - b);
}

export function uniqueCategories(report: Report): string[] {
  const values = new Set<string>();
  for (const query of report.dataset.queries) if (query.category) values.add(query.category);
  for (const result of report.results) if (result.category) values.add(result.category);
  return [...values].sort((a, b) => a.localeCompare(b));
}

export function uniqueLanguages(report: Report): string[] {
  const values = new Set<string>();
  for (const query of report.dataset.queries) if (query.language) values.add(query.language);
  for (const result of report.results) if (result.language) values.add(result.language);
  return [...values].sort((a, b) => a.localeCompare(b));
}

export function filterResults(results: QueryResult[], filters: FilterState): QueryResult[] {
  const backends = new Set(filters.backends);
  return results.filter(
    (result) =>
      backends.has(result.backend) &&
      (filters.budget === null || result.budget === filters.budget) &&
      (filters.category === null || result.category === filters.category) &&
      (filters.language === null || result.language === filters.language),
  );
}

export function filterAggregates(aggregates: Aggregate[], filters: FilterState): Aggregate[] {
  const backends = new Set(filters.backends);
  return aggregates.filter(
    (aggregate) =>
      backends.has(aggregate.backend) &&
      (filters.budget === null || aggregate.budget === filters.budget),
  );
}

export function filterAnswers(
  answers: AnswerResult[],
  filters: FilterState,
  queries: QueryIndex,
): AnswerResult[] {
  const backends = new Set(filters.backends);
  return answers.filter((answer) => {
    if (!backends.has(answer.backend)) return false;
    if (filters.budget !== null && answer.budget !== filters.budget) return false;
    if (filters.category === null && filters.language === null) return true;
    const query = queries.get(answer.queryId);
    if (!query) return false;
    if (filters.category !== null && query.category !== filters.category) return false;
    if (filters.language !== null && query.language !== filters.language) return false;
    return true;
  });
}

export interface NullableMean {
  value: number | null;
  n: number;
}

export function meanNullable(values: Iterable<number | null | undefined>): NullableMean {
  let total = 0;
  let n = 0;
  for (const value of values) {
    if (!isNum(value)) continue;
    total += value;
    n += 1;
  }
  return { value: n > 0 ? total / n : null, n };
}

export function sumNullable(values: Iterable<number | null | undefined>): NullableMean {
  let total = 0;
  let n = 0;
  for (const value of values) {
    if (!isNum(value)) continue;
    total += value;
    n += 1;
  }
  return { value: n > 0 ? total : null, n };
}

export function rateOf(values: Iterable<boolean | null | undefined>): NullableMean {
  let hits = 0;
  let n = 0;
  for (const value of values) {
    if (typeof value !== 'boolean') continue;
    if (value) hits += 1;
    n += 1;
  }
  return { value: n > 0 ? hits / n : null, n };
}


export interface ScopeMetrics {
  nResults: number;
  nQueries: number;
  macroCoverage: number | null;
  macroN: number;
  microCoverage: number | null;
  microFoundFacts: number;
  microRequiredFacts: number;
  microQueries: number;
  precision: number | null;
  precisionN: number;
  completeEvidenceRate: number | null;
  completeEvidenceN: number;
  staleRate: number | null;
  scopeLeakRate: number | null;
  errorRate: number | null;
  nErrors: number;
}

/**
 * Metrics computed directly from QueryResult rows. `macroCoverage` is the
 * unweighted mean of per-request literal fact coverage; `microCoverage` pools
 * found/required literal fact pairs. Neither is a semantic-similarity score.
 */
export function computeScopeMetrics(results: QueryResult[]): ScopeMetrics {
  const macro = meanNullable(results.map((result) => result.recall));
  const precision = meanNullable(results.map((result) => result.evidencePrecision));
  const complete = rateOf(results.map((result) => result.completeEvidence));
  const stale = rateOf(results.map((result) => result.staleHit));
  const leak = rateOf(results.map((result) => result.scopeLeak));
  let microFoundFacts = 0;
  let microRequiredFacts = 0;
  let microQueries = 0;
  for (const result of results) {
    if (result.recall === null || result.requiredFactIds.length === 0) continue;
    const required = new Set(result.requiredFactIds);
    microFoundFacts += new Set(result.foundFactIds.filter((id) => required.has(id))).size;
    microRequiredFacts += required.size;
    microQueries += 1;
  }
  const nErrors = results.reduce((count, result) => count + (result.error ? 1 : 0), 0);
  return {
    nResults: results.length,
    nQueries: new Set(results.map((result) => result.queryId)).size,
    macroCoverage: macro.value,
    macroN: macro.n,
    microCoverage: microRequiredFacts > 0 ? microFoundFacts / microRequiredFacts : null,
    microFoundFacts,
    microRequiredFacts,
    microQueries,
    precision: precision.value,
    precisionN: precision.n,
    completeEvidenceRate: complete.value,
    completeEvidenceN: complete.n,
    staleRate: stale.value,
    scopeLeakRate: leak.value,
    errorRate: results.length > 0 ? nErrors / results.length : null,
    nErrors,
  };
}

export interface MetricPoint {
  backend: string;
  budget: number;
  coverage: number | null;
  coverageCi: [number, number] | null;
  p95Ms: number | null;
  nQueries: number | null;
  nRequests: number | null;
  source: 'runner' | 'computed' | 'missing';
  macroN: number | null;
}

/**
 * One point per selected backend × budget. Runner aggregates are used when
 * category/language scope is unfiltered; otherwise the subset is recomputed
 * from QueryResult rows and the point is explicitly marked `computed`.
 */
export function buildMetricPoints(report: Report, filters: FilterState): MetricPoint[] {
  const budgets = filters.budget === null ? uniqueBudgets(report) : [filters.budget];
  const points: MetricPoint[] = [];
  const scopedToEverything = filters.category === null && filters.language === null;

  for (const backend of filters.backends) {
    for (const budget of budgets) {
      const aggregate = report.aggregates.find(
        (item) => item.backend === backend && item.budget === budget,
      );
      const results = report.results.filter(
        (result) =>
          result.backend === backend &&
          result.budget === budget &&
          (filters.category === null || result.category === filters.category) &&
          (filters.language === null || result.language === filters.language),
      );

      if (scopedToEverything && aggregate) {
        points.push({
          backend,
          budget,
          coverage: aggregate.recall,
          coverageCi: aggregate.recallCi,
          p95Ms: aggregate.p95Ms,
          nQueries: aggregate.nQueries,
          nRequests: aggregate.nRequests,
          source: 'runner',
          macroN: null,
        });
        continue;
      }

      if (results.length > 0) {
        const metrics = computeScopeMetrics(results);
        const latencies = results
          .filter((result) => result.phase === 'warm' && !result.error)
          .map((result) => result.latencyMs)
          .filter((value): value is number => isNum(value))
          .sort((a, b) => a - b);
        points.push({
          backend,
          budget,
          coverage: metrics.macroCoverage,
          coverageCi: null,
          p95Ms: quantileSorted(latencies, 0.95),
          nQueries: metrics.nQueries,
          nRequests: metrics.nResults,
          source: 'computed',
          macroN: metrics.macroN,
        });
        continue;
      }

      points.push({
        backend,
        budget,
        coverage: null,
        coverageCi: null,
        p95Ms: null,
        nQueries: null,
        nRequests: null,
        source: 'missing',
        macroN: null,
      });
    }
  }
  return points;
}

export interface CategoryCell {
  backend: string;
  category: string;
  coverage: number | null;
  n: number;
  nRequests: number;
}

export function buildCategoryCells(report: Report, filters: FilterState): CategoryCell[] {
  const categories = uniqueCategories(report);
  const baseFilters: FilterState = { ...filters, category: null };
  const rows = filterResults(report.results, baseFilters);
  const cells: CategoryCell[] = [];
  for (const backend of filters.backends) {
    for (const category of categories) {
      const scoped = rows.filter(
        (result) => result.backend === backend && result.category === category,
      );
      const metrics = computeScopeMetrics(scoped);
      cells.push({
        backend,
        category,
        coverage: metrics.macroCoverage,
        n: metrics.macroN,
        nRequests: metrics.nResults,
      });
    }
  }
  return cells;
}

export interface BackendLatencySamples {
  backend: string;
  values: number[];
  firstQueryCount: number;
  totalWarmCount: number;
}

export function buildLatencySamples(report: Report, filters: FilterState, mode: 'warm' | 'first-seen'): BackendLatencySamples[] {
  const rows = filterResults(report.results, filters);
  return filters.backends.map((backend) => {
    const backendRows = rows.filter((result) => result.backend === backend);
    const values = backendRows
      .filter((result) => !result.error && (mode === 'warm' ? result.phase === 'warm' : result.metadata?.harnessQueryNovelty === 'first-seen'))
      .map((result) => result.latencyMs)
      .filter((value): value is number => isNum(value))
      .sort((a, b) => a - b);
    return {
      backend,
      values,
      firstQueryCount: backendRows.filter((result) => result.phase === 'first-query').length,
      totalWarmCount: backendRows.filter((result) => result.phase === 'warm').length,
    };
  });
}

export interface AccuracyRow {
  backend: string;
  budget: number;
  nAnswers: number;
  nCorrect: number;
  nAbstained: number;
  accuracy: number | null;
  meanLatencyMs: number | null;
  runnerAccuracy: number | null;
  source: 'answers' | 'runner';
}

export function buildAccuracyRows(
  report: Report,
  filters: FilterState,
  queries: QueryIndex,
): AccuracyRow[] {
  const answers = filterAnswers(report.answers, filters, queries);
  const grouped = new Map<string, AnswerResult[]>();
  for (const answer of answers) {
    const key = `${answer.backend}\u0000${answer.budget}`;
    const list = grouped.get(key);
    if (list) list.push(answer);
    else grouped.set(key, [answer]);
  }

  const rows: AccuracyRow[] = [];
  for (const [key, group] of grouped) {
    const [backend, rawBudget] = key.split('\u0000');
    const budget = Number(rawBudget);
    const correct = group.filter((answer) => answer.correct).length;
    const abstained = group.filter((answer) => answer.abstained).length;
    const latency = meanNullable(group.map((answer) => answer.latencyMs));
    const aggregate = report.aggregates.find(
      (item) => item.backend === backend && item.budget === budget,
    );
    rows.push({
      backend,
      budget,
      nAnswers: group.length,
      nCorrect: correct,
      nAbstained: abstained,
      accuracy: group.length > 0 ? correct / group.length : null,
      meanLatencyMs: latency.value,
      runnerAccuracy: aggregate?.answerAccuracy ?? null,
      source: 'answers',
    });
  }

  if (rows.length === 0 && filters.category === null && filters.language === null) {
    for (const aggregate of filterAggregates(report.aggregates, filters)) {
      if (aggregate.answerAccuracy === null) continue;
      rows.push({
        backend: aggregate.backend,
        budget: aggregate.budget,
        nAnswers: 0,
        nCorrect: 0,
        nAbstained: 0,
        accuracy: null,
        meanLatencyMs: null,
        runnerAccuracy: aggregate.answerAccuracy,
        source: 'runner',
      });
    }
  }

  return rows.sort(
    (a, b) => a.backend.localeCompare(b.backend) || a.budget - b.budget,
  );
}

export interface UsageTotals {
  records: number;
  inputTokens: number | null;
  inputReported: number;
  outputTokens: number | null;
  outputReported: number;
  cacheReadTokens: number | null;
  cacheReported: number;
  estimatedUsd: number | null;
  usdReported: number;
  errors: number;
  models: string[];
  purposes: string[];
}

export function summarizeUsage(records: UsageRecord[]): UsageTotals {
  const input = sumNullable(records.map((record) => record.inputTokens));
  const output = sumNullable(records.map((record) => record.outputTokens));
  const cache = sumNullable(records.map((record) => record.cacheReadTokens));
  const usd = sumNullable(records.map((record) => record.providerEstimatedUsd));
  return {
    records: records.length,
    inputTokens: input.value,
    inputReported: input.n,
    outputTokens: output.value,
    outputReported: output.n,
    cacheReadTokens: cache.value,
    cacheReported: cache.n,
    estimatedUsd: usd.value,
    usdReported: usd.n,
    errors: records.filter((record) => record.error).length,
    models: [...new Set(records.map((record) => record.model))].sort(),
    purposes: [...new Set(records.map((record) => record.purpose))].sort(),
  };
}

export interface UsageBreakdownRow {
  purpose: string;
  model: string;
  records: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  estimatedUsd: number | null;
  meanLatencyMs: number | null;
  errors: number;
}

export function summarizeUsageByPurpose(records: UsageRecord[]): UsageBreakdownRow[] {
  const grouped = new Map<string, UsageRecord[]>();
  for (const record of records) {
    const key = `${record.purpose}\u0000${record.model}`;
    const list = grouped.get(key);
    if (list) list.push(record);
    else grouped.set(key, [record]);
  }
  const rows: UsageBreakdownRow[] = [];
  for (const [key, group] of grouped) {
    const [purpose, model] = key.split('\u0000');
    rows.push({
      purpose,
      model,
      records: group.length,
      inputTokens: sumNullable(group.map((record) => record.inputTokens)).value,
      outputTokens: sumNullable(group.map((record) => record.outputTokens)).value,
      cacheReadTokens: sumNullable(group.map((record) => record.cacheReadTokens)).value,
      estimatedUsd: sumNullable(group.map((record) => record.providerEstimatedUsd)).value,
      meanLatencyMs: meanNullable(group.map((record) => record.latencyMs)).value,
      errors: group.filter((record) => record.error).length,
    });
  }
  return rows.sort((a, b) => a.purpose.localeCompare(b.purpose) || a.model.localeCompare(b.model));
}

export interface ResolvedFact {
  id: string;
  fact: GoldFact | null;
}

export function resolveFacts(ids: string[], facts: FactIndex): ResolvedFact[] {
  return ids.map((id) => ({ id, fact: facts.get(id) ?? null }));
}

export function missingFactIds(required: string[], found: string[]): string[] {
  const foundSet = new Set(found);
  return required.filter((id) => !foundSet.has(id));
}

export function answersFor(result: QueryResult, answers: AnswerResult[]): AnswerResult[] {
  return answers.filter(
    (answer) =>
      answer.backend === result.backend &&
      answer.queryId === result.queryId &&
      answer.budget === result.budget,
  );
}
