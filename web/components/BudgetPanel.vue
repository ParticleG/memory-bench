<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import AxisScaleControls from './AxisScaleControls.vue';
import { isAxisValue, logAxisMin } from '../lib/axis';
import type { AxisScale } from '../lib/axis';
import type { Aggregate } from '../lib/types';
import type { CustomSeriesOption, LineSeriesOption } from 'echarts/charts';
import EChart from './EChart.vue';
import {
  backendColorMap,
  backendName,
  backendRun,
  isStaticInjection,
  statusTone,
  statusLabel,
} from '../lib/backend';
import {
  buildMetricPoints,
  computeScopeMetrics,
  filterResults,
  uniqueBudgets,
} from '../lib/derive';
import type { ScopeMetrics } from '../lib/derive';
import {
  CHART_FONT,
  TOOLTIP_STYLE,
  verticalCiRenderer,
} from '../lib/echarts';
import type { DashboardOption } from '../lib/echarts';
import {
  escapeHtml,
  formatCi,
  formatCount,
  formatDecimal,
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
const xScale = ref<AxisScale>('linear');
const yScale = ref<AxisScale>('linear');
const colors = computed(() => backendColorMap(props.report));
const chartFilters = computed<FilterState>(() => ({ ...props.filters, budget: null }));
const points = computed(() => buildMetricPoints(props.report, chartFilters.value));
const plotted = computed(() => points.value.filter(point => isAxisValue(point.budget, xScale.value) && isAxisValue(point.coverage, yScale.value)));
const missingPoints = computed(() =>
  points.value.filter(point => !isAxisValue(point.budget, xScale.value) || !isAxisValue(point.coverage, yScale.value)),
);
const computedSources = computed(() => plotted.value.filter((point) => point.source === 'computed'));
const staticBackends = computed(() =>
  props.report.backends.filter(
    (backend) => props.filters.backends.includes(backend.id) && isStaticInjection(backend.mode),
  ),
);
const hiddenCiCount = computed(() => plotted.value.filter(point =>
  point.coverageCi && (!isAxisValue(point.coverageCi[0], yScale.value) || !isAxisValue(point.coverageCi[1], yScale.value)),
).length);

const xMax = computed(() => {
  const max = plotted.value.reduce((value, point) => Math.max(value, point.budget), 0);
  return max > 0 ? max * 1.05 : 1;
});

const chartOption = computed<DashboardOption>(() => {
  const series: Array<LineSeriesOption | CustomSeriesOption> = [];
  const legend: string[] = [];
  const palette: string[] = [];
  const byBackend = new Map<string, typeof plotted.value>();
  for (const point of points.value) {
    if (!isAxisValue(point.budget, xScale.value)) continue;
    const list = byBackend.get(point.backend);
    if (list) list.push(point);
    else byBackend.set(point.backend, [point]);
  }

  for (const [backend, rows] of byBackend) {
    if (!rows.some(point => isAxisValue(point.coverage, yScale.value))) continue;
    const name = backendName(props.report, backend);
    const color = colors.value[backend] ?? '#6aa7ff';
    legend.push(name);
    palette.push(color);
    series.push({
      type: 'line',
      name,
      color,
      data: rows.map((point) => [
        point.budget,
        isAxisValue(point.coverage, yScale.value) ? point.coverage : null,
        point.nQueries ?? t('Unavailable'),
        point.nRequests ?? t('Unavailable'),
        point.source,
        point.coverageCi?.[0] ?? t('Unavailable'),
        point.coverageCi?.[1] ?? t('Unavailable'),
      ]),
      symbolSize: 7,
      connectNulls: false,
      lineStyle: { color, width: 2 },
      itemStyle: { color, borderColor: '#080b11', borderWidth: 1 },
      emphasis: { focus: 'series' },
      z: 3,
    });

    const ciRows = rows.filter(
      (point) =>
        isAxisValue(point.coverage, yScale.value) &&
        point.coverageCi !== null &&
        isAxisValue(point.coverageCi[0], yScale.value) &&
        isAxisValue(point.coverageCi[1], yScale.value),
    );
    if (ciRows.length > 0) {
      series.push({
        type: 'custom',
        name: `${name} CI`,
        z: 2,
        silent: true,
        color,
        data: ciRows.map((point) => [
          point.budget,
          point.coverageCi?.[0] as number,
          point.coverageCi?.[1] as number,
        ]),
        renderItem: verticalCiRenderer(color),
      });
    }
  }

  return {
    animationDuration: 280,
    aria: { enabled: true },
    color: palette,
    textStyle: { fontFamily: CHART_FONT, color: '#b5c2d6' },
    grid: { left: 60, right: 24, top: 48, bottom: 56, containLabel: true },
    legend: {
      data: legend,
      type: 'scroll',
      top: 0,
      left: 0,
      icon: 'roundRect',
      itemWidth: 12,
      itemHeight: 3,
      textStyle: { color: '#b5c2d6', fontSize: 10 },
    },
    tooltip: {
      trigger: 'item',
      ...TOOLTIP_STYLE,
      formatter: (params: unknown) => {
        const parameter = params as { seriesName?: string; data?: unknown };
        const data = parameter.data;
        if (!Array.isArray(data)) return '';
        const budget = data[0];
        const coverage = data[1];
        const nQueries = data[2];
        const nRequests = data[3];
        const source = data[4];
        const ciLow = data[5];
        const ciHigh = data[6];
        if (!isNum(budget) || !isNum(coverage)) return '';
        const cdf =
          isNum(ciLow) && isNum(ciHigh)
            ? t('{value} (CI {low} – {high})', { value: formatPercent(coverage), low: formatPercent(ciLow), high: formatPercent(ciHigh) })
            : t('{value} (CI unavailable)', { value: formatPercent(coverage) });
        return [
          `<strong>${escapeHtml(parameter.seriesName ?? '')}</strong>`,
          t('Budget: {value}', { value: t('{count} tokens', { count: formatCount(budget) }) }),
          t('Literal fact coverage: {value}', { value: cdf }),
          t('Samples: {value}', { value: `nQueries=${isNum(nQueries) ? formatCount(nQueries) : t('Unavailable')}, nRequests=${isNum(nRequests) ? formatCount(nRequests) : t('Unavailable')}` }),
          t('Source: {value}', { value: source === 'runner' ? t('runner aggregate') : source === 'computed' ? t('computed subset (macro)') : t('No measurement') }),
        ].join('<br/>');
      },
    },
    xAxis: {
      type: xScale.value === 'log' ? 'log' : 'value',
      logBase: 10,
      min: xScale.value === 'log' ? logAxisMin(plotted.value.map(point => point.budget)) : 0,
      max: xScale.value === 'log' ? undefined : xMax.value,
      name: t('Token budget'),
      nameLocation: 'middle',
      nameGap: 32,
      nameTextStyle: { color: '#8192aa', fontSize: 11 },
      axisLabel: {
        color: '#8192aa',
        fontSize: 10,
        formatter: (value: string | number) => formatCount(Number(value)),
      },
      axisLine: { lineStyle: { color: '#2b3850' } },
      splitLine: { lineStyle: { color: '#1b2535' } },
    },
    yAxis: {
      type: yScale.value === 'log' ? 'log' : 'value',
      logBase: 10,
      min: yScale.value === 'log' ? logAxisMin(plotted.value.flatMap(point => point.coverageCi && point.coverageCi[0] > 0 ? [point.coverage as number, point.coverageCi[0]] : [point.coverage as number])) : 0,
      max: 1,
      name: t('Literal fact coverage'),
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

interface AggregateRow {
  backend: string;
  budget: number;
  aggregate: Aggregate | undefined;
  metrics: ScopeMetrics;
}

const aggregateRows = computed<AggregateRow[]>(() => {
  const budgets =
    props.filters.budget === null ? uniqueBudgets(props.report) : [props.filters.budget];
  const rows: AggregateRow[] = [];
  for (const backend of props.filters.backends) {
    for (const budget of budgets) {
      const aggregate = props.report.aggregates.find(
        (item) => item.backend === backend && item.budget === budget,
      );
      const results = filterResults(props.report.results, {
        ...props.filters,
        backends: [backend],
        budget,
      });
      if (!aggregate && results.length === 0) continue;
      rows.push({
        backend,
        budget,
        aggregate,
        metrics: computeScopeMetrics(results),
      });
    }
  }
  return rows.sort(
    (a, b) =>
      backendName(props.report, a.backend).localeCompare(backendName(props.report, b.backend)) ||
      a.budget - b.budget,
  );
});
</script>

<template>
  <section class="panel chart-card" :aria-label="t('Coverage versus token budget')" data-panel="budget">
    <div class="panel-head">
      <div>
        <h2 class="panel-title">{{ t('Literal fact coverage vs token budget') }}</h2>
        <p class="panel-sub">{{ t('One series per backend across every recorded token budget. This chart deliberately ignores the budget selector so the full trend stays visible; the table below honors it.') }}</p>
      </div>
      <div class="panel-head-side">
        <span class="badge">{{ t('Plotted: {count}', { count: formatCount(plotted.length) }) }}</span>
        <span v-if="missingPoints.length > 0" class="badge unavailable">{{ t('Unplotted: {count}', { count: formatCount(missingPoints.length) }) }}</span>
      </div>
    </div>

    <AxisScaleControls v-model:x="xScale" v-model:y="yScale" :x-label="t('X axis')" :y-label="t('Y axis')" />
    <p v-if="hiddenCiCount > 0" class="chart-note">{{ t('{count} confidence intervals have non-positive endpoints and cannot be drawn on the logarithmic axis. Original intervals remain in tooltips and tables.', { count: formatCount(hiddenCiCount) }) }}</p>

    <div v-if="filters.backends.length === 0" class="chart-empty">{{ t('No backends selected.') }}</div>
    <div v-else-if="plotted.length === 0" class="chart-empty">
      {{ t('No backend/budget point can be displayed on these axes. Missing values and non-positive logarithmic coordinates are not fabricated.') }}
    </div>
    <EChart
      v-else
      :option="chartOption"
      :height="360"
      :aria-label="t('Line chart of literal fact coverage across token budgets')"
    />

    <p class="chart-note">
      <strong>{{ t('Source:') }}</strong>
      {{ t('Runner aggregates cover every budget when category/language is unfiltered; otherwise a macro mean is recomputed from raw QueryResult rows. CI bars are runner-supplied bootstrap intervals clustered by corpus.') }}
      <template v-if="computedSources.length > 0">
        <strong>{{ t('Computed subset points without CI: {count}', { count: formatCount(computedSources.length) }) }}</strong>
      </template>
    </p>
    <p v-if="staticBackends.length > 0" class="chart-note">
      <strong>{{ t('Static injection:') }}</strong>
      {{ staticBackends.map((backend) => backendName(report, backend.id)).join(', ') }}
      {{ t('do not search at query time; only their precomputed context coverage is measured here.') }}
    </p>

    <details v-if="missingPoints.length > 0" class="details" style="margin-top: 10px">
      <summary>{{ t('Not plotted: {count} backend/budget combinations', { count: formatCount(missingPoints.length) }) }}</summary>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>{{ t('Backend') }}</th>
              <th class="numeric">{{ t('Budget') }}</th>
              <th>{{ t('Status') }}</th>
              <th>{{ t('Reason') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(point, index) in missingPoints" :key="`${point.backend}-${point.budget}-${index}`">
              <td>{{ backendName(report, point.backend) }}</td>
              <td class="numeric">{{ formatCount(point.budget) }}</td>
              <td>
                <span class="badge" :class="statusTone(backendRun(report, point.backend)?.status ?? 'unreported')">
                  {{ statusLabel(backendRun(report, point.backend)?.status ?? 'unreported') }}
                </span>
              </td>
              <td class="wrap">
                {{
                  isNum(point.coverage) && point.coverage <= 0 && yScale === 'log'
                    ? t('Coverage is non-positive and cannot be displayed on a logarithmic Y axis.')
                    : point.budget <= 0 && xScale === 'log'
                      ? t('Budget is non-positive and cannot be displayed on a logarithmic X axis.')
                      : point.source === 'runner'
                        ? t('Runner aggregate coverage is null.')
                        : point.source === 'computed'
                          ? t('No non-null subset coverage samples.')
                          : t('No aggregate or query result rows.')
                }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </details>

    <div class="panel-section">
      <div class="panel-head">
        <div>
          <h3 class="panel-title" style="font-size: 14px">{{ t('Aggregate metrics & sample counts') }}</h3>
          <p class="panel-sub">{{ t('Runner columns are the exact Report.aggregates values. Computed subset columns are recalculated from QueryResults and labeled separately. Unavailable values stay unavailable.') }}</p>
        </div>
      </div>

      <div v-if="aggregateRows.length === 0" class="empty-inline">
        {{ t('No aggregate or query-result rows exist for the selected backend/budget scope.') }}
      </div>
      <div v-else class="table-wrap scroll-y">
        <table class="data-table">
          <thead>
            <tr>
              <th>{{ t('Backend') }}</th>
              <th class="numeric">{{ t('Budget') }}</th>
              <th class="numeric">nQueries</th>
              <th class="numeric">nRequests</th>
              <th>{{ t('Literal coverage (runner, CI)') }}</th>
              <th class="numeric">{{ t('Complete evidence') }}</th>
              <th class="numeric">{{ t('Evidence precision') }}</th>
              <th class="numeric">p50</th>
              <th class="numeric">p95</th>
              <th class="numeric">{{ t('Error rate') }}</th>
              <th class="numeric">{{ t('Stale rate') }}</th>
              <th class="numeric">{{ t('Scope leak') }}</th>
              <th class="numeric">{{ t('Mean ctx tokens') }}</th>
              <th>{{ t('Macro subset (n)') }}</th>
              <th>{{ t('Micro subset (facts)') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in aggregateRows" :key="`${row.backend}-${row.budget}`">
              <td>{{ backendName(report, row.backend) }}</td>
              <td class="numeric">{{ formatCount(row.budget) }}</td>
              <td class="numeric">{{ formatCount(row.aggregate?.nQueries ?? null) }}</td>
              <td class="numeric">{{ formatCount(row.aggregate?.nRequests ?? null) }}</td>
              <td>
                <template v-if="row.aggregate && row.aggregate.recall !== null">
                  {{ formatPercent(row.aggregate.recall) }}
                  <span class="tiny muted">(CI {{ formatCi(row.aggregate.recallCi) }})</span>
                </template>
                <span v-else class="na">{{ t('Unavailable') }}</span>
              </td>
              <td class="numeric">{{ formatPercent(row.aggregate?.completeEvidenceRate ?? null) }}</td>
              <td class="numeric">{{ formatPercent(row.aggregate?.precision ?? null) }}</td>
              <td class="numeric">{{ formatMs(row.aggregate?.p50Ms ?? null) }}</td>
              <td class="numeric">{{ formatMs(row.aggregate?.p95Ms ?? null) }}</td>
              <td class="numeric">{{ formatPercent(row.aggregate?.errorRate ?? null) }}</td>
              <td class="numeric">{{ formatPercent(row.aggregate?.staleRate ?? null) }}</td>
              <td class="numeric">{{ formatPercent(row.aggregate?.scopeLeakRate ?? null) }}</td>
              <td class="numeric">{{ formatDecimal(row.aggregate?.meanContextTokens ?? null) }}</td>
              <td>
                <template v-if="row.metrics.macroCoverage !== null">
                  {{ formatPercent(row.metrics.macroCoverage) }}
                  <span class="tiny muted">(n={{ formatCount(row.metrics.macroN) }})</span>
                </template>
                <span v-else class="na">{{ t('Unavailable') }}</span>
              </td>
              <td>
                <template v-if="row.metrics.microCoverage !== null">
                  {{ formatPercent(row.metrics.microCoverage) }}
                  <span class="tiny muted">
                    ({{ formatCount(row.metrics.microFoundFacts) }}/{{
                      formatCount(row.metrics.microRequiredFacts)
                    }} {{ t('facts') }})
                  </span>
                </template>
                <span v-else class="na">{{ t('Unavailable') }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="metric-definitions">
        <dl class="metric-definition">
          <dt>{{ t('Macro literal fact coverage') }}</dt>
          <dd>{{ t('Unweighted mean of non-null QueryResult.recall values for the filtered subset. The runner aggregate remains in its own column and is never silently substituted.') }}</dd>
        </dl>
        <dl class="metric-definition">
          <dt>{{ t('Micro literal fact coverage') }}</dt>
          <dd>{{ t('Pooled evidence coverage: found required facts divided by required facts over recorded query-fact pairs. This is a diagnostic, not a semantic similarity score.') }}</dd>
        </dl>
        <dl class="metric-definition">
          <dt>{{ t('CI & sample counts') }}</dt>
          <dd>{{ t('CIs and nQueries/nRequests come from the runner. Bootstrap clusters are corpora; confidence level is runner-defined. No CI is fabricated for computed subsets. Only p95 is reported.') }}</dd>
        </dl>
      </div>

      <p v-if="filters.category || filters.language" class="chart-note">
        <strong>{{ t('Filter note:') }}</strong>
        {{ t('Report.aggregates has no category/language breakdown. Runner columns remain all-category/all-language; macro/micro subset columns and the chart honor the selected filters.') }}
      </p>
    </div>
  </section>
</template>
