export type {
  Aggregate,
  AnswerResult,
  BackendId,
  BackendRun,
  Corpus,
  Dataset,
  Document,
  EvalQuery,
  GoldFact,
  MemoryItem,
  Message,
  QueryResult,
  Report,
  Retrieval,
  RunConfig,
  UsageRecord,
} from '../../src/types';

/**
 * UI filter scope. `null` means "all"; a token budget is a real recorded
 * budget, never a synthesized default.
 */
export interface FilterState {
  backends: string[];
  budget: number | null;
  category: string | null;
  language: string | null;
}
