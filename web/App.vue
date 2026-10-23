<script setup lang="ts">
import { computed, onMounted, ref, watchEffect } from 'vue';
import { useI18n } from 'vue-i18n';
import { statusLabel } from './lib/backend';
import {
  exportPath,
  fetchReport,
  fetchRuns,
  reportPath,
} from './lib/api';
import type { RunSummary } from './lib/api';
import { formatDate } from './lib/format';
import type { FilterState, Report } from './lib/types';
import SummaryPanel from './components/SummaryPanel.vue';
import BackendStatusStrip from './components/BackendStatusStrip.vue';
import FilterBar from './components/FilterBar.vue';
import ParetoPanel from './components/ParetoPanel.vue';
import CategoryHeatmap from './components/CategoryHeatmap.vue';
import LatencyPanel from './components/LatencyPanel.vue';
import BudgetPanel from './components/BudgetPanel.vue';
import AccuracyPanel from './components/AccuracyPanel.vue';
import ResourcePanel from './components/ResourcePanel.vue';
import QueryDrilldown from './components/QueryDrilldown.vue';
import StudyPanel from './components/StudyPanel.vue';

const { t, locale } = useI18n();
watchEffect(() => {
  document.documentElement.lang = locale.value;
  document.title = t('Memory Bench · Results');
});

const report = ref<Report | null>(null);
const runs = ref<RunSummary[]>([]);
const runsError = ref<string | null>(null);
const loading = ref(true);
const refreshing = ref(false);
const error = ref<string | null>(null);
const requestedUrl = ref('');
const initialRun = new URLSearchParams(window.location.search).get('run') || null;
const selectedRunId = ref<string | null>(initialRun);
const filters = ref<FilterState>({ backends: [], budget: null, category: null, language: null });
let loadSequence = 0;

const runOptions = computed<RunSummary[]>(() => {
  const options = runs.value.slice();
  const current = report.value;
  if (current && !options.some((run) => run.runId === current.runId)) {
    options.unshift({
      runId: current.runId,
      status: current.status,
      createdAt: current.createdAt,
    });
  }
  return options;
});

const runPickerValue = computed(() => selectedRunId.value ?? report.value?.runId ?? '');
const jsonHref = computed(() =>
  report.value ? exportPath('json', report.value.runId) : undefined,
);
const csvHref = computed(() =>
  report.value ? exportPath('csv', report.value.runId) : undefined,
);

async function loadRuns(): Promise<void> {
  try {
    runs.value = await fetchRuns();
    runsError.value = null;
  } catch (cause) {
    runsError.value = cause instanceof Error ? cause.message : String(cause);
  }
}

async function loadReport(runId: string | null): Promise<void> {
  const sequence = ++loadSequence;
  const firstLoad = report.value === null;
  if (firstLoad) loading.value = true;
  else refreshing.value = true;
  error.value = null;
  requestedUrl.value = reportPath(runId);
  try {
    const next = await fetchReport(runId);
    if (sequence !== loadSequence) return;
    const runChanged = report.value?.runId !== next.runId;
    report.value = next;
    selectedRunId.value = next.runId;
    if (runId === null) {
      const url = new URL(window.location.href);
      url.searchParams.delete('run');
      window.history.replaceState(null, '', url);
    }
    if (runChanged) {
      filters.value = {
        backends: next.backends.map((backend) => backend.id),
        budget: null,
        category: null,
        language: null,
      };
    }
  } catch (cause) {
    if (sequence !== loadSequence) return;
    error.value = cause instanceof Error ? cause.message : String(cause);
    const previous = report.value;
    if (previous) {
      selectedRunId.value = previous.runId;
      const url = new URL(window.location.href);
      url.searchParams.set('run', previous.runId);
      window.history.replaceState(null, '', url);
    }
  } finally {
    if (sequence === loadSequence) {
      loading.value = false;
      refreshing.value = false;
    }
  }
}

function onRunChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  if (!value) return;
  selectedRunId.value = value;
  const url = new URL(window.location.href);
  url.searchParams.set('run', value);
  window.history.replaceState(null, '', url);
  void loadReport(value);
}

function selectCategory(category: string): void {
  filters.value = {
    ...filters.value,
    category: filters.value.category === category ? null : category,
  };
}

onMounted(() => {
  void loadRuns();
  void loadReport(initialRun);
});
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true">MB</div>
        <div>
          <div class="brand-title">Memory Bench</div>
          <div class="brand-sub">{{ t('Report-driven long-term memory evaluation') }}</div>
        </div>
      </div>

      <div class="topbar-actions">
        <div class="run-picker">
          <label for="locale-select">{{ t('Language') }}</label>
          <select id="locale-select" v-model="locale" class="select" :aria-label="t('Interface language')">
            <option value="en">English</option>
            <option value="zh-CN">简体中文</option>
          </select>
        </div>
        <div v-if="runOptions.length > 0" class="run-picker">
          <label for="run-select">{{ t('Run') }}</label>
          <select
            id="run-select"
            class="select"
            :value="runPickerValue"
            :disabled="loading || refreshing"
            @change="onRunChange"
          >
            <option v-for="run in runOptions" :key="run.runId" :value="run.runId">
              {{ run.runId }} · {{ statusLabel(run.status) }} · {{ formatDate(run.createdAt) }}
            </option>
          </select>
        </div>
        <span v-else-if="report" class="badge mono" :title="report.runId">{{ report.runId }}</span>
        <span
          v-if="runsError"
          class="badge unavailable"
          :title="t('/api/runs unavailable: {error}', { error: runsError })"
        >
          {{ t('Run list unavailable') }}
        </span>

        <button
          class="btn"
          type="button"
          :disabled="loading || refreshing || !report"
          @click="report && loadReport(report.runId)"
        >
          {{ refreshing ? t('Refreshing…') : t('Refresh') }}
        </button>
        <a
          v-if="jsonHref"
          class="btn"
          :href="jsonHref"
          download
          :title="t('Download the raw report JSON served by the parent API')"
        >
          {{ t('Export JSON') }}
        </a>
        <a
          v-if="csvHref"
          class="btn"
          :href="csvHref"
          download
          :title="t('Download the long-form CSV export served by the parent API')"
        >
          {{ t('Export CSV') }}
        </a>
      </div>
    </header>

    <main v-if="loading && !report" class="loading-state">
      <span class="badge running">{{ t('Loading') }}</span>
      <h1 class="panel-title" style="margin-top: 12px">{{ t('Reading report…') }}</h1>
      <p class="muted" style="margin-top: 6px">
        {{ t('Fetching {url}. All measurements come from the selected run.', { url: requestedUrl || '/api/report' }) }}
      </p>
    </main>

    <main v-else-if="error && !report" class="error-state">
      <span class="badge failed">{{ t('Report unavailable') }}</span>
      <h1 class="panel-title" style="margin-top: 12px">{{ t('Could not load the benchmark report') }}</h1>
      <p class="muted" style="margin-top: 6px">
        {{ t('Requested {url}. The dashboard does not substitute sample data.', { url: requestedUrl }) }}
      </p>
      <pre>{{ error }}</pre>
      <div class="row" style="justify-content: center; margin-top: 16px">
        <button class="btn btn-primary" type="button" @click="loadReport(selectedRunId)">
          {{ t('Retry') }}
        </button>
        <button class="btn" type="button" @click="loadReport(null)">{{ t('Load latest report') }}</button>
      </div>
    </main>

    <main v-else-if="report" class="page">
      <div v-if="error" class="callout danger">
        {{ t('Refresh failed: {error}. Showing the previously loaded report.', { error }) }}
      </div>

      <section v-if="report.status === 'running'" class="status-banner running">
        <div class="status-banner-icon" aria-hidden="true">◐</div>
        <div>
          <strong>{{ t('Run in progress') }}</strong>
          <p>{{ t('Metrics reflect only records written so far. Pending, ingesting, evaluating, failed, and unavailable rows are shown explicitly, not treated as zero. Refresh to load new records.') }}</p>
        </div>
      </section>
      <section v-else-if="report.status === 'failed'" class="status-banner failed">
        <div class="status-banner-icon" aria-hidden="true">!</div>
        <div>
          <strong>{{ t('Run failed') }}</strong>
          <p>{{ t('Partial data is displayed exactly as recorded. Per-backend errors and runner limitations are listed below.') }}</p>
        </div>
      </section>

      <SummaryPanel :report="report" />
      <BackendStatusStrip :report="report" />
      <StudyPanel v-if="report.environment.study" :report="report" />
      <FilterBar
        :report="report"
        :filters="filters"
        @update:filters="filters = $event"
      />

      <div class="grid-2">
        <ParetoPanel :report="report" :filters="filters" />
        <CategoryHeatmap :report="report" :filters="filters" @select-category="selectCategory" />
      </div>

      <LatencyPanel :report="report" :filters="filters" />
      <BudgetPanel :report="report" :filters="filters" />
      <AccuracyPanel :report="report" :filters="filters" />
      <ResourcePanel :report="report" />
      <QueryDrilldown :report="report" :filters="filters" />

      <footer class="footer">
        <span>
          {{ t('Run') }} <span class="mono">{{ report.runId }}</span> · {{ t('Report schema') }} v{{ report.schemaVersion }}
          · {{ statusLabel(report.status) }} · {{ t('Created') }} {{ formatDate(report.createdAt) }}
        </span>
        <span>
          {{ t('Dataset') }} v{{ report.dataset.version }} ·
          {{ t('Corpora: {count}', { count: report.dataset.corpora.length }) }} ·
          {{ t('Gold facts: {count}', { count: report.dataset.facts.length }) }} ·
          {{ t('Queries: {count}', { count: report.dataset.queries.length }) }}
        </span>
        <span>
          {{ t('Values are read from {report}; JSON and CSV are served by {export}. No fabricated or vendor-published scores are shown.', { report: '/api/report', export: '/api/export' }) }}
        </span>
        <span class="muted">
          {{ t('Use Reset filters in the filter bar to clear the current selection.') }}
        </span>
      </footer>
    </main>
  </div>
</template>
