import { parseArgs } from 'node:util';
import { runExperiment } from './runner';
import type { BackendId } from './types';

const { values } = parseArgs({ args: process.argv.slice(2), options: { profile: { type: 'string', default: 'standard' }, seed: { type: 'string' }, dataset: { type: 'string' }, backends: { type: 'string' }, budgets: { type: 'string', default: '1024,4096' }, repeats: { type: 'string', default: '2' }, 'skip-qa': { type: 'boolean', default: false }, 'run-id': { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
if (values.help) {
  console.log(`Memory benchmark — authentic engines, isolated stores, real GPT calls

Usage: bun run bench [--profile standard|smoke] [--seed N]
       [--backends no-memory,bm25,local,sharpshooter,mnemopi,hindsight,mastra,mem0,chronos]
       [--budgets 1024,4096] [--repeats 2] [--skip-qa] [--run-id NAME]
       [--dataset runs/EXISTING/dataset.json]

Prerequisite: authenticated omp GPT models, Docker, shared embeddings on 127.0.0.1:9324.
Standard: 4 bilingual historical coding corpora, 96 questions, frozen retrieval, QA at largest budget.
Smoke: small corpus for integration only; never interpret as a memory-quality ranking.
Artifacts: runs/<run-id>/{dataset.json,report.json,retrieval.jsonl,answers.jsonl,usage.jsonl,results.csv}.
Serve the real dashboard: bun run build && bun run serve.
`);
  process.exit(0);
}
if (values.profile !== 'standard' && values.profile !== 'smoke') throw new Error('Unknown profile');
const allowed: Record<BackendId, true> = { local: true, hindsight: true, mnemopi: true, sharpshooter: true, mastra: true, mem0: true, bm25: true, 'no-memory': true, chronos: true };
const backends = values.backends?.split(',').map(id => { if (!Object.hasOwn(allowed, id)) throw new Error(`Unknown backend: ${id}`); return id as BackendId; });
const report = await runExperiment({ profile: values.profile, seed: values.seed === undefined ? undefined : Number(values.seed), datasetPath: values.dataset, backends, budgets: values.budgets.split(',').map(Number), repeats: Number(values.repeats), qa: !values['skip-qa'], runId: values['run-id'] });
console.log(JSON.stringify({ runId: report.runId, status: report.status, aggregates: report.aggregates }, null, 2));
process.exit(report.status === 'complete' ? 0 : 1);
