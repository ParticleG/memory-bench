import { describe, expect, test } from 'bun:test';
import { clusterInterval, literalPresent, packContext, scoreContext } from './metrics';
import { countTokens } from './runtime';
import { quantileSorted } from './statistics';
import { buildLatencySamples, buildMetricPoints } from '../web/lib/derive';
import { buildCdfPoints, isAxisValue, logAxisMin } from '../web/lib/axis';
import type { Dataset, EvalQuery, QueryResult, Report } from './types';

describe('observable benchmark metric boundaries', () => {
  test('a context never exceeds its exact budget, including multibyte boundary truncation', () => {
    const items = [{ text: 'English memory ' + '中文约束🙂🔒'.repeat(100) }, { text: 'another memory' }];
    for (const budget of [0, 1, 7, 64, 1024]) {
      const packed = packContext({ items }, budget);
      expect(countTokens(packed.context)).toBeLessThanOrEqual(budget);
      expect(packed.tokens).toBe(countTokens(packed.context));
      expect(packed.items.map(item => item.text).join('\n\n')).toBe(packed.context);
    }
  });
  test('answer values embedded in a different identifier do not count as recalled evidence', () => {
    expect(literalPresent('Rejected identifier prefix-v42-suffix.', 'v42')).toBe(false);
    expect(literalPresent('Current profile: `v42`.', 'v42')).toBe(true);
    expect(literalPresent('Current profile: v420.', 'v42')).toBe(false);
  });
  test('missing evidence, obsolete values and foreign workspace values stay distinct', () => {
    const dataset = { facts: [{ id: 'current', corpusId: 'a', text: '', aliases: ['cur42'], sourceDocumentIds: ['s1'] }, { id: 'old', corpusId: 'a', text: '', aliases: ['old42'], sourceDocumentIds: ['s0'] }, { id: 'foreign', corpusId: 'b', text: '', aliases: ['ext42'], sourceDocumentIds: ['s2'] }] } as Dataset;
    const query = { corpusId: 'a', requiredFactIds: ['current'], forbiddenFactIds: ['old'] } as EvalQuery;
    const result = scoreContext(dataset, query, 'old42 and ext42, not a current value.');
    expect(result.recall).toBe(0);
    expect(result.completeEvidence).toBe(false);
    expect(result.staleHit).toBe(true);
    expect(result.leakedFactIds).toEqual(['foreign']);
    expect(result.scopeLeak).toBe(true);
  });
  test('confidence resamples independent histories, not repeated cached calls', () => {
    const rows = [0, 0.25, 0.75, 1].map((recall, index) => ({ corpusId: String(index), recall } as QueryResult));
    const interval = clusterInterval(rows)!;
    expect(interval[0]).toBeLessThan(interval[1]);
    expect(clusterInterval([...rows, ...rows, ...rows])).toEqual(interval);
  });
  test('latency percentiles interpolate small samples and leave empty samples unavailable', () => {
    expect(quantileSorted([0, 10], 0.95)).toBe(9.5);
    expect(quantileSorted([0, 10], 0.5)).toBe(5);
    expect(quantileSorted([], 0.95)).toBeNull();
  });
  test('first scoped-query latency does not include cached second-budget requests or failed warm requests', () => {
    const base: Omit<QueryResult, 'phase' | 'latencyMs'> = {
      id: 'mnemopi-q1', backend: 'mnemopi', queryId: 'q1', corpusId: 'workspace-a', category: 'direct', language: 'en',
      budget: 1024, repeat: 0, contextTokens: 0, context: '', items: [], requiredFactIds: [], foundFactIds: [],
      forbiddenFactIds: [], leakedFactIds: [], recall: null, evidencePrecision: null, completeEvidence: null, staleHit: false, scopeLeak: false,
    };
    const results: QueryResult[] = [
      { ...base, phase: 'first-query', latencyMs: 100, metadata: { harnessQueryNovelty: 'first-seen' } },
      { ...base, budget: 4096, phase: 'first-query', latencyMs: 3, metadata: { harnessQueryNovelty: 'repeated' } },
      { ...base, repeat: 1, phase: 'warm', latencyMs: 4, metadata: { harnessQueryNovelty: 'repeated' } },
      { ...base, repeat: 1, phase: 'warm', latencyMs: 1, error: 'provider failed', metadata: { harnessQueryNovelty: 'repeated' } },
    ];
    const report = { results } as Report;
    const filters = { backends: ['mnemopi'], budget: null, category: null, language: null };
    expect(buildLatencySamples(report, filters, 'first-seen')[0].values).toEqual([100]);
    expect(buildLatencySamples(report, filters, 'warm')[0].values).toEqual([4]);
    const pointReport = { ...report, aggregates: [] } as Report;
    expect(buildMetricPoints(pointReport, { ...filters, budget: 1024, category: 'direct' })[0].p95Ms).toBe(4);
  });
});

describe('logarithmic chart data boundaries', () => {
  test('zero remains a valid linear measurement but cannot be a logarithmic coordinate', () => {
    expect(isAxisValue(0, 'linear')).toBe(true);
    expect(isAxisValue(-1, 'linear')).toBe(true);
    expect(isAxisValue(0, 'log')).toBe(false);
    expect(isAxisValue(-1, 'log')).toBe(false);
    expect(isAxisValue(0.000001, 'log')).toBe(true);
    expect(isAxisValue(null, 'linear')).toBe(false);
    expect(isAxisValue(Number.NaN, 'log')).toBe(false);
    expect(isAxisValue(Number.POSITIVE_INFINITY, 'log')).toBe(false);
  });
  test('logarithmic bounds leave room below a constant 100% series and ignore non-positive inputs', () => {
    expect(logAxisMin([1, 1, 1])).toBe(0.1);
    expect(logAxisMin([0, -2, Number.NaN, 0.002, 50])).toBe(0.001);
    expect(logAxisMin([0.001])).toBe(0.0001);
    expect(logAxisMin([0, -1])).toBe(0.1);
    expect(logAxisMin([])).toBe(0.1);
    expect(logAxisMin([Number.MIN_VALUE])).toBeGreaterThan(0);
  });
  test('hiding non-positive latency preserves original CDF ranks, ties and sample denominator', () => {
    const samples = [-1, 0, 0, 2, 2, 10];
    expect(buildCdfPoints(samples, 'log', 'linear')).toEqual([[2, 5 / 6], [10, 1]]);
    expect(buildCdfPoints(samples, 'log', 'log')).toEqual([[2, 5 / 6], [10, 1]]);
    expect(buildCdfPoints(samples, 'linear', 'log')).toEqual([[-1, 1 / 6], [0, 3 / 6], [2, 5 / 6], [10, 1]]);
    expect(buildCdfPoints([0, 0], 'log', 'log')).toEqual([]);
    expect(buildCdfPoints([], 'log', 'log')).toEqual([]);
    expect(buildCdfPoints([], 'linear', 'linear')).toEqual([]);
    expect(buildCdfPoints([2, 2, 10], 'linear', 'linear')).toEqual([[0, 0], [2, 2 / 3], [10, 1]]);
  });
});
