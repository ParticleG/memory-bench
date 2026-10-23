<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { StudyReport, StudyRow } from '../../src/study';
import type { Report } from '../lib/types';
import { fetchStudy } from '../lib/api';
import { statusLabel } from '../lib/backend';
import { isAxisValue, logAxisMin } from '../lib/axis';
import type { AxisScale } from '../lib/axis';
import { CHART_FONT, TOOLTIP_STYLE } from '../lib/echarts';
import type { DashboardOption } from '../lib/echarts';
import { escapeHtml, formatCount, formatDecimal, formatMs, formatPercent } from '../lib/format';
import AxisScaleControls from './AxisScaleControls.vue';
import EChart from './EChart.vue';

const props = defineProps<{ report: Report }>();
const { t } = useI18n();
const study = ref<StudyReport | null>(null);
const error = ref('');
const selectedProfile = ref('');
const paretoX = ref<AxisScale>('linear');
const paretoY = ref<AxisScale>('linear');
const scaleX = ref<AxisScale>('linear');
const scaleY = ref<AxisScale>('linear');
const stageX = ref<AxisScale>('linear');
const qualityMetric = ref<'coverage' | 'qaAccuracy'>('coverage');
const scaleMetric = ref<'anchorCoverage' | 'newCoverage' | 'anchorQa' | 'newQa' | 'anchorP50Ms' | 'newP50Ms' | 'anchorP95Ms' | 'newP95Ms'>('anchorCoverage');
const scaleIsLatency = computed(() => scaleMetric.value.endsWith('Ms'));
const colors: Record<string, string> = { hindsight: '#6aa7ff', mem0: '#4ad295' };
const variantLabels: Record<string, string> = {
  base: 'Baseline (mid CPU)', low: 'Low compute budget', rrf: 'No cross-encoder (RRF)',
  bucket: 'Same model, bucket batching', multilingual: 'Multilingual cross-encoder', scale: 'Same-bank scale test',
};
const scaleLabels: Record<string, string> = {
  anchorCoverage: 'Anchor fact coverage', newCoverage: 'New-question fact coverage',
  anchorQa: 'Anchor QA', newQa: 'New-question QA',
  anchorP50Ms: 'Anchor p50 latency (ms)', newP50Ms: 'New-question p50 latency (ms)',
  anchorP95Ms: 'Anchor p95 latency (ms)', newP95Ms: 'New-question p95 latency (ms)',
};
const keyOf = (row: StudyRow) => `${row.variant}:${row.backend}`;
const labelOf = (row: StudyRow) => `${row.backend === 'hindsight' ? 'Hindsight' : 'Mem0 OSS'} · ${t(variantLabels[row.variant] ?? row.variant)} · ${row.factor}×`;
const rows = computed(() => study.value?.rows ?? []);
const completed = computed(() => rows.value.filter(row => row.status === 'complete'));
const selectedRow = computed(() => rows.value.find(row => keyOf(row) === selectedProfile.value));
const summaryHref = computed(() => study.value ? `/api/study?study=${encodeURIComponent(study.value.id)}` : '');

watch(() => props.report, async (report, _, onCleanup) => {
  const metadata = report.environment.study as { id?: string } | undefined;
  if (!metadata?.id) return;
  let active = true;
  onCleanup(() => { active = false; });
  try {
    const next = await fetchStudy(metadata.id);
    if (!active) return;
    study.value = next;
    error.value = '';
    if (!next.rows.some(row => keyOf(row) === selectedProfile.value)) selectedProfile.value = next.rows[0] ? keyOf(next.rows[0]) : '';
  } catch (cause) {
    if (active) { study.value = null; error.value = String(cause); }
  }
}, { immediate: true });

const paretoRows = computed(() => completed.value.filter(row => isAxisValue(row.p95Ms, paretoX.value) && isAxisValue(row[qualityMetric.value], paretoY.value)));
const paretoOption = computed<DashboardOption>(() => ({
  aria: { enabled: true }, textStyle: { fontFamily: CHART_FONT, color: '#b5c2d6' },
  grid: { left: 65, right: 30, top: 25, bottom: 60, containLabel: true },
  tooltip: { ...TOOLTIP_STYLE, trigger: 'item', formatter: (raw: unknown) => {
    const row = paretoRows.value[(raw as { seriesIndex: number }).seriesIndex];
    return row ? `${escapeHtml(labelOf(row))}<br/>p95: ${formatMs(row.p95Ms)}<br/>${t('Literal fact coverage')}: ${formatPercent(row.coverage)}<br/>${t('QA accuracy')}: ${formatPercent(row.qaAccuracy)}` : '';
  } },
  xAxis: { type: paretoX.value === 'log' ? 'log' : 'value', name: t('p95 latency (ms)'), nameLocation: 'middle', nameGap: 35, min: paretoX.value === 'log' ? logAxisMin(paretoRows.value.map(row => row.p95Ms!)) : 0, axisLabel: { color: '#9aabc2' }, splitLine: { lineStyle: { color: '#243044' } } },
  yAxis: { type: paretoY.value === 'log' ? 'log' : 'value', min: paretoY.value === 'log' ? logAxisMin(paretoRows.value.map(row => row[qualityMetric.value]!)) : 0, max: 1, axisLabel: { color: '#9aabc2', formatter: (value: number) => formatPercent(value) }, splitLine: { lineStyle: { color: '#243044' } } },
  series: paretoRows.value.map(row => ({ type: 'scatter', name: labelOf(row), symbol: row.factor > 1 ? 'diamond' : 'circle', symbolSize: 12, itemStyle: { color: colors[row.backend] }, data: [[row.p95Ms!, row[qualityMetric.value]!]], label: { show: true, position: 'top', formatter: `${row.variant} ${row.factor}×`, color: '#b5c2d6', fontSize: 10 }, labelLayout: { hideOverlap: true } })),
}));

const scaleRows = computed(() => completed.value.filter(row => row.variant === 'base' || row.variant === 'scale'));
const scalePoints = computed(() => scaleRows.value.filter(row => isAxisValue(row.factor, scaleX.value) && isAxisValue(row[scaleMetric.value], scaleY.value)));
const scaleOption = computed<DashboardOption>(() => ({
  aria: { enabled: true }, textStyle: { fontFamily: CHART_FONT, color: '#b5c2d6' },
  grid: { left: 65, right: 25, top: 45, bottom: 60, containLabel: true },
  legend: { textStyle: { color: '#b5c2d6' } },
  tooltip: { ...TOOLTIP_STYLE, trigger: 'item', formatter: (raw: unknown) => {
    const item = raw as { seriesName: string; value: [number, number] };
    return `${escapeHtml(item.seriesName)} · ${item.value[0]}×<br/>${t(scaleLabels[scaleMetric.value])}: ${scaleIsLatency.value ? formatMs(item.value[1]) : formatPercent(item.value[1])}`;
  } },
  xAxis: { type: scaleX.value === 'log' ? 'log' : 'value', name: t('Documents per bank (multiple of baseline)'), nameLocation: 'middle', nameGap: 35, min: scaleX.value === 'log' ? logAxisMin(scalePoints.value.map(row => row.factor)) : 0, axisLabel: { color: '#9aabc2' }, splitLine: { lineStyle: { color: '#243044' } } },
  yAxis: { type: scaleY.value === 'log' ? 'log' : 'value', min: scaleY.value === 'log' ? logAxisMin(scalePoints.value.map(row => row[scaleMetric.value]!)) : 0, ...(!scaleIsLatency.value ? { max: 1 } : {}), axisLabel: { color: '#9aabc2', formatter: (value: number) => scaleIsLatency.value ? formatDecimal(value) : formatPercent(value) }, splitLine: { lineStyle: { color: '#243044' } } },
  series: ['hindsight', 'mem0'].map(backend => ({
    type: 'line', name: backend === 'hindsight' ? 'Hindsight' : 'Mem0 OSS', showSymbol: true, symbolSize: 10, connectNulls: false, itemStyle: { color: colors[backend] },
    data: scaleRows.value.filter(row => row.backend === backend).sort((a, b) => a.factor - b.factor).map(row => [row.factor, isAxisValue(row[scaleMetric.value], scaleY.value) ? row[scaleMetric.value] : null]),
  })),
}));

const stageRows = computed(() => selectedRow.value?.stages ?? []);
const stageOption = computed<DashboardOption>(() => ({
  aria: { enabled: true }, textStyle: { fontFamily: CHART_FONT, color: '#b5c2d6' },
  grid: { left: 20, right: 35, top: 35, bottom: 45, containLabel: true },
  legend: { textStyle: { color: '#b5c2d6' } },
  tooltip: { ...TOOLTIP_STYLE, trigger: 'item', formatter: (raw: unknown) => {
    const item = raw as { seriesName: string; value: [number, string] };
    return `${escapeHtml(item.value[1])}<br/>${item.seriesName}: ${formatMs(item.value[0])}`;
  } },
  xAxis: { type: stageX.value === 'log' ? 'log' : 'value', name: 'ms', min: stageX.value === 'log' ? logAxisMin(stageRows.value.flatMap(stage => [stage.p50Ms, stage.p95Ms])) : 0, axisLabel: { color: '#9aabc2' }, splitLine: { lineStyle: { color: '#243044' } } },
  yAxis: { type: 'category', inverse: true, data: stageRows.value.map(stage => stage.name), axisLabel: { color: '#9aabc2', fontSize: 11 }, axisTick: { show: false } },
  series: ([['p50', 'p50Ms'], ['p95', 'p95Ms']] as const).map(([name, field]) => ({ type: 'scatter', name, symbolSize: 9, data: stageRows.value.filter(stage => isAxisValue(stage[field], stageX.value)).map(stage => [stage[field], stage.name]) })),
}));

function exportStudyCsv() {
  const columns = ['runId', 'variant', 'factor', 'backend', 'status', 'memoriesPerCorpus', 'coverage', 'anchorCoverage', 'newCoverage', 'qaAccuracy', 'anchorQa', 'newQa', 'p50Ms', 'p95Ms', 'anchorP50Ms', 'anchorP95Ms', 'newP50Ms', 'newP95Ms', 'warmRequests', 'contextTokens', 'candidateMatch'] as const;
  const quote = (value: unknown) => `"${(value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)).replaceAll('"', '""')}"`;
  const csv = [columns.join(','), ...rows.value.map(row => columns.map(column => quote(row[column])).join(','))].join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = `${study.value?.id ?? 'study'}.csv`; link.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <section class="panel" data-panel="study" :aria-label="t('Recall ablation and scale study')">
    <div class="panel-head">
      <div><h2 class="panel-title">{{ t('Recall ablation and scale study') }}</h2><p class="panel-subtitle">{{ t('Cross-run comparison at 4096 tokens. Dashboard filters below apply to the individual run, not this study.') }}</p></div>
      <div v-if="study" class="row"><a class="btn" :href="summaryHref" :download="`${study.id}.json`">{{ t('Export JSON') }}</a><button class="btn" @click="exportStudyCsv">{{ t('Export CSV') }}</button></div>
    </div>
    <p v-if="error" class="callout danger">{{ error }}</p>
    <template v-if="study">
      <p v-if="study.smoke" class="callout danger">{{ t('Integration smoke only; do not rank systems using these samples.') }}</p>
      <div class="row"><span v-for="item in study.planned" :key="item.key" class="badge" :class="item.status">{{ t(variantLabels[item.key] ?? item.key) }} · {{ statusLabel(item.status) }}</span></div>
      <p class="chart-note">{{ t('Scatter points and table QA/latency use the full query set of each run. Use anchor scale metrics for paired growth comparisons.') }}</p>
      <div v-if="rows.length" class="grid-2">
        <section class="chart-card">
          <h3>{{ t('Quality versus latency across variants') }}</h3>
          <label>{{ t('Metric') }} <select v-model="qualityMetric" class="select"><option value="coverage">{{ t('Literal fact coverage') }}</option><option value="qaAccuracy">{{ t('QA accuracy') }}</option></select></label>
          <AxisScaleControls v-model:x="paretoX" v-model:y="paretoY" :x-label="t('X axis')" :y-label="t('Y axis')" />
          <EChart :option="paretoOption" :aria-label="t('Quality versus latency across variants')" />
          <p class="chart-note">{{ t('Plotted: {count}', { count: paretoRows.length }) }} · {{ t('Unplotted: {count}', { count: completed.length - paretoRows.length }) }}</p>
        </section>
        <section class="chart-card">
          <h3>{{ t('Same-bank scale sensitivity') }}</h3>
          <label>{{ t('Metric') }} <select v-model="scaleMetric" class="select"><option v-for="(label, key) in scaleLabels" :key="key" :value="key">{{ t(label) }}</option></select></label>
          <AxisScaleControls v-model:x="scaleX" v-model:y="scaleY" :x-label="t('X axis')" :y-label="t('Y axis')" />
          <EChart :option="scaleOption" :aria-label="t('Same-bank scale sensitivity')" />
          <p class="chart-note">{{ t('Anchor questions remain unchanged. New questions cover added memories; do not compare their difficulty as if they were paired anchors.') }}</p>
          <p class="chart-note">{{ t('Unplotted: {count}', { count: scaleRows.length - scalePoints.length }) }}</p>
        </section>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>{{ t('Variant') }}</th><th>{{ t('Memories per bank') }}</th><th>{{ t('Anchor fact coverage') }}</th><th>{{ t('New-question fact coverage') }}</th><th>{{ t('Overall QA') }}</th><th>{{ t('Overall p50') }}</th><th>{{ t('Overall p95') }}</th><th>{{ t('Warm samples') }}</th><th>{{ t('Identical candidate sets') }}</th></tr></thead>
          <tbody><tr v-for="row in rows" :key="row.runId + row.backend"><td><a :href="`?run=${encodeURIComponent(row.runId)}`">{{ labelOf(row) }}</a><div>{{ statusLabel(row.status) }}</div><details v-if="row.error" class="danger"><summary>{{ t('Reason') }}</summary><pre>{{ row.error }}</pre></details></td><td>{{ row.memoriesPerCorpus.map(formatCount).join(' / ') }}</td><td class="numeric">{{ formatPercent(row.anchorCoverage) }}</td><td class="numeric">{{ formatPercent(row.newCoverage) }}</td><td class="numeric" :title="`${t('Anchor QA')}: ${formatPercent(row.anchorQa)}; ${t('New-question QA')}: ${formatPercent(row.newQa)}`">{{ formatPercent(row.qaAccuracy) }}</td><td class="numeric">{{ formatMs(row.p50Ms) }}</td><td class="numeric">{{ formatMs(row.p95Ms) }}</td><td class="numeric">{{ formatCount(row.warmRequests) }}</td><td>{{ row.candidateMatch ? `${row.candidateMatch.matched}/${row.candidateMatch.total}` : '—' }}</td></tr></tbody>
        </table>
      </div>
      <template v-if="rows.length">
        <h3>{{ t('Native stage timings (separate diagnostic requests)') }}</h3>
        <label>{{ t('Variant') }} <select v-model="selectedProfile" class="select"><option v-for="row in rows" :key="keyOf(row)" :value="keyOf(row)">{{ labelOf(row) }}</option></select></label>
        <AxisScaleControls v-model:x="stageX" :x-label="t('X axis')" />
        <EChart :option="stageOption" :height="Math.max(260, stageRows.length * 28 + 90)" :aria-label="t('Native stage timings (separate diagnostic requests)')" />
        <p class="chart-note">{{ t('Parallel and nested stages overlap. Do not sum stage percentiles or interpret diagnostic requests as ordinary end-to-end latency.') }}</p>
        <p v-if="stageX === 'log'" class="chart-note">{{ t('Unplotted: {count}', { count: stageRows.flatMap(stage => [stage.p50Ms, stage.p95Ms]).filter(value => !isAxisValue(value, stageX)).length }) }}</p>
        <a v-if="selectedRow" class="btn" :href="`/api/profiles?run=${encodeURIComponent(selectedRow.runId)}`" :download="`${selectedRow.runId}-profiles.jsonl`">{{ t('Download raw profiles') }}</a>
        <details v-if="selectedRow"><summary>{{ t('Stage values and candidate counts') }}</summary><div class="table-wrap"><table class="data-table"><thead><tr><th>{{ t('Stage') }}</th><th>{{ t('Mean') }}</th><th>p50</th><th>p95</th><th>{{ t('Nested diagnostic') }}</th></tr></thead><tbody><tr v-for="stage in stageRows" :key="stage.name"><td>{{ stage.name }}</td><td>{{ formatMs(stage.meanMs) }}</td><td>{{ formatMs(stage.p50Ms) }}</td><td>{{ formatMs(stage.p95Ms) }}</td><td>{{ t(stage.diagnostic ? 'yes' : 'no') }}</td></tr></tbody></table></div><dl><template v-for="(count, name) in selectedRow.candidates" :key="name"><dt>{{ name }}</dt><dd>{{ formatDecimal(count) }}</dd></template></dl><pre v-if="selectedRow.candidateMatch?.differingQueries.length">{{ selectedRow.candidateMatch.differingQueries }}</pre></details>
      </template>
      <details><summary>{{ t('Study protocol and limitations') }}</summary><ul><li v-for="note in study.notes" :key="note">{{ note }}</li></ul></details>
    </template>
  </section>
</template>
