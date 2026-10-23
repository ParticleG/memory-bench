import { i18n } from './i18n';
import type { BackendRun, Report } from './types';

const PALETTE = [
  '#6aa7ff',
  '#4ad295',
  '#f5b84d',
  '#ff7a7a',
  '#b48cff',
  '#54d6d0',
  '#ff9f5a',
  '#8ac926',
  '#ff8bc9',
  '#9aa8ff',
  '#c7d44a',
  '#e07a5f',
];

export const STATUS_TONE: Record<string, 'complete' | 'running' | 'failed' | 'unavailable' | 'idle'> = {
  complete: 'complete',
  ingesting: 'running',
  evaluating: 'running',
  pending: 'idle',
  failed: 'failed',
  unavailable: 'unavailable',
};

export function backendName(report: Report, backendId: string): string {
  const name = report.backends.find((backend) => backend.id === backendId)?.name ?? backendId;
  return i18n.global.te(name) ? i18n.global.t(name) : name;
}

export function backendRun(report: Report, backendId: string): BackendRun | undefined {
  return report.backends.find((backend) => backend.id === backendId);
}

export function backendColorMap(report: Report): Record<string, string> {
  const ids: string[] = report.backends.map((backend) => backend.id);
  const seen = new Set(ids);
  const extras = new Set<string>();
  for (const result of report.results) extras.add(result.backend);
  for (const aggregate of report.aggregates) extras.add(aggregate.backend);
  for (const answer of report.answers) extras.add(answer.backend);
  for (const id of [...extras].sort()) {
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return Object.fromEntries(ids.map((id, index) => [id, PALETTE[index % PALETTE.length]]));
}

const MODE_LABELS: Record<string, string> = {
  'static-injection': 'Static injection · precomputed context read',
  'query-retrieval': 'Dynamic retrieval · per-query search',
  'observational-context': 'Observational memory context',
  control: 'Control · no memory',
};
const MODE_SHORT_LABELS: Record<string, string> = {
  'static-injection': 'Static injection',
  'query-retrieval': 'Dynamic retrieval',
  'observational-context': 'Observational context',
  control: 'Control',
};
const MODE_BADGES: Record<string, string> = {
  'static-injection': 'static read',
  'query-retrieval': 'dynamic search',
  'observational-context': 'observational',
  control: 'control',
};
const MODE_DESCRIPTIONS: Record<string, string> = {
  'static-injection': 'The adapter injects a precomputed memory context. Query-time latency is a static read and is not dynamic semantic search.',
  'query-retrieval': 'The adapter performs a dynamic per-query search over its memory store.',
  'observational-context': 'The adapter maintains an observational memory context and returns it for a query.',
  control: 'No-memory control. It measures the reader/judge path without a memory backend.',
};
const STATUS_LABELS: Record<string, string> = {
  complete: 'Complete', ingesting: 'Ingesting', evaluating: 'Evaluating', pending: 'Pending',
  failed: 'Failed', unavailable: 'Unavailable', unreported: 'Unreported', running: 'Running',
};

export function modeLabel(mode: string): string {
  const label = MODE_LABELS[mode];
  if (label) return i18n.global.t(label);
  if (mode.toLowerCase().includes('static')) return i18n.global.t('{mode} · static context read', { mode });
  return mode || i18n.global.t('Mode not reported');
}

export function modeShortLabel(mode: string): string {
  const label = MODE_SHORT_LABELS[mode];
  return label ? i18n.global.t(label) : mode || i18n.global.t('Mode not reported');
}

export function modeBadge(mode: string): string {
  return i18n.global.t(MODE_BADGES[mode] ?? (mode.toLowerCase().includes('static') ? 'static read' : 'mode'));
}

export function modeDescription(mode: string): string {
  const description = MODE_DESCRIPTIONS[mode];
  if (description) return i18n.global.t(description);
  return mode ? i18n.global.t('Adapter-reported mode: {mode}.', { mode }) : i18n.global.t('The adapter did not report a mode.');
}

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ? i18n.global.t(STATUS_LABELS[status]) : status;
}

export function categoryLabel(category: string): string {
  return i18n.global.te(category) ? i18n.global.t(category) : category;
}

export function languageLabel(language: string): string {
  return language === 'en' ? i18n.global.t('English') : language === 'zh' || language === 'zh-CN' ? i18n.global.t('Chinese') : language;
}

export function isStaticInjection(mode: string): boolean {
  return mode === 'static-injection' || mode.toLowerCase().includes('static');
}

export function statusTone(status: string): 'complete' | 'running' | 'failed' | 'unavailable' | 'idle' {
  return STATUS_TONE[status] ?? 'idle';
}
