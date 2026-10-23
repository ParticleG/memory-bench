<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { languageLabel, statusLabel, statusTone } from '../lib/backend';
import { uniqueCategories, uniqueBudgets, uniqueLanguages } from '../lib/derive';
import {
  formatCount,
  formatDate,
  formatDurationMs,
  formatList,
} from '../lib/format';
import type { Report } from '../lib/types';

const props = defineProps<{
  report: Report;
}>();

const { t } = useI18n();
const datasetCounts = computed(() => {
  const dataset = props.report.dataset;
  const documents = dataset.corpora.reduce((total, corpus) => total + corpus.documents.length, 0);
  const messages = dataset.corpora.reduce(
    (total, corpus) =>
      total + corpus.documents.reduce((docTotal, document) => docTotal + document.messages.length, 0),
    0,
  );
  return {
    corpora: dataset.corpora.length,
    projects: new Set(dataset.corpora.map((corpus) => corpus.projectId)).size,
    documents,
    messages,
    facts: dataset.facts.length,
    queries: dataset.queries.length,
    answerable: dataset.queries.filter((query) => query.answerable).length,
    categories: uniqueCategories(props.report).length,
    languages: uniqueLanguages(props.report),
  };
});

const budgets = computed(() => uniqueBudgets(props.report));
const statusCounts = computed(() => {
  const counts = new Map<string, number>();
  for (const backend of props.report.backends) {
    counts.set(backend.status, (counts.get(backend.status) ?? 0) + 1);
  }
  return [...counts.entries()];
});

const duration = computed(() => {
  const composite = props.report.environment.reportKind === 'corrected-comparison';
  const startAt = composite ? props.report.environment.measurementWindowStartedAt : props.report.createdAt;
  const endAt = composite ? props.report.environment.measurementWindowFinishedAt : props.report.finishedAt;
  if (typeof startAt !== 'string' || typeof endAt !== 'string') return null;
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
});

const finishedLabel = computed(() => {
  if (props.report.finishedAt) return formatDate(props.report.finishedAt);
  return props.report.status === 'running' ? t('Not finished yet') : t('Not recorded');
});

const provenanceJson = computed(() => {
  const entries = Object.entries(props.report.dataset.provenance);
  return entries.length > 0 ? JSON.stringify(props.report.dataset.provenance, null, 2) : '';
});

const environmentKeys = computed(() => Object.keys(props.report.environment));

const budgetLabel = computed(() =>
  budgets.value.length > 0
    ? formatList(budgets.value.map(formatCount))
    : t('Unavailable'),
);
</script>

<template>
  <section class="summary-grid" :aria-label="t('Run summary')">
    <article class="summary-card">
      <h3>{{ t('Run') }}</h3>
      <div class="row" style="margin-bottom: 8px">
        <span class="badge" :class="statusTone(report.status)">{{ statusLabel(report.status) }}</span>
        <span class="badge">{{ t('Report schema') }} v{{ report.schemaVersion }}</span>
      </div>
      <div class="primary-value mono" style="font-size: 14px">{{ report.runId }}</div>
      <div class="run-meta" style="margin-top: 10px">
        <div class="run-meta-row">
          <span>{{ t('Created') }}</span>
          <span>{{ formatDate(report.createdAt) }}</span>
        </div>
        <div class="run-meta-row">
          <span>{{ t('Finished') }}</span>
          <span>{{ finishedLabel }}</span>
        </div>
        <div class="run-meta-row">
          <span>{{ report.environment.reportKind === 'corrected-comparison' ? t('Measurement window') : t('Recorded duration') }}</span>
          <span>{{ formatDurationMs(duration) }}</span>
        </div>
      </div>
    </article>

    <article class="summary-card">
      <h3>{{ t('Dataset') }}</h3>
      <div class="row" style="margin-bottom: 10px">
        <span class="badge accent">v{{ report.dataset.version }}</span>
        <span class="badge">{{ formatList(datasetCounts.languages.map(languageLabel)) }}</span>
      </div>
      <div class="metric-grid">
        <div class="metric">
          <div class="metric-label">{{ t('Corpora') }}</div>
          <div class="metric-value">{{ formatCount(datasetCounts.corpora) }}</div>
        </div>
        <div class="metric">
          <div class="metric-label">{{ t('Documents') }}</div>
          <div class="metric-value">{{ formatCount(datasetCounts.documents) }}</div>
        </div>
        <div class="metric">
          <div class="metric-label">{{ t('Messages') }}</div>
          <div class="metric-value">{{ formatCount(datasetCounts.messages) }}</div>
        </div>
        <div class="metric">
          <div class="metric-label">{{ t('Gold facts') }}</div>
          <div class="metric-value">{{ formatCount(datasetCounts.facts) }}</div>
        </div>
        <div class="metric">
          <div class="metric-label">{{ t('Queries') }}</div>
          <div class="metric-value">{{ formatCount(datasetCounts.queries) }}</div>
        </div>
        <div class="metric">
          <div class="metric-label">{{ t('Answerable') }}</div>
          <div class="metric-value">{{ formatCount(datasetCounts.answerable) }}</div>
        </div>
        <div class="metric">
          <div class="metric-label">{{ t('Categories') }}</div>
          <div class="metric-value">{{ formatCount(datasetCounts.categories) }}</div>
        </div>
        <div class="metric">
          <div class="metric-label">{{ t('Projects') }}</div>
          <div class="metric-value">{{ formatCount(datasetCounts.projects) }}</div>
        </div>
        <div class="metric">
          <div class="metric-label">{{ t('Config version') }}</div>
          <div class="metric-value mono" style="font-size: 11px">{{ report.config.datasetVersion || t('Unavailable') }}</div>
        </div>
      </div>
    </article>

    <article class="summary-card">
      <h3>{{ t('Evaluation config') }}</h3>
      <div class="metric-grid">
        <div class="metric">
          <div class="metric-label">{{ t('Budgets') }}</div>
          <div class="metric-value">{{ budgetLabel }}</div>
        </div>
        <div class="metric">
          <div class="metric-label">{{ t('Repeats') }}</div>
          <div class="metric-value">{{ formatCount(report.config.repeats) }}</div>
        </div>
        <div class="metric">
          <div class="metric-label">{{ t('Concurrency') }}</div>
          <div class="metric-value">{{ formatCount(report.config.concurrency) }}</div>
        </div>
        <div class="metric">
          <div class="metric-label">{{ t('Seed') }}</div>
          <div class="metric-value">{{ formatCount(report.config.seed) }}</div>
        </div>
        <div class="metric">
          <div class="metric-label">{{ t('Writer / reader') }}</div>
          <div class="metric-value mono" style="font-size: 11px">
            {{ report.config.model || t('Unavailable') }} / {{ report.config.readerModel || t('Unavailable') }}
          </div>
        </div>
        <div class="metric">
          <div class="metric-label">{{ t('Judge') }}</div>
          <div class="metric-value mono" style="font-size: 11px">
            {{ report.config.judgeModel || t('Unavailable') }}
          </div>
        </div>
        <div class="metric">
          <div class="metric-label">{{ t('Tokenizer') }}</div>
          <div class="metric-value mono" style="font-size: 11px">
            {{ report.config.tokenizer || t('Unavailable') }}
          </div>
        </div>
        <div class="metric">
          <div class="metric-label">{{ t('Usage records') }}</div>
          <div class="metric-value">{{ formatCount(report.usage.length) }}</div>
        </div>
      </div>
    </article>

    <article class="summary-card">
      <h3>{{ t('Backends') }}</h3>
      <div class="primary-value">{{ t('Reported: {count}', { count: formatCount(report.backends.length) }) }}</div>
      <div class="chip-row" style="margin-top: 9px">
        <span v-for="[status, count] in statusCounts" :key="status" class="badge" :class="statusTone(status)">
          {{ formatCount(count) }} {{ statusLabel(status) }}
        </span>
      </div>
      <div class="metric-grid" style="margin-top: 12px">
        <div class="metric">
          <div class="metric-label">{{ t('Result rows') }}</div>
          <div class="metric-value">{{ formatCount(report.results.length) }}</div>
        </div>
        <div class="metric">
          <div class="metric-label">{{ t('Aggregates') }}</div>
          <div class="metric-value">{{ formatCount(report.aggregates.length) }}</div>
        </div>
        <div class="metric">
          <div class="metric-label">{{ t('Answers') }}</div>
          <div class="metric-value">{{ formatCount(report.answers.length) }}</div>
        </div>
      </div>
      <p class="metric-note" style="margin-top: 10px">
        {{ t('Missing metrics remain unavailable; they are never rendered as zero.') }}
      </p>
    </article>
  </section>

  <section class="panel limitations" :aria-label="t('Limitations and provenance')">
    <div class="panel-head">
      <div>
        <h2 class="panel-title">{{ t('Limitations, metric scope & provenance') }}</h2>
        <p class="panel-sub">{{ t('Limitations, notes and provenance are report-supplied and preserved in their original language. Every plotted measurement comes from this run; no vendor-published benchmark scores are merged in.') }}</p>
      </div>
    </div>
    <div v-if="report.environment.reportKind === 'corrected-comparison'" class="callout warn" style="margin-bottom: 12px">
      <strong>{{ t('Corrected comparison:') }}</strong>
      {{ t('Local was remeasured after eligible native startup batches were drained. Unchanged methods retain original measurements; this is not one uninterrupted run. Environment records the source run for every backend. The initial startup-only Local result is superseded, not overwritten.') }}
    </div>


    <div class="callout warn">
      <strong>{{ t('Literal fact coverage:') }}</strong>
      {{ t('The recall field measures deterministic gold-alias atomic fact coverage, not general semantic recall or answer quality. QA accuracy is a separate reader/judge metric. Static-injection latency measures a precomputed-context read, not dynamic search.') }}
    </div>

    <div class="panel-section">
      <div class="panel-section-title">{{ t('Runner-reported limitations (original text)') }}</div>
      <ul v-if="report.limitations.length > 0">
        <li v-for="(limitation, index) in report.limitations" :key="index">{{ limitation }}</li>
      </ul>
      <p v-else class="muted">{{ t('The runner reported no limitations.') }}</p>
    </div>

    <div class="grid-2" style="margin-top: 14px">
      <details class="details">
        <summary>{{ t('Run config & notes') }}</summary>
        <div class="details-body">
          <dl class="detail-grid">
            <div class="kv">
              <dt>{{ t('Seed') }}</dt>
              <dd>{{ formatCount(report.config.seed) }}</dd>
            </div>
            <div class="kv">
              <dt>{{ t('Budgets') }}</dt>
              <dd>{{ budgetLabel }}</dd>
            </div>
            <div class="kv">
              <dt>{{ t('Repeats') }}</dt>
              <dd>{{ formatCount(report.config.repeats) }}</dd>
            </div>
            <div class="kv">
              <dt>{{ t('Concurrency') }}</dt>
              <dd>{{ formatCount(report.config.concurrency) }}</dd>
            </div>
            <div class="kv">
              <dt>{{ t('Writer') }}</dt>
              <dd>{{ report.config.model }}</dd>
            </div>
            <div class="kv">
              <dt>{{ t('Reader') }}</dt>
              <dd>{{ report.config.readerModel }}</dd>
            </div>
            <div class="kv">
              <dt>{{ t('Judge') }}</dt>
              <dd>{{ report.config.judgeModel }}</dd>
            </div>
            <div class="kv">
              <dt>{{ t('Tokenizer') }}</dt>
              <dd>{{ report.config.tokenizer }}</dd>
            </div>
            <div class="kv">
              <dt>{{ t('Dataset') }}</dt>
              <dd>{{ report.config.datasetVersion }}</dd>
            </div>
          </dl>
          <div v-if="report.config.notes.length > 0" style="margin-top: 12px">
            <div class="panel-section-title">{{ t('Notes (original text)') }}</div>
            <ul>
              <li v-for="(note, index) in report.config.notes" :key="index">{{ note }}</li>
            </ul>
          </div>
        </div>
      </details>

      <details class="details">
        <summary>{{ t('Dataset provenance (original data)') }}</summary>
        <div class="details-body">
          <pre v-if="provenanceJson" class="json-block">{{ provenanceJson }}</pre>
          <p v-else class="muted">{{ t('No dataset provenance was recorded.') }}</p>
          <p class="chart-note">{{ t('Provenance may describe an external public benchmark profile. External or vendor-published scores are not shown as measured values; all measurements come from this run.') }}</p>
        </div>
      </details>

      <details class="details">
        <summary>{{ t('Environment') }}</summary>
        <div class="details-body">
          <p v-if="environmentKeys.length > 0" class="small dim">
            {{ t('Reported environment keys: {count}', { count: formatCount(environmentKeys.length) }) }}
            <span class="mono">{{ environmentKeys.join(', ') }}</span>
          </p>
          <p v-else class="muted">{{ t('No environment metadata was recorded.') }}</p>
          <p class="chart-note">{{ t('Raw environment values are not rendered to avoid exposing secrets. The JSON export contains the runner-supplied environment object.') }}</p>
        </div>
      </details>

      <details class="details">
        <summary>{{ t('Sources') }}</summary>
        <div class="details-body">
          <div v-if="report.sources.length > 0" class="source-links">
            <a
              v-for="(source, index) in report.sources"
              :key="index"
              :href="source.url"
              target="_blank"
              rel="noreferrer noopener"
            >
              {{ source.label }}
            </a>
          </div>
          <p v-else class="muted">{{ t('No source links were reported.') }}</p>
        </div>
      </details>
    </div>
  </section>
</template>
