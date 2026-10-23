import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createScaleDataset } from './dataset';
import { aggregateResults } from './metrics';
import { quantileSorted } from './statistics';
import { runExperiment } from './runner';
import type { HindsightServiceOptions } from './hindsight-service';
import type { BackendId, Dataset, Report } from './types';

export interface StudyRow {
  runId: string;
  variant: string;
  factor: number;
  backend: BackendId;
  status: string;
  error?: string;
  memoriesPerCorpus: number[];
  coverage: number | null;
  anchorCoverage: number | null;
  newCoverage: number | null;
  qaAccuracy: number | null;
  anchorQa: number | null;
  newQa: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  anchorP50Ms: number | null;
  anchorP95Ms: number | null;
  newP50Ms: number | null;
  newP95Ms: number | null;
  warmRequests: number;
  contextTokens: number | null;
  stages: Array<{ name: string; meanMs: number; p50Ms: number; p95Ms: number; diagnostic: boolean }>;
  candidates: Record<string, number>;
  candidateMatch?: { matched: number; total: number; differingQueries: string[] };
}
export interface StudyReport {
  id: string;
  status: 'running' | 'complete' | 'failed';
  sourceRun: string;
  smoke: boolean;
  createdAt: string;
  finishedAt?: string;
  planned: Array<{ key: string; runId: string; factor: number; status: string }>;
  rows: StudyRow[];
  notes: string[];
}

const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

export function summarizeStudyRun(report: Report, variant: string, factor: number, baseline?: Report): StudyRow[] {
  const cohorts = report.dataset.provenance.queryCohorts as Record<string, string> | undefined;
  return report.backends.map(backend => {
    const aggregate = report.aggregates.find(item => item.backend === backend.id)!;
    const results = report.results.filter(row => row.backend === backend.id);
    const answers = report.answers.filter(row => row.backend === backend.id);
    const subset = (cohort: string) => {
      const rows = results.filter(row => (cohorts?.[row.queryId] ?? 'anchor') === cohort);
      return aggregateResults(rows, answers.filter(row => (cohorts?.[row.queryId] ?? 'anchor') === cohort), report.config.seed)[0];
    };
    const anchor = subset('anchor');
    const newQuestions = subset('new');
    const profiles = report.profiles?.filter(row => row.backend === backend.id) ?? [];
    const stageNames = [...new Set(profiles.flatMap(row => Object.keys(row.stagesMs)))];
    const candidateNames = [...new Set(profiles.flatMap(row => Object.keys(row.candidateCounts)))];
    const diagnostics = backend.diagnostics as { ingests?: Array<{ stats: { total_nodes: number } }>; corpora?: Array<{ stats: { vectorCount: number } }> };
    const baseProfiles = baseline?.profiles?.filter(row => row.backend === backend.id);
    const differingQueries = baseProfiles?.length && profiles.length ? profiles.filter(row => {
      const original = baseProfiles.find(item => item.queryId === row.queryId);
      return !original || JSON.stringify(original.candidateIds) !== JSON.stringify(row.candidateIds);
    }).map(row => row.queryId) : undefined;
    return {
      runId: report.runId, variant, factor, backend: backend.id, status: backend.status,
      ...(backend.error ? { error: backend.error } : {}),
      memoriesPerCorpus: backend.id === 'hindsight'
        ? (diagnostics.ingests ?? []).map(item => item.stats.total_nodes)
        : (diagnostics.corpora ?? []).map(item => item.stats.vectorCount),
      coverage: aggregate?.recall ?? null,
      anchorCoverage: anchor?.recall ?? null,
      newCoverage: newQuestions?.recall ?? null,
      qaAccuracy: aggregate?.answerAccuracy ?? null,
      anchorQa: anchor?.answerAccuracy ?? null,
      newQa: newQuestions?.answerAccuracy ?? null,
      p50Ms: aggregate?.p50Ms ?? null, p95Ms: aggregate?.p95Ms ?? null,
      anchorP50Ms: anchor?.p50Ms ?? null, anchorP95Ms: anchor?.p95Ms ?? null,
      newP50Ms: newQuestions?.p50Ms ?? null, newP95Ms: newQuestions?.p95Ms ?? null,
      warmRequests: results.filter(row => row.phase === 'warm' && !row.error).length,
      contextTokens: aggregate?.meanContextTokens ?? null,
      stages: stageNames.map(name => {
        const values = profiles.filter(row => typeof row.stagesMs[name] === 'number').map(row => row.stagesMs[name]).sort((a, b) => a - b);
        return { name, meanMs: average(values), p50Ms: quantileSorted(values, 0.5)!, p95Ms: quantileSorted(values, 0.95)!, diagnostic: profiles.some(row => row.diagnosticStages.includes(name)) };
      }),
      candidates: Object.fromEntries(candidateNames.map(name => [name, average(profiles.filter(row => typeof row.candidateCounts[name] === 'number').map(row => row.candidateCounts[name]))])),
      ...(differingQueries ? { candidateMatch: { matched: profiles.length - differingQueries.length, total: profiles.length, differingQueries } } : {}),
    };
  });
}

async function main() {
  const { values } = parseArgs({ args: process.argv.slice(2), options: {
    source: { type: 'string', default: 'runs/coding-memory-standard-20261018' },
    id: { type: 'string' }, variants: { type: 'string' }, factor: { type: 'string', default: '10' },
    smoke: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
  } });
  if (values.help) {
    console.log('Usage: bun run src/study.ts --id NAME [--source runs/SOURCE] [--factor 10] [--variants base,low,rrf,bucket,multilingual,scale] [--smoke]');
    return;
  }
  if (values.smoke && values.variants?.split(',').includes('scale')) throw new Error('Scale ingestion is not a four-query smoke test; omit --smoke for scale runs.');
  const id = values.id ?? `recall-study-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('Study id must be a safe directory name');
  const root = resolve('runs', id);
  await mkdir(root); // Preserve previous evidence, including failed experiments.
  const source = await Bun.file(join(values.source, 'report.json')).json() as Report;
  const dataset: Dataset = structuredClone(source.dataset);
  if (values.smoke) {
    dataset.queries = dataset.corpora.map(corpus => dataset.queries.find(query => query.corpusId === corpus.id)!);
    dataset.provenance.integrationOnly = true;
    dataset.provenance.counts = { ...(dataset.provenance.counts as Record<string, number>), queries: dataset.queries.length };
  }
  const smallPath = join(root, 'small-dataset.json');
  await writeFile(smallPath, JSON.stringify(dataset));
  const factor = Number(values.factor);
  const matrix: Array<{ key: string; factor: number; backends: BackendId[]; hindsight?: HindsightServiceOptions }> = [
    { key: 'base', factor: 1, backends: ['hindsight', 'mem0'] },
    { key: 'low', factor: 1, backends: ['hindsight'], hindsight: { budgetLevel: 'low' } },
    { key: 'rrf', factor: 1, backends: ['hindsight'], hindsight: { reranking: false } },
    { key: 'bucket', factor: 1, backends: ['hindsight'], hindsight: { bucketBatching: true } },
    { key: 'multilingual', factor: 1, backends: ['hindsight'], hindsight: { rerankerModel: 'cross-encoder/mmarco-mMiniLMv2-L12-H384-v1' } },
    { key: 'scale', factor, backends: ['hindsight', 'mem0'] },
  ];
  const requested = values.variants?.split(',') ?? matrix.filter(item => !values.smoke || item.key !== 'scale').map(item => item.key);
  if (requested.some(key => !matrix.some(item => item.key === key))) throw new Error('Unknown study variant');
  const selected = matrix.filter(item => requested.includes(item.key));
  const study: StudyReport = {
    id, status: 'running', sourceRun: source.runId, smoke: values.smoke,
    createdAt: new Date().toISOString(), rows: [],
    planned: selected.map(item => ({ key: item.key, runId: `${id}-${item.key}`, factor: item.factor, status: 'pending' })),
    notes: [
      'All stores are isolated copies. User Hindsight on 8888 and all existing omp stores are untouched.',
      'CPU-only native retrieval; the bucket variant changes batching, not model weights. AMD GPU acceleration is not measured.',
      `All main requests use 4096 o200k_base context tokens, fixed embeddings and serialized retrieval. ${values.smoke ? 'Two' : 'Three'} timing passes; first pass is not a process-cold claim.`,
      'Diagnostic traces run separately after ordinary requests. Child/parallel stage timings overlap and must not be summed.',
      'Fixed-candidate comparisons are valid only where candidateMatch confirms identical candidate IDs. Low intentionally changes retrieval budget.',
      'Scale grows the same four banks through genuine native extraction and consolidation. Anchor questions are unchanged; new questions are separately summarized.',
      'One writer build per bank. Repeated queries do not measure extraction variance. Four-cluster uncertainty is exploratory.',
      'Controlled synthetic identifier-heavy data, not a public conversational benchmark. Provider-estimated costs are not invoices.',
    ],
  };
  const save = async () => {
    await writeFile(join(root, 'study.json.tmp'), JSON.stringify(study));
    await rename(join(root, 'study.json.tmp'), join(root, 'study.json'));
  };
  await save();
  let baseline: Report | undefined;
  for (const entry of selected) {
    const planned = study.planned.find(item => item.key === entry.key)!;
    planned.status = 'running'; await save();
    let datasetPath = smallPath;
    if (entry.factor > 1) {
      datasetPath = join(root, 'scale-dataset.json');
      await writeFile(datasetPath, JSON.stringify(createScaleDataset(dataset, entry.factor)));
    }
    console.log(JSON.stringify({ event: 'study-variant-start', study: id, variant: entry.key, factor: entry.factor }));
    try {
      const report = await runExperiment({
        profile: values.smoke ? 'smoke' : 'standard', runId: planned.runId,
        datasetPath, backends: entry.backends, budgets: [4096], repeats: values.smoke ? 2 : 3,
        reuseRunDir: values.source, hindsight: entry.hindsight, profileRetrieval: true,
        study: { id, variant: entry.key, factor: entry.factor },
      });
      if (entry.key === 'base') baseline = report;
      study.rows.push(...summarizeStudyRun(report, entry.key, entry.factor, ['rrf', 'bucket', 'multilingual'].includes(entry.key) ? baseline : undefined));
      planned.status = report.status;
    } catch (error) {
      planned.status = 'failed';
      study.notes.push(`${entry.key}: ${String(error)}`);
      console.error(JSON.stringify({ event: 'study-variant-failed', variant: entry.key, error: String(error) }));
    }
    await save();
  }
  study.status = study.planned.some(item => item.status !== 'complete') ? 'failed' : 'complete';
  study.finishedAt = new Date().toISOString();
  await save();
  console.log(JSON.stringify({ event: 'study-complete', id, status: study.status, rows: study.rows }));
  process.exitCode = study.status === 'complete' ? 0 : 1;
}

if (import.meta.main) await main();
