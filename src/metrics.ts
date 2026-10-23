import { countTokens, truncateTokens } from './runtime';
import { quantileSorted } from './statistics';
import type { Aggregate, AnswerResult, Dataset, EvalQuery, MemoryItem, QueryResult, Retrieval } from './types';

/** Budget includes separators and every static/dynamic memory item, but not the common reader prompt. */
export function packContext(retrieval: Retrieval, budget: number): { context: string; items: MemoryItem[]; tokens: number } {
  const packed: MemoryItem[] = [];
  let context = '';
  for (const item of retrieval.items) {
    if (!item.text.trim()) continue;
    const prefix = context ? '\n\n' : '';
    const proposed = context + prefix + item.text;
    if (countTokens(proposed) <= budget) { packed.push(item); context = proposed; continue; }
    const truncated = truncateTokens(proposed, budget);
    const kept = truncated.slice((context + prefix).length);
    if (kept) packed.push({ ...item, text: kept });
    context = truncated;
    break;
  }
  return { context, items: packed, tokens: countTokens(context) };
}
export function literalPresent(text: string, alias: string): boolean {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}_-])${escaped}(?![\\p{L}\\p{N}_-])`, 'iu').test(text);
}
export function scoreContext(dataset: Dataset, query: EvalQuery, context: string) {
  const detected = dataset.facts.filter(fact => fact.aliases.some(alias => literalPresent(context, alias)));
  const foundFactIds = detected.filter(fact => query.requiredFactIds.includes(fact.id)).map(fact => fact.id);
  const leakedFactIds = detected.filter(fact => fact.corpusId !== query.corpusId).map(fact => fact.id);
  const wrongState = detected.filter(fact => query.forbiddenFactIds.includes(fact.id));
  return { requiredFactIds: query.requiredFactIds, foundFactIds, forbiddenFactIds: query.forbiddenFactIds, leakedFactIds, recall: query.requiredFactIds.length ? foundFactIds.length / query.requiredFactIds.length : null, evidencePrecision: query.requiredFactIds.length && detected.length ? foundFactIds.length / detected.length : null, completeEvidence: query.requiredFactIds.length ? foundFactIds.length === query.requiredFactIds.length : null, staleHit: wrongState.length > 0, scopeLeak: leakedFactIds.length > 0 };
}
export function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}
/** Resample independent corpora, never timing repetitions, to avoid pseudo-replicated confidence. */
export function clusterInterval(records: QueryResult[], seed = 20261018): [number, number] | null {
  const clusters = [...new Set(records.map(record => record.corpusId))];
  if (clusters.length < 2) return null;
  const scores = clusters.map(id => records.filter(record => record.corpusId === id && record.recall !== null).map(record => record.recall!));
  if (scores.some(cluster => !cluster.length)) return null;
  let state = seed >>> 0;
  const samples: number[] = [];
  for (let trial = 0; trial < 1000; trial++) {
    let sum = 0; let count = 0;
    for (let i = 0; i < clusters.length; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const selected = scores[Math.floor(state / 4294967296 * scores.length)];
      sum += selected.reduce((total, value) => total + value, 0); count += selected.length;
    }
    samples.push(sum / count);
  }
  samples.sort((a, b) => a - b);
  return [quantileSorted(samples, 0.025)!, quantileSorted(samples, 0.975)!];
}
export function aggregateResults(results: QueryResult[], answers: AnswerResult[], seed: number): Aggregate[] {
  const groups = new Map<string, QueryResult[]>();
  for (const row of results) { const key = `${row.backend}:${row.budget}`; const existing = groups.get(key); if (existing) existing.push(row); else groups.set(key, [row]); }
  return [...groups.values()].map(records => {
    const { backend, budget } = records[0];
    const warm = records.filter(row => row.phase === 'warm' && !row.error);
    const warmLatencies = warm.map(row => row.latencyMs).sort((a, b) => a - b);
    const answerable = records.filter(row => row.recall !== null);
    const stateQueries = records.filter(row => row.forbiddenFactIds.length > 0);
    const precision = records.filter(row => row.evidencePrecision !== null);
    const qa = answers.filter(row => row.backend === backend && row.budget === budget);
    return { backend, budget, nQueries: new Set(records.map(row => row.queryId)).size, nRequests: records.length, recall: average(answerable.map(row => row.recall!)), recallCi: clusterInterval(records, seed), completeEvidenceRate: average(answerable.map(row => row.completeEvidence ? 1 : 0)), precision: average(precision.map(row => row.evidencePrecision!)), p50Ms: quantileSorted(warmLatencies, 0.5), p95Ms: quantileSorted(warmLatencies, 0.95), errorRate: records.filter(row => row.error).length / records.length, staleRate: average(stateQueries.map(row => row.staleHit ? 1 : 0)), scopeLeakRate: average(records.map(row => row.scopeLeak ? 1 : 0)), meanContextTokens: average(records.filter(row => !row.error).map(row => row.contextTokens)), answerAccuracy: average(qa.map(row => row.correct ? 1 : 0)) };
  });
}
export function exportCsv(results: QueryResult[]): string {
  const keys: (keyof QueryResult | 'queryNovelty')[] = ['id', 'backend', 'queryId', 'corpusId', 'category', 'language', 'budget', 'repeat', 'phase', 'queryNovelty', 'latencyMs', 'contextTokens', 'recall', 'evidencePrecision', 'completeEvidence', 'staleHit', 'scopeLeak', 'error', 'requiredFactIds', 'foundFactIds', 'forbiddenFactIds', 'leakedFactIds', 'context'];
  const escape = (value: unknown) => `"${String(value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : value).replaceAll('"', '""')}"`;
  return [keys.join(','), ...results.map(row => keys.map(key => escape(key === 'queryNovelty' ? row.metadata?.harnessQueryNovelty : row[key])).join(','))].join('\n') + '\n';
}
