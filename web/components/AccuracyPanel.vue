<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import AxisScaleControls from './AxisScaleControls.vue';
import { isAxisValue, logAxisMin } from '../lib/axis';
import type { AxisScale } from '../lib/axis';
import type { BarSeriesOption } from 'echarts/charts';
import EChart from './EChart.vue';
import { backendColorMap, backendName } from '../lib/backend';
import { buildAccuracyRows, indexQueries } from '../lib/derive';
import { CHART_FONT, TOOLTIP_STYLE } from '../lib/echarts';
import type { DashboardOption } from '../lib/echarts';
import {
  escapeHtml,
  formatCount,
  formatMs,
  formatPercent,
  isNum,
} from '../lib/format';
import type { FilterState, Report } from '../lib/types';

const props = defineProps<{
  report: Report;
  filters: FilterState;
}>();

const { t } = useI18n();
const yScale = ref<AxisScale>('linear');
const colors = computed(() => backendColorMap(props.report));
const queries = computed(() => indexQueries(props.report.dataset));
const rows = computed(() => buildAccuracyRows(props.report, props.filters, queries.value));

const accuracyPoints = computed(() => rows.value.map((row) => ({
  ...row,
  effectiveAccuracy: row.source === 'runner' ? row.runnerAccuracy : row.accuracy,
  label: `${backendName(props.report, row.backend)} · B${formatCount(row.budget)}`,
})));
const chartRows = computed(() =>
  accuracyPoints.value.filter((row) => isAxisValue(row.effectiveAccuracy, yScale.value)),
);

const option = computed<DashboardOption>(() => {
  const yMin = yScale.value === 'log' ? logAxisMin(chartRows.value.map(row => row.effectiveAccuracy as number)) : 0;
  const series: BarSeriesOption[] = [
    {
      type: 'bar',
      name: t('QA accuracy'),
      barMaxWidth: 46,
      data: chartRows.value.map((row) => ({
        value: row.effectiveAccuracy as number,
        itemStyle: {
          color: colors.value[row.backend] ?? '#6aa7ff',
          borderRadius: [4, 4, 0, 0],
        },
      })),
      label: {
        show: true,
        position: 'top',
        color: '#b5c2d6',
        fontSize: 10,
        formatter: (params: unknown) => {
          const value = (params as { value?: unknown }).value;
          return isNum(value) ? formatPercent(value) : '';
        },
      },
    },
  ];

  return {
    animationDuration: 250,
    aria: { enabled: true },
    textStyle: { fontFamily: CHART_FONT, color: '#b5c2d6' },
    grid: { left: 56, right: 20, top: 28, bottom: 74, containLabel: true },
    tooltip: {
      trigger: 'item',
      ...TOOLTIP_STYLE,
      formatter: (params: unknown) => {
        const parameter = params as { dataIndex?: number };
        const row = chartRows.value[parameter.dataIndex ?? -1];
        if (!row || !isNum(row.effectiveAccuracy)) return '';
        return [
          `<strong>${escapeHtml(row.label)}</strong>`,
          t('QA accuracy: {value}', { value: formatPercent(row.effectiveAccuracy) }),
          t('Answers: {count}', { count: formatCount(row.nAnswers) }),
          t('Source: {value}', { value: row.source === 'runner' ? t('runner aggregate (no answer records)') : t('computed from AnswerResult records') }),
          t('Runner aggregate accuracy: {value}', { value: formatPercent(row.runnerAccuracy) }),
        ].join('<br/>');
      },
    },
    xAxis: {
      type: 'category',
      data: chartRows.value.map((row) => row.label),
      axisLabel: {
        color: '#9aabc2',
        fontSize: 10,
        interval: 0,
        rotate: chartRows.value.length > 4 ? 28 : 0,
      },
      axisLine: { lineStyle: { color: '#2b3850' } },
      axisTick: { show: false },
    },
    yAxis: {
      type: yScale.value === 'log' ? 'log' : 'value',
      logBase: 10,
      min: yMin,
      startValue: yMin,
      max: 1,
      name: t('QA accuracy'),
      nameTextStyle: { color: '#8192aa', fontSize: 11 },
      axisLabel: {
        color: '#8192aa',
        fontSize: 10,
        formatter: (value: string | number) => formatPercent(Number(value)),
      },
      axisLine: { lineStyle: { color: '#2b3850' } },
      splitLine: { lineStyle: { color: '#1b2535' } },
    },
    series,
  };
});
</script>

<template>
  <section class="panel chart-card" :aria-label="t('QA accuracy')" data-panel="accuracy">
    <div class="panel-head">
      <div>
        <h2 class="panel-title">{{ t('QA answer accuracy') }}</h2>
        <p class="panel-sub">{{ t('Reader/judge correctness over AnswerResult records, grouped by backend and budget. This is separate from literal coverage. Runner aggregate accuracy is used only when recorded and no answer records exist, and is labeled explicitly.') }}</p>
      </div>
      <div class="panel-head-side">
        <span class="badge">{{ t('Groups: {count}', { count: formatCount(rows.length) }) }}</span>
        <span class="badge">{{ t('Run-wide answer records: {count}', { count: formatCount(report.answers.length) }) }}</span>
      </div>
    </div>

    <AxisScaleControls v-model:y="yScale" :y-label="t('Y axis')" />

    <div v-if="rows.length === 0" class="chart-empty">
      {{
        report.answers.length === 0
          ? t('No AnswerResult records exist in this report. QA accuracy is unavailable; a runner aggregate is shown only when recorded and category/language is unfiltered.')
          : t('No answer records or runner accuracy rows match the current filters.')
      }}
    </div>
    <template v-else>
      <EChart
        v-if="chartRows.length > 0"
        :option="option"
        :height="310"
        :aria-label="t('Bar chart of QA answer accuracy by backend and budget')"
      />
      <p v-if="yScale === 'log' && accuracyPoints.some(row => isNum(row.effectiveAccuracy) && row.effectiveAccuracy <= 0)" class="chart-note">{{ t('Non-positive QA values are hidden only in the logarithmic chart. The table retains every scored group.') }}</p>
      <div class="table-wrap" style="margin-top: 12px">
        <table class="data-table">
          <thead>
            <tr>
              <th>{{ t('Backend') }}</th>
              <th class="numeric">{{ t('Budget') }}</th>
              <th>{{ t('Source') }}</th>
              <th class="numeric">{{ t('Answers') }}</th>
              <th class="numeric">{{ t('Correct') }}</th>
              <th class="numeric">{{ t('Computed accuracy') }}</th>
              <th class="numeric">{{ t('Abstained') }}</th>
              <th class="numeric">{{ t('Mean answer latency') }}</th>
              <th class="numeric">{{ t('Runner accuracy (all queries)') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="`${row.backend}-${row.budget}-${row.source}`">
              <td>{{ backendName(report, row.backend) }}</td>
              <td class="numeric">{{ formatCount(row.budget) }}</td>
              <td>
                <span class="badge" :class="row.source === 'runner' ? 'accent' : 'complete'">
                  {{ row.source === 'runner' ? t('runner aggregate') : t('answers') }}
                </span>
              </td>
              <td class="numeric">{{ formatCount(row.nAnswers) }}</td>
              <td class="numeric">{{ formatCount(row.nCorrect) }}</td>
              <td class="numeric">{{ formatPercent(row.accuracy) }}</td>
              <td class="numeric">{{ formatCount(row.nAbstained) }}</td>
              <td class="numeric">{{ formatMs(row.meanLatencyMs) }}</td>
              <td class="numeric">{{ formatPercent(row.runnerAccuracy) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <p class="chart-note">
      <strong>{{ t('Semantics:') }}</strong>
      {{ t('Accuracy is correct answers divided by answers in each backend/budget group. AnswerResult has no repeat/phase field. Runner accuracy covers all categories/languages. Missing answers remain unavailable, not zero. Successful latency is reader-only; evaluation errors include elapsed reader/judge time. Neither is retrieval latency.') }}
    </p>
    <p v-if="filters.category || filters.language" class="chart-note">
      <strong>{{ t('Filter note:') }}</strong>
      {{ t('Computed rows honor category/language filters; runner accuracy has no category/language breakdown.') }}
    </p>
  </section>
</template>
