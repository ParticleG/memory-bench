import type { Report } from './types';
import type { StudyReport } from '../../src/study';

export interface RunSummary {
  runId: string;
  status: string;
  createdAt: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: string;

  constructor(message: string, status: number, url: string, body: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export function reportPath(runId?: string | null): string {
  return runId ? `/api/report?run=${encodeURIComponent(runId)}` : '/api/report';
}

export function exportPath(format: 'json' | 'csv', runId: string): string {
  return `/api/export?format=${format}&run=${encodeURIComponent(runId)}`;
}

async function readError(response: Response, url: string): Promise<ApiError> {
  let body = '';
  try {
    body = (await response.text()).slice(0, 2000);
  } catch {
    body = '';
  }
  const suffix = body ? `: ${body}` : '';
  return new ApiError(
    `Request failed with HTTP ${response.status} for ${url}${suffix}`,
    response.status,
    url,
    body,
  );
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    cache: 'no-store',
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw await readError(response, url);
  try {
    return await response.json();
  } catch (error) {
    throw new ApiError(
      `Response from ${url} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      response.status,
      url,
      '',
    );
  }
}

/**
 * Keep the API boundary strict: a partially-shaped object is a server bug,
 * not something the dashboard silently pads with zeroes.
 */
function validateReport(value: unknown): asserts value is Report {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Report response is not a JSON object.');
  }
  const candidate = value as Partial<Report>;
  const requiredArrays = [
    'backends',
    'results',
    'answers',
    'usage',
    'aggregates',
    'limitations',
    'sources',
  ] as const;
  for (const key of requiredArrays) {
    if (!Array.isArray(candidate[key])) {
      throw new Error(`Report is missing the required "${key}" array.`);
    }
  }
  if (candidate.schemaVersion !== 1) {
    throw new Error(`Unsupported report schemaVersion: ${String(candidate.schemaVersion)}`);
  }
  if (typeof candidate.runId !== 'string' || candidate.runId.length === 0) {
    throw new Error('Report is missing runId.');
  }
  if (typeof candidate.status !== 'string') {
    throw new Error('Report is missing status.');
  }
  if (typeof candidate.config !== 'object' || candidate.config === null) {
    throw new Error('Report is missing config.');
  }
  if (typeof candidate.dataset !== 'object' || candidate.dataset === null) {
    throw new Error('Report is missing dataset.');
  }
  if (
    !Array.isArray(candidate.dataset.queries) ||
    !Array.isArray(candidate.dataset.corpora) ||
    !Array.isArray(candidate.dataset.facts)
  ) {
    throw new Error('Report dataset is missing corpora, facts, or queries.');
  }
  if (typeof candidate.environment !== 'object' || candidate.environment === null) {
    throw new Error('Report is missing environment.');
  }
}

export async function fetchReport(runId?: string | null): Promise<Report> {
  const url = reportPath(runId);
  const value = await getJson(url);
  validateReport(value);
  return value;
}

export async function fetchRuns(): Promise<RunSummary[]> {
  const value = await getJson('/api/runs');
  if (
    typeof value !== 'object' ||
    value === null ||
    !('runs' in value) ||
    !Array.isArray(value.runs)
  ) {
    throw new Error('Runs response is missing the required "runs" array.');
  }
  return value.runs.filter((run): run is RunSummary => {
    return (
      typeof run === 'object' &&
      run !== null &&
      'runId' in run &&
      typeof run.runId === 'string' &&
      'status' in run &&
      typeof run.status === 'string' &&
      'createdAt' in run &&
      typeof run.createdAt === 'string'
    );
  });
}

export async function fetchStudy(id: string): Promise<StudyReport> {
  const value = await getJson(`/api/study?study=${encodeURIComponent(id)}`);
  if (typeof value !== 'object' || value === null || !('rows' in value) || !Array.isArray(value.rows) || !('planned' in value) || !Array.isArray(value.planned)) {
    throw new Error('Study response is missing rows or planned experiments.');
  }
  return value as StudyReport;
}
