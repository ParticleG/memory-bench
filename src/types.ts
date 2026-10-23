import type { ModelRegistry } from '@oh-my-pi/pi-coding-agent/config/model-registry';
import type { Settings } from '@oh-my-pi/pi-coding-agent/config/settings';

export type BackendId = 'local' | 'hindsight' | 'mnemopi' | 'sharpshooter' | 'mastra' | 'mem0' | 'bm25' | 'no-memory' | 'chronos';
export interface Message { role: 'user' | 'assistant'; content: string }
export interface Document { id: string; timestamp: string; messages: Message[] }
/** The only dataset object exposed to ingestion: no queries, answers, or gold labels. */
export interface Corpus { id: string; projectId: string; language: 'en' | 'zh'; documents: Document[] }
export interface RecallQuery { id: string; corpusId: string; projectId: string; text: string; asOf: string }
export interface GoldFact {
  id: string;
  corpusId: string;
  text: string;
  /** Unique literal values used for deterministic evidence coverage, not semantic similarity. */
  aliases: string[];
  sourceDocumentIds: string[];
  stale?: boolean;
}
export interface EvalQuery extends RecallQuery {
  language: 'en' | 'zh';
  category: string;
  requiredFactIds: string[];
  forbiddenFactIds: string[];
  answerable: boolean;
}
export interface Dataset { version: string; corpora: Corpus[]; facts: GoldFact[]; queries: EvalQuery[]; provenance: Record<string, unknown> }
export interface MemoryItem { id?: string; text: string; score?: number; sourceIds?: string[] }
export interface Retrieval { items: MemoryItem[]; metadata?: Record<string, unknown> }
export interface NativeHost { modelRegistry: ModelRegistry; settings: Settings }
export interface AdapterContext {
  runId: string;
  workDir: string;
  model: string;
  openaiBaseUrl: string;
  embeddingModel: string;
  embeddingDimensions: number;
  complete: (system: string, user: string, options?: { maxTokens?: number; json?: boolean }) => Promise<string>;
  countTokens: (text: string) => number;
  createNativeHost: (agentDir: string, cwd: string) => Promise<NativeHost>;
  log: (event: string, details: Record<string, unknown>) => void;
}
export interface MemoryAdapter {
  id: BackendId;
  name: string;
  mode: 'static-injection' | 'query-retrieval' | 'observational-context' | 'control';
  /** Build isolated stores from complete chronological history and wait until memory is readable. */
  ingest: (corpora: Corpus[]) => Promise<void>;
  retrieve: (query: RecallQuery, budget: number) => Promise<Retrieval>;
  /** Separate instrumented requests; never mixed into headline latency samples. */
  profile?: (query: RecallQuery, budget: number) => Promise<Retrieval>;
  close: () => Promise<void>;
  diagnostics: () => Record<string, unknown>;
}
export type AdapterFactory = (context: AdapterContext) => Promise<MemoryAdapter>;
export interface BackendRun {
  id: BackendId;
  name: string;
  status: 'pending' | 'ingesting' | 'evaluating' | 'complete' | 'failed' | 'unavailable';
  mode: string;
  ingestMs: number | null;
  storageBytes: number | null;
  peakProcessRssBytes: number | null;
  error?: string;
  diagnostics: Record<string, unknown>;
}
export interface QueryResult {
  id: string;
  backend: BackendId;
  queryId: string;
  corpusId: string;
  category: string;
  language: string;
  budget: number;
  repeat: number;
  phase: 'first-query' | 'warm';
  latencyMs: number;
  contextTokens: number;
  context: string;
  items: MemoryItem[];
  requiredFactIds: string[];
  foundFactIds: string[];
  forbiddenFactIds: string[];
  leakedFactIds: string[];
  recall: number | null;
  evidencePrecision: number | null;
  completeEvidence: boolean | null;
  staleHit: boolean;
  scopeLeak: boolean;
  error?: string;
  metadata?: Record<string, unknown>;
}
export interface AnswerResult {
  backend: BackendId;
  queryId: string;
  budget: number;
  answer: string;
  supportedFactIds: string[];
  correct: boolean;
  abstained: boolean;
  latencyMs: number;
  judgeExplanation: string;
}
export interface UsageRecord {
  at: string;
  backend: string;
  purpose: string;
  model: string;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  providerEstimatedUsd: number | null;
  error?: string;
}
export interface Aggregate {
  backend: BackendId;
  budget: number;
  nQueries: number;
  nRequests: number;
  recall: number | null;
  recallCi: [number, number] | null;
  completeEvidenceRate: number | null;
  precision: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  errorRate: number;
  staleRate: number | null;
  scopeLeakRate: number | null;
  meanContextTokens: number | null;
  answerAccuracy: number | null;
}
export interface RunConfig {
  seed: number;
  budgets: number[];
  repeats: number;
  model: string;
  readerModel: string;
  judgeModel: string;
  tokenizer: string;
  datasetVersion: string;
  concurrency: number;
  notes: string[];
}
export interface RetrievalProfile {
  backend: BackendId;
  queryId: string;
  corpusId: string;
  latencyMs: number;
  stagesMs: Record<string, number>;
  diagnosticStages: string[];
  candidateCounts: Record<string, number>;
  candidateIds: string[];
}
export interface Report {
  schemaVersion: 1;
  runId: string;
  createdAt: string;
  finishedAt?: string;
  status: 'running' | 'complete' | 'failed';
  config: RunConfig;
  environment: Record<string, unknown>;
  dataset: Dataset;
  backends: BackendRun[];
  results: QueryResult[];
  answers: AnswerResult[];
  usage: UsageRecord[];
  profiles?: RetrievalProfile[];
  aggregates: Aggregate[];
  limitations: string[];
  sources: { label: string; url: string }[];
}
