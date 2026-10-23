<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  backendName,
  statusLabel,
  isStaticInjection,
  modeBadge,
  modeDescription,
  modeLabel,
  statusTone,
} from '../lib/backend';
import { formatCount } from '../lib/format';
import type { Report } from '../lib/types';

const props = defineProps<{
  report: Report;
}>();

const { t } = useI18n();
const statusCounts = computed(() => {
  const counts = new Map<string, number>();
  for (const backend of props.report.backends) {
    counts.set(backend.status, (counts.get(backend.status) ?? 0) + 1);
  }
  return [...counts.entries()];
});

function resultCount(backendId: string): number {
  return props.report.results.filter((result) => result.backend === backendId).length;
}

function aggregateCount(backendId: string): number {
  return props.report.aggregates.filter((aggregate) => aggregate.backend === backendId).length;
}

function answerCount(backendId: string): number {
  return props.report.answers.filter((answer) => answer.backend === backendId).length;
}
</script>

<template>
  <section class="panel" :aria-label="t('Backend status')" data-panel="backend-status">
    <div class="panel-head">
      <div>
        <h2 class="panel-title">{{ t('Backend status & measurement mode') }}</h2>
        <p class="panel-sub">{{ t('Every reported backend is listed, including pending, unavailable, and failed runs. Status and mode are adapter/runner-reported; nothing is inferred from missing measurements.') }}</p>
      </div>
      <div class="panel-head-side">
        <span v-for="[status, count] in statusCounts" :key="status" class="badge" :class="statusTone(status)">
          {{ formatCount(count) }} {{ statusLabel(status) }}
        </span>
      </div>
    </div>

    <div v-if="report.backends.length === 0" class="empty-inline">
      {{ t('The report contains no backend run rows.') }}
    </div>
    <div v-else class="status-strip">
      <article v-for="backend in report.backends" :key="backend.id" class="backend-card">
        <div class="backend-card-head">
          <span class="dot" :class="statusTone(backend.status)" />
          <span class="backend-name" :title="backend.name">{{ backendName(report, backend.id) }}</span>
          <span class="spacer" />
          <span class="badge" :class="statusTone(backend.status)">{{ statusLabel(backend.status) }}</span>
        </div>
        <div class="backend-mode">
          <span class="badge" :class="{ static: isStaticInjection(backend.mode) }" style="margin-right: 5px">
            {{ modeBadge(backend.mode) }}
          </span>
          <span :title="modeDescription(backend.mode)">{{ modeLabel(backend.mode) }}</span>
        </div>
        <div class="backend-mode">
          {{ t('Results: {results} · aggregates: {aggregates} · answers: {answers}', { results: formatCount(resultCount(backend.id)), aggregates: formatCount(aggregateCount(backend.id)), answers: formatCount(answerCount(backend.id)) }) }}
        </div>
        <div v-if="backend.error" class="backend-error">{{ backend.error }}</div>
      </article>
    </div>

    <p class="chart-note">
      <strong>{{ t('Static injection vs dynamic search:') }}</strong>
      {{ t('Static injection returns precomputed context; near-zero read latency is not evidence of fast semantic search. Dynamic retrieval searches per query; first-query and warm samples are separated in the latency panel.') }}
    </p>
  </section>
</template>
