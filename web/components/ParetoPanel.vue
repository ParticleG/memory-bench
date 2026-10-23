<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import AxisScaleControls from './AxisScaleControls.vue';
import { isAxisValue, logAxisMin } from '../lib/axis';
import type { AxisScale } from '../lib/axis';
import type { CustomSeriesOption, ScatterSeriesOption } from 'echarts/charts';
import EChart from './EChart.vue';
import { backendColorMap, backendName, backendRun, isStaticInjection, statusLabel, statusTone } from '../lib/backend';
import { buildMetricPoints } from '../lib/derive';
import {
  CHART_FONT,
  TOOLTIP_STYLE,
  verticalCiRenderer,
} from '../lib/echarts';
import type { DashboardOption } from '../lib/echarts';
import {
  escapeHtml,
  formatCount,
  formatPercent,
  formatPrecise,
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
const points = computed(() => buildMetricPoints(props.report, props.filters));
const plottable = computed(() =>
  points.value.filter(
    (point) => isAxisValue(point.coverage, yScale.value) && isAxisValue(point.p95Ms, xScale.value) && point.p95Ms >= 0,
  ),
);

const legendNames = computed(() => {
  const names: string[] = [];
  for (const point of plottable.value) {
    const name = backendName(props.report, point.backend);
    if (!names.includes(name)) names.push(name);
  }
  return names;
});

const staticBackends = computed(() =>
  props.report.backends.filter(
    (backend) => props.filters.backends.includes(backend.id) && isStaticInjection(backend.mode),
  ),
);

const computedSources = computed(() => plottable.value.filter((point) => point.source === 'computed'));

const missingRows = computed(() => {
  return points.value
    .filter((point) => !isAxisValue(point.coverage, yScale.value) || !isAxisValue(point.p95Ms, xScale.value) || point.p95Ms < 0)
    .map((point) => {
      const run = backendRun(props.report, point.backend);
      let reason = t('No aggregate or query result rows for this backend and budget.');
      if (isNum(point.coverage) && isNum(point.p95Ms) && point.p95Ms >= 0) {
        reason = point.coverage <= 0 && yScale.value === 'log'
          ? t('Coverage is non-positive and cannot be displayed on a logarithmic Y axis.')
          : t('Latency is non-positive and cannot be displayed on a logarithmic X axis.');
      } else if (point.source === 'runner') {
        reason = point.coverage === null
          ? t('Runner aggregate has no literal fact coverage value.')
          : t('Runner aggregate has no p95 latency value.');
      } else if (point.source === 'computed') {
        reason = point.coverage === null
          ? t('No non-null subset coverage samples in QueryResults.')
          : t('No finite subset latency values in QueryResults.');
      }
      return {
        backend: backendName(props.report, point.backend),
        budget: point.budget,
        source: point.source,
        status: run?.status ?? 'unreported',
        reason,
      };
    });
});

const hiddenCiCount = computed(() => plottable.value.filter(point =>
  point.coverageCi && (!isAxisValue(point.coverageCi[0], yScale.value) || !isAxisValue(point.coverageCi[1], yScale.value)),
).length);

const xMax = computed(() => {
  const max = plottable.value.reduce(
    (value, point) => Math.max(value, isNum(point.p95Ms) ? point.p95Ms : 0),
    0,
  );
  return max > 0 ? max * 1.16 : 1;
});

function pointLabel(params: unknown): string {
  const data = (params as { data?: unknown }).data;
  if (!Array.isArray(data) || !isNum(data[2])) return '';
  return `B${formatCount(data[2])}`;
}

function paretoTooltip(params: unknown): string {
  const parameter = params as { data?: unknown; seriesName?: string };
  const data = parameter.data;
  if (!Array.isArray(data)) return '';
  const [x, y, budget, nQueries, nRequests, source, ciLow, ciHigh] = data;
  if (!isNum(x) || !isNum(y)) return '';
  const coverage =
    isNum(ciLow) && isNum(ciHigh)
      ? t('{value} (CI {low} – {high})', { value: formatPercent(y), low: formatPercent(ciLow), high: formatPercent(ciHigh) })
      : t('{value} (CI unavailable)', { value: formatPercent(y) });
  const sample =
    isNum(nQueries) || isNum(nRequests)
      ? `nQueries=${isNum(nQueries) ? formatCount(nQueries) : t('Unavailable')}, nRequests=${
          isNum(nRequests) ? formatCount(nRequests) : t('Unavailable')
        }`
      : t('Sample counts unavailable');
  const sourceLabel =
    source === 'runner'
      ? t('Runner aggregate (all categories/languages)')
      : source === 'computed'
        ? t('Computed subset from QueryResults (macro; interpolated warm-only p95)')
        : t('No measurement');
  return [
    `<strong>${escapeHtml(parameter.seriesName ?? '')}</strong>`,
    t('Budget: {value}', { value: isNum(budget) ? t('{count} tokens', { count: formatCount(budget) }) : t('Unavailable') }),
    t('Literal fact coverage: {value}', { value: coverage }),
    t('p95 latency: {value} ms', { value: formatPrecise(x) }),
    t('Samples: {value}', { value: escapeHtml(sample) }),
    t('Source: {value}', { value: escapeHtml(sourceLabel) }),
  ].join('<br/>');
}

const option = computed<DashboardOption>(() => {
  const series: Array<ScatterSeriesOption | CustomSeriesOption> = [];
  const palette: string[] = [];
  const byBackend = new Map<string, typeof plottable.value>();
  for (const point of plottable.value) {
    const list = byBackend.get(point.backend);
    if (list) list.push(point);
    else byBackend.set(point.backend, [point]);
  }

  for (const [backend, rows] of byBackend) {
    const name = backendName(props.report, backend);
    const color = colors.value[backend] ?? '#6aa7ff';
    palette.push(color);
    series.push({
      type: 'scatter',
      name,
      z: 4,
      color,
      symbolSize: 11,
      data: rows.map((point) => [
        point.p95Ms as number,
        point.coverage as number,
        point.budget,
        point.nQueries ?? t('Unavailable'),
        point.nRequests ?? t('Unavailable'),
        point.source,
        point.coverageCi?.[0] ?? t('Unavailable'),
        point.coverageCi?.[1] ?? t('Unavailable'),
      ]),
      itemStyle: { color, borderColor: '#080b11', borderWidth: 1.5 },
      emphasis: { scale: 1.5 },
      label: {
        show: rows.length > 1 && plottable.value.length <= 24,
        position: 'top',
        distance: 6,
        color: '#8b9bb4',
        fontSize: 10,
        formatter: pointLabel,
      },
      labelLayout: { hideOverlap: true },
    });

    const ciRows = rows.filter(
      (point) =>
        point.coverageCi !== null &&
        isAxisValue(point.coverageCi[0], yScale.value) &&
        isAxisValue(point.coverageCi[1], yScale.value) &&
        isNum(point.p95Ms),
    );
    if (ciRows.length > 0) {
      series.push({
        type: 'custom',
        name: `${name} CI`,
        z: 2,
        silent: true,
        color,
        data: ciRows.map((point) => [
          point.p95Ms as number,
          point.coverageCi?.[0] as number,
          point.coverageCi?.[1] as number,
        ]),
        renderItem: verticalCiRenderer(color),
      });
    }
  }

  return {
    animationDuration: 300,
    aria: { enabled: true },
    color: palette,
    textStyle: { fontFamily: CHART_FONT, color: '#b5c2d6' },
    grid: { left: 64, right: 28, top: 46, bottom: 58, containLabel: true },
    legend: {
      data: legendNames.value,
      type: 'scroll',
      top: 0,
      left: 0,
      itemWidth: 9,
      itemHeight: 9,
      icon: 'circle',
      textStyle: { color: '#b5c2d6', fontSize: 11 },
    },
    tooltip: {
      trigger: 'item',
      ...TOOLTIP_STYLE,
      formatter: paretoTooltip,
    },
    xAxis: {
      type: xScale.value === 'log' ? 'log' : 'value',
      logBase: 10,
      min: xScale.value === 'log' ? logAxisMin(plottable.value.map(point => point.p95Ms as number)) : 0,
      max: xScale.value === 'log' ? undefined : xMax.value,
      name: t('p95 latency (ms)'),
      nameLocation: 'middle',
      nameGap: 34,
      nameTextStyle: { color: '#8192aa', fontSize: 11 },
      axisLabel: {
        color: '#8192aa',
        fontSize: 10,
        formatter: (value: string | number) => formatPrecise(Number(value)),
      },
      axisLine: { lineStyle: { color: '#2b3850' } },
      splitLine: { lineStyle: { color: '#1b2535' } },
    },
    yAxis: {
      type: yScale.value === 'log' ? 'log' : 'value',
      logBase: 10,
      min: yScale.value === 'log' ? logAxisMin(plottable.value.flatMap(point => point.coverageCi && point.coverageCi[0] > 0 ? [point.coverage as number, point.coverageCi[0]] : [point.coverage as number])) : 0,
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
</script>

<template>
  <section class="panel chart-card" :aria-label="t('Coverage versus p95 latency')" data-panel="pareto">
    <div class="panel-head">
      <div>
        <h2 class="panel-title">{{ t('Literal fact coverage vs p95 latency') }}</h2>
        <p class="panel-sub">
          {{ t('Higher and further left is better. One point per selected backend × budget. Coverage is deterministic literal-valued atomic fact coverage, not semantic recall.') }}
        </p>
      </div>
      <div class="panel-head-side">
        <span class="badge">{{ t('Plotted: {count}', { count: formatCount(plottable.length) }) }}</span>
        <span v-if="missingRows.length > 0" class="badge unavailable">{{ t('Unplotted: {count}', { count: formatCount(missingRows.length) }) }}</span>
      </div>
    </div>

    <AxisScaleControls v-model:x="xScale" v-model:y="yScale" :x-label="t('X axis')" :y-label="t('Y axis')" />
    <p v-if="hiddenCiCount > 0" class="chart-note">
      {{ t('{count} confidence intervals have non-positive endpoints and cannot be drawn on the logarithmic axis. Original intervals remain in tooltips and tables.', { count: formatCount(hiddenCiCount) }) }}
    </p>

    <div v-if="filters.backends.length === 0" class="chart-empty">
      {{ t('No backends selected.') }}
    </div>
    <div v-else-if="plottable.length === 0" class="chart-empty">
      {{ t('No selected backend/budget has displayable coverage and latency on these axes. Missing or non-positive logarithmic coordinates are not replaced with fabricated values.') }}
    </div>
    <EChart
      v-else
      :option="option"
      :height="390"
      :aria-label="t('Scatter chart of literal fact coverage versus p95 latency')"
    />

    <p class="chart-note">
      <strong>{{ t('Coverage source:') }}</strong>
      {{ t('Runner aggregates are used for all categories/languages; filtered subsets are recomputed from raw QueryResult rows. All p95 values use successful repeated-warm rows and the same interpolated quantile. First-scoped queries appear separately in the latency panel. CI bars use the runner bootstrap clustered by corpus. Only p95 is shown, not p99.') }}
      <template v-if="computedSources.length > 0">
        <strong>{{ t('Computed subset points without CI: {count}', { count: formatCount(computedSources.length) }) }}</strong>
      </template>
    </p>
    <p v-if="staticBackends.length > 0" class="chart-note">
      <strong>{{ t('Static read:') }}</strong>
      {{ staticBackends.map((backend) => backendName(report, backend.id)).join(', ') }}
      {{ t('use precomputed context. Their query-time latency is a context read, not dynamic semantic search.') }}
    </p>

    <details v-if="missingRows.length > 0" class="details" style="margin-top: 10px">
      <summary>{{ t('Not plotted: {count} backend/budget combinations', { count: formatCount(missingRows.length) }) }}</summary>
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
            <tr v-for="(row, index) in missingRows" :key="`${row.backend}-${row.budget}-${index}`">
              <td>{{ row.backend }}</td>
              <td class="numeric">{{ formatCount(row.budget) }}</td>
              <td>
                <span class="badge" :class="statusTone(row.status)">{{ statusLabel(row.status) }}</span>
              </td>
              <td class="wrap">{{ row.reason }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </details>
  </section>
</template>
