<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  backendName,
  statusLabel,
  isStaticInjection,
  modeDescription,
  modeLabel,
  modeShortLabel,
  statusTone,
} from '../lib/backend';
import {
  meanNullable,
  summarizeUsage,
  summarizeUsageByPurpose,
} from '../lib/derive';
import type { UsageBreakdownRow, UsageTotals } from '../lib/derive';
import {
  formatBytes,
  formatCount,
  formatMs,
  formatUsd,
} from '../lib/format';
import type { BackendRun, Report, UsageRecord } from '../lib/types';

const props = defineProps<{
  report: Report;
}>();

const { t } = useI18n();
const expanded = ref<string[]>([]);

interface ResourceRow {
  backend: BackendRun;
  usageRecords: UsageRecord[];
  total: UsageTotals;
  breakdown: UsageBreakdownRow[];
  diagnosticsJson: string;
  resultCount: number;
  aggregateCount: number;
  answerCount: number;
}

function usageForBackend(backend: BackendRun): UsageRecord[] {
  const byId = props.report.usage.filter((record) => record.backend === backend.id);
  if (byId.length > 0) return byId;
  return props.report.usage.filter((record) => record.backend === backend.name);
}

const rows = computed<ResourceRow[]>(() =>
  props.report.backends.map((backend) => {
    const usageRecords = usageForBackend(backend);
    const hasDiagnostics = Object.keys(backend.diagnostics).length > 0;
    return {
      backend,
      usageRecords,
      total: summarizeUsage(usageRecords),
      breakdown: summarizeUsageByPurpose(usageRecords),
      diagnosticsJson: hasDiagnostics ? JSON.stringify(backend.diagnostics, null, 2) : '',
      resultCount: props.report.results.filter((result) => result.backend === backend.id).length,
      aggregateCount: props.report.aggregates.filter((aggregate) => aggregate.backend === backend.id)
        .length,
      answerCount: props.report.answers.filter((answer) => answer.backend === backend.id).length,
    };
  }),
);

interface ProviderUsageRow {
  backend: string;
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

const providerUsage = computed<ProviderUsageRow[]>(() => {
  const groups = new Map<string, UsageRecord[]>();
  for (const record of props.report.usage) {
    const key = `${record.backend}\u0000${record.purpose}\u0000${record.model}`;
    const group = groups.get(key);
    if (group) group.push(record);
    else groups.set(key, [record]);
  }
  const rows: ProviderUsageRow[] = [];
  for (const [key, group] of groups) {
    const [backend, purpose, model] = key.split('\u0000');
    const totals = summarizeUsage(group);
    rows.push({
      backend,
      purpose,
      model,
      records: totals.records,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cacheReadTokens: totals.cacheReadTokens,
      estimatedUsd: totals.estimatedUsd,
      meanLatencyMs: meanNullable(group.map((record) => record.latencyMs)).value,
      errors: totals.errors,
    });
  }
  return rows.sort(
    (a, b) =>
      a.backend.localeCompare(b.backend) ||
      a.purpose.localeCompare(b.purpose) ||
      a.model.localeCompare(b.model),
  );
});

const unmatchedUsage = computed(() => {
  const known = new Set<string>();
  for (const backend of props.report.backends) {
    known.add(backend.id);
    known.add(backend.name);
  }
  const unmatched = props.report.usage.filter((record) => !known.has(record.backend));
  return [...new Set(unmatched.map((record) => record.backend))].sort();
});

function toggle(backendId: string): void {
  expanded.value = expanded.value.includes(backendId)
    ? expanded.value.filter((id) => id !== backendId)
    : [...expanded.value, backendId];
}
</script>

<template>
  <section class="panel" :aria-label="t('Backend resources and usage')" data-panel="resources">
    <div class="panel-head">
      <div>
        <h2 class="panel-title">{{ t('Ingestion, storage, resources & usage') }}</h2>
        <p class="panel-sub">{{ t('Every reported backend is listed regardless of chart filters. Null resource fields remain unavailable. Usage totals cover the whole run because UsageRecord has no budget field. Diagnostics and provider labels retain their original values.') }}</p>
      </div>
      <div class="panel-head-side">
        <span class="badge">{{ t('Backends: {count}', { count: formatCount(rows.length) }) }}</span>
        <span class="badge">{{ t('Provider records: {count}', { count: formatCount(report.usage.length) }) }}</span>
        <span v-if="unmatchedUsage.length > 0" class="badge unavailable">
          {{ t('Unmatched usage labels: {count}', { count: formatCount(unmatchedUsage.length) }) }}
        </span>
      </div>
    </div>

    <div v-if="rows.length === 0" class="empty-inline">{{ t('The report contains no backend run rows.') }}</div>
    <div v-else class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>{{ t('Backend') }}</th>
            <th>{{ t('Mode') }}</th>
            <th>{{ t('Status') }}</th>
            <th class="numeric">{{ t('Ingest') }}</th>
            <th class="numeric">{{ t('Storage') }}</th>
            <th class="numeric">{{ t('Peak RSS') }}</th>
            <th class="numeric">{{ t('Usage calls') }}</th>
            <th class="numeric">{{ t('Input tokens') }}</th>
            <th class="numeric">{{ t('Output tokens') }}</th>
            <th class="numeric">{{ t('Cache read') }}</th>
            <th class="numeric">{{ t('Est. USD') }}</th>
            <th class="col-actions" />
          </tr>
        </thead>
        <tbody v-for="row in rows" :key="row.backend.id">
          <tr>
            <td>
              <div style="font-weight: 600">{{ backendName(report, row.backend.id) }}</div>
              <div class="tiny muted mono">{{ row.backend.id }}</div>
            </td>
            <td>
              <span class="badge" :class="{ static: isStaticInjection(row.backend.mode) }">
                {{ modeShortLabel(row.backend.mode) }}
              </span>
              <div
                class="tiny muted"
                style="max-width: 220px; white-space: normal; margin-top: 3px"
                :title="modeDescription(row.backend.mode)"
              >
                {{ modeLabel(row.backend.mode) }}
              </div>
            </td>
            <td class="wrap" style="max-width: 300px">
              <span class="badge" :class="statusTone(row.backend.status)">{{ statusLabel(row.backend.status) }}</span>
              <div v-if="row.backend.error" class="backend-error">{{ row.backend.error }}</div>
              <div class="tiny muted" style="margin-top: 3px">
                {{ t('Results: {results} · aggregates: {aggregates} · answers: {answers}', { results: formatCount(row.resultCount), aggregates: formatCount(row.aggregateCount), answers: formatCount(row.answerCount) }) }}
              </div>
            </td>
            <td class="numeric">{{ formatMs(row.backend.ingestMs) }}</td>
            <td class="numeric" :title="row.backend.storageBytes === null ? t('Unavailable') : t('{count} bytes', { count: formatCount(row.backend.storageBytes) })">
              {{ formatBytes(row.backend.storageBytes) }}
            </td>
            <td
              class="numeric"
              :title="row.backend.peakProcessRssBytes === null ? t('Unavailable') : t('{count} bytes', { count: formatCount(row.backend.peakProcessRssBytes) })"
            >
              {{ formatBytes(row.backend.peakProcessRssBytes) }}
            </td>
            <td class="numeric">{{ formatCount(row.total.records) }}</td>
            <td class="numeric" :title="t('Input-token reporting: {count} / {total} records', { count: formatCount(row.total.inputReported), total: formatCount(row.total.records) })">
              {{ formatCount(row.total.inputTokens) }}
            </td>
            <td class="numeric" :title="t('Output-token reporting: {count} / {total} records', { count: formatCount(row.total.outputReported), total: formatCount(row.total.records) })">
              {{ formatCount(row.total.outputTokens) }}
            </td>
            <td class="numeric" :title="t('Cache-read reporting: {count} / {total} records', { count: formatCount(row.total.cacheReported), total: formatCount(row.total.records) })">
              {{ formatCount(row.total.cacheReadTokens) }}
            </td>
            <td
              class="numeric"
              :title="t('Provider estimates reported: {count} / {total} records. This is not a bill.', { count: formatCount(row.total.usdReported), total: formatCount(row.total.records) })"
            >
              {{ formatUsd(row.total.estimatedUsd) }}
            </td>
            <td class="col-actions">
              <button
                class="btn btn-small"
                type="button"
                :aria-expanded="expanded.includes(row.backend.id)"
                @click="toggle(row.backend.id)"
              >
                {{ expanded.includes(row.backend.id) ? t('Hide') : t('Details') }}
              </button>
            </td>
          </tr>
          <tr v-if="expanded.includes(row.backend.id)">
            <td colspan="12" style="background: rgba(255, 255, 255, 0.012)">
              <div class="grid-2">
                <div>
                  <div class="panel-section-title">{{ t('Diagnostics (original data)') }}</div>
                  <pre v-if="row.diagnosticsJson" class="json-block">{{ row.diagnosticsJson }}</pre>
                  <p v-else class="muted small">{{ t('No diagnostics were recorded for this backend.') }}</p>
                  <div v-if="row.backend.error" class="callout danger" style="margin-top: 10px">
                    <strong>{{ t('Backend error:') }}</strong> {{ row.backend.error }}
                  </div>
                  <p class="chart-note">
                    {{ t('Models seen in usage: {models}. Purposes: {purposes}.', { models: row.total.models.length > 0 ? row.total.models.join(', ') : t('Unavailable'), purposes: row.total.purposes.length > 0 ? row.total.purposes.join(', ') : t('Unavailable') }) }}
                  </p>
                </div>
                <div>
                  <div class="panel-section-title">{{ t('Usage by purpose & model') }}</div>
                  <div v-if="row.breakdown.length > 0" class="table-wrap">
                    <table class="data-table">
                      <thead>
                        <tr>
                          <th>{{ t('Purpose') }}</th>
                          <th>{{ t('Model') }}</th>
                          <th class="numeric">{{ t('Calls') }}</th>
                          <th class="numeric">{{ t('Input') }}</th>
                          <th class="numeric">{{ t('Output') }}</th>
                          <th class="numeric">{{ t('Cache') }}</th>
                          <th class="numeric">{{ t('Est. USD') }}</th>
                          <th class="numeric">{{ t('Mean latency') }}</th>
                          <th class="numeric">{{ t('Errors') }}</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="item in row.breakdown" :key="`${item.purpose}-${item.model}`">
                          <td>{{ item.purpose }}</td>
                          <td class="mono">{{ item.model }}</td>
                          <td class="numeric">{{ formatCount(item.records) }}</td>
                          <td class="numeric">{{ formatCount(item.inputTokens) }}</td>
                          <td class="numeric">{{ formatCount(item.outputTokens) }}</td>
                          <td class="numeric">{{ formatCount(item.cacheReadTokens) }}</td>
                          <td class="numeric">{{ formatUsd(item.estimatedUsd) }}</td>
                          <td class="numeric">{{ formatMs(item.meanLatencyMs) }}</td>
                          <td class="numeric">{{ formatCount(item.errors) }}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <p v-else class="muted small">{{ t('No usage records for this backend.') }}</p>
                </div>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="panel-section">
      <div class="panel-head">
        <div>
          <h3 class="panel-title" style="font-size: 14px">{{ t('All provider usage records') }}</h3>
          <p class="panel-sub">{{ t('Grouped by raw UsageRecord.backend, purpose and model. Includes labels that do not match a backend-run ID or name, so no provider calls are hidden.') }}</p>
        </div>
      </div>
      <div v-if="providerUsage.length === 0" class="empty-inline">
        {{ t('No provider usage records were reported.') }}
      </div>
      <div v-else class="table-wrap scroll-y">
        <table class="data-table">
          <thead>
            <tr>
              <th>{{ t('Reported backend') }}</th>
              <th>{{ t('Purpose') }}</th>
              <th>{{ t('Model') }}</th>
              <th class="numeric">{{ t('Calls') }}</th>
              <th class="numeric">{{ t('Input') }}</th>
              <th class="numeric">{{ t('Output') }}</th>
              <th class="numeric">{{ t('Cache') }}</th>
              <th class="numeric">{{ t('Est. USD') }}</th>
              <th class="numeric">{{ t('Mean latency') }}</th>
              <th class="numeric">{{ t('Errors') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in providerUsage" :key="`${item.backend}-${item.purpose}-${item.model}`">
              <td class="mono">{{ item.backend }}</td>
              <td>{{ item.purpose }}</td>
              <td class="mono">{{ item.model }}</td>
              <td class="numeric">{{ formatCount(item.records) }}</td>
              <td class="numeric">{{ formatCount(item.inputTokens) }}</td>
              <td class="numeric">{{ formatCount(item.outputTokens) }}</td>
              <td class="numeric">{{ formatCount(item.cacheReadTokens) }}</td>
              <td class="numeric">{{ formatUsd(item.estimatedUsd) }}</td>
              <td class="numeric">{{ formatMs(item.meanLatencyMs) }}</td>
              <td class="numeric">{{ formatCount(item.errors) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="unmatchedUsage.length > 0" class="chart-note">
        <strong>{{ t('Unmatched usage labels:') }}</strong>
        {{ unmatchedUsage.join(', ') }}.
        {{ t('These calls are included above, but not assigned to backend resource rows because their label does not equal a reported backend ID or name.') }}
      </p>
    </div>

    <p class="chart-note">
      <strong>{{ t('Resource fields:') }}</strong>
      {{ t('Ingest duration, storage and peak process RSS are runner-reported. Usage sums exclude null token/USD values; header tooltips show reporting coverage. providerEstimatedUsd is a provider estimate, not billing reconciliation. Usage is not attributable to token budgets.') }}
    </p>
  </section>
</template>
