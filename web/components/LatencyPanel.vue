<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import AxisScaleControls from './AxisScaleControls.vue';
import { buildCdfPoints, logAxisMin } from '../lib/axis';
import type { AxisScale } from '../lib/axis';
import type { BarSeriesOption, LineSeriesOption } from 'echarts/charts';
import EChart from './EChart.vue';
import {
  backendColorMap,
  backendName,
  backendRun,
  isStaticInjection,
  modeShortLabel,
} from '../lib/backend';
import { buildLatencySamples } from '../lib/derive';
import { quantileSorted } from '../../src/statistics';
import { CHART_FONT, TOOLTIP_STYLE } from '../lib/echarts';
import type { DashboardOption } from '../lib/echarts';
import {
  escapeHtml,
  formatCount,
  formatMs,
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
const cdfXScale = ref<AxisScale>('linear');
const cdfYScale = ref<AxisScale>('linear');
const histogramYScale = ref<AxisScale>('linear');
const colors = computed(() => backendColorMap(props.report));
const sampleMode = ref<'warm' | 'first-seen'>('first-seen');
const samples = computed(() => buildLatencySamples(props.report, props.filters, sampleMode.value));
const staticBackends = computed(() =>
  props.report.backends.filter(
    (backend) => props.filters.backends.includes(backend.id) && isStaticInjection(backend.mode),
  ),
);

const summaryRows = computed(() =>
  samples.value.map((sample) => ({
    backend: sample.backend,
    name: backendName(props.report, sample.backend),
    mode: backendRun(props.report, sample.backend)?.mode ?? '',
    n: sample.values.length,
    firstQueryCount: sample.firstQueryCount,
    totalWarmCount: sample.totalWarmCount,
    p50: quantileSorted(sample.values, 0.5),
    p95: quantileSorted(sample.values, 0.95),
    min: sample.values.length > 0 ? sample.values[0] : null,
    max: sample.values.length > 0 ? sample.values[sample.values.length - 1] : null,
    static: isStaticInjection(backendRun(props.report, sample.backend)?.mode ?? ''),
  })),
);

const histogramBins = computed(() => {
  let count = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const sample of samples.value) {
    for (const value of sample.values) {
      count += 1;
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  if (count === 0) return [];
  const span = max - min;
  const binCount = span > 0 ? 14 : 1;
  const width = span > 0 ? span / binCount : Math.max(0.1, Math.abs(max) * 0.1 || 0.1);
  const start = span > 0 ? min : Math.max(0, min - width / 2);
  const bins = Array.from({ length: binCount }, (_, index) => ({
    start: start + index * width,
    end: start + (index + 1) * width,
    counts: new Map<string, number>(),
  }));
  for (const sample of samples.value) {
    for (const value of sample.values) {
      const rawIndex = Math.floor((value - start) / width);
      const index = Math.min(binCount - 1, Math.max(0, rawIndex));
      const bin = bins[index];
      if (!bin) continue;
      bin.counts.set(sample.backend, (bin.counts.get(sample.backend) ?? 0) + 1);
    }
  }
  return bins;
});

const cdfOption = computed<DashboardOption>(() => {
  const series: LineSeriesOption[] = [];
  for (const sample of samples.value) {
    if (sample.values.length === 0) continue;
    const name = backendName(props.report, sample.backend);
    const color = colors.value[sample.backend] ?? '#6aa7ff';
    const points = buildCdfPoints(sample.values, cdfXScale.value, cdfYScale.value);
    series.push({
      type: 'line',
      name: `${name} (n=${formatCount(sample.values.length)})`,
      data: points,
      step: 'end',
      showSymbol: false,
      symbolSize: 5,
      lineStyle: { color, width: 2 },
      itemStyle: { color },
      emphasis: { focus: 'series' },
      z: 3,
    });
  }

  const max = samples.value.reduce(
    (value, sample) =>
      sample.values.length > 0 ? Math.max(value, sample.values[sample.values.length - 1]) : value,
    0,
  );

  return {
    animationDuration: 280,
    aria: { enabled: true },
    textStyle: { fontFamily: CHART_FONT, color: '#b5c2d6' },
    grid: { left: 58, right: 24, top: 48, bottom: 54, containLabel: true },
    legend: {
      type: 'scroll',
      top: 0,
      left: 0,
      icon: 'roundRect',
      itemWidth: 12,
      itemHeight: 3,
      textStyle: { color: '#b5c2d6', fontSize: 10 },
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: '#40536e' } },
      ...TOOLTIP_STYLE,
      formatter: (params: unknown) => {
        const list = Array.isArray(params) ? params : [params];
        const first = list[0] as { value?: unknown } | undefined;
        const value = first?.value;
        const x = Array.isArray(value) && isNum(value[0]) ? value[0] : null;
        const lines = list.map((item) => {
          const parameter = item as { seriesName?: string; value?: unknown };
          const itemValue = parameter.value;
          const y = Array.isArray(itemValue) && isNum(itemValue[1]) ? itemValue[1] : null;
          return `${escapeHtml(parameter.seriesName ?? '')}: ${formatPercent(y)}`;
        });
        return [
          `<strong>${t('Latency ≤ {value} ms', { value: formatPrecise(x) })}</strong>`,
          ...lines,
        ].join('<br/>');
      },
    },
    xAxis: {
      type: cdfXScale.value === 'log' ? 'log' : 'value',
      logBase: 10,
      min: cdfXScale.value === 'log' ? logAxisMin(samples.value.map(sample => sample.values.find(value => value > 0) ?? 0)) : 0,
      max: cdfXScale.value === 'log' ? undefined : max > 0 ? max * 1.04 : 1,
      name: sampleMode.value === 'warm' ? t('Repeated warm latency (ms)') : t('First scoped-query latency (ms)'),
      nameLocation: 'middle',
      nameGap: 32,
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
      type: cdfYScale.value === 'log' ? 'log' : 'value',
      logBase: 10,
      min: cdfYScale.value === 'log' ? logAxisMin(samples.value.map(sample => sample.values.length > 0 ? 1 / sample.values.length : 0)) : 0,
      max: 1,
      name: t('Cumulative share'),
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

const histogramOption = computed<DashboardOption>(() => {
  const yMin = histogramYScale.value === 'log' ? 0.1 : 0;
  const series: BarSeriesOption[] = [];
  for (const sample of samples.value) {
    if (sample.values.length === 0) continue;
    const color = colors.value[sample.backend] ?? '#6aa7ff';
    series.push({
      type: 'bar',
      id: sample.backend,
      name: backendName(props.report, sample.backend),
      data: histogramBins.value.map((bin) => {
        const count = bin.counts.get(sample.backend) ?? 0;
        return histogramYScale.value === 'log' && count === 0 ? null : count;
      }),
      barMaxWidth: 16,
      itemStyle: { color, borderRadius: [3, 3, 0, 0] },
      emphasis: { focus: 'series' },
    });
  }

  return {
    animationDuration: 250,
    aria: { enabled: true },
    textStyle: { fontFamily: CHART_FONT, color: '#b5c2d6' },
    grid: { left: 52, right: 20, top: 48, bottom: 72, containLabel: true },
    legend: {
      type: 'scroll',
      top: 0,
      left: 0,
      icon: 'circle',
      itemWidth: 8,
      itemHeight: 8,
      textStyle: { color: '#b5c2d6', fontSize: 10 },
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      ...TOOLTIP_STYLE,
      formatter: (params: unknown) => {
        const list = Array.isArray(params) ? params : [params];
        const first = list[0] as { dataIndex?: number } | undefined;
        const index = first?.dataIndex ?? -1;
        const bin = histogramBins.value[index];
        const header = bin
          ? `<strong>${formatPrecise(bin.start)} – ${formatPrecise(bin.end)} ms</strong>`
          : `<strong>${t('Latency bin')}</strong>`;
        const rows = list.map((item) => {
          const parameter = item as { seriesName?: string; seriesId?: string };
          const count = bin?.counts.get(parameter.seriesId ?? '') ?? 0;
          return `${escapeHtml(parameter.seriesName ?? '')}: ${t('Requests: {count}', { count: formatCount(count) })}`;
        });
        return [header, ...rows].join('<br/>');
      },
    },
    xAxis: {
      type: 'category',
      data: histogramBins.value.map(
        (bin) => `${formatPrecise(bin.start)}–${formatPrecise(bin.end)}`,
      ),
      name: t('Selected latency bin (ms)'),
      nameLocation: 'middle',
      nameGap: 50,
      nameTextStyle: { color: '#8192aa', fontSize: 11 },
      axisLabel: {
        color: '#8192aa',
        fontSize: 9,
        interval: 1,
        rotate: 32,
        margin: 10,
      },
      axisLine: { lineStyle: { color: '#2b3850' } },
      axisTick: { show: false },
    },
    yAxis: {
      type: histogramYScale.value === 'log' ? 'log' : 'value',
      logBase: 10,
      min: yMin,
      startValue: yMin,
      minInterval: histogramYScale.value === 'log' ? undefined : 1,
      name: t('Selected requests'),
      nameTextStyle: { color: '#8192aa', fontSize: 11 },
      axisLabel: { color: '#8192aa', fontSize: 10, formatter: (value: string | number) => formatPrecise(Number(value)) },
      axisLine: { lineStyle: { color: '#2b3850' } },
      splitLine: { lineStyle: { color: '#1b2535' } },
    },
    series,
  };
});
</script>

<template>
  <section class="panel chart-card" :aria-label="t('Query latency')" data-panel="latency">
    <div class="panel-head">
      <div>
        <h2 class="panel-title">{{ t('Query latency: first-seen vs repeated') }}</h2>
        <p class="panel-sub">{{ t('First-seen means the first exact query within its workspace, not a guaranteed native-cache miss. Warm uses the repeated pass. Failed requests are excluded from percentiles and remain visible as errors.') }}</p>
      </div>
      <div class="panel-head-side">
        <label>{{ t('Sample') }}
          <select v-model="sampleMode" :aria-label="t('Latency sample')">
            <option value="first-seen">{{ t('First scoped-query occurrence') }}</option>
            <option value="warm">{{ t('Repeated warm pass') }}</option>
          </select>
        </label>
        <span class="badge">{{ t('p95 only') }}</span>
      </div>
    </div>

    <div v-if="filters.backends.length === 0" class="chart-empty">{{ t('No backends selected.') }}</div>
    <template v-else>
      <div class="grid-2">
        <div class="chart-box" data-chart="cdf">
          <h3 class="panel-section-title">{{ t('Cumulative distribution') }}</h3>
          <AxisScaleControls v-model:x="cdfXScale" v-model:y="cdfYScale" :x-label="t('X axis')" :y-label="t('Y axis')" />
          <p v-if="cdfXScale === 'log' || cdfYScale === 'log'" class="chart-note">{{ t('CDF shares keep the original sample denominator when non-positive coordinates are omitted. The synthetic zero origin is not drawn on logarithmic axes.') }}</p>
          <div v-if="summaryRows.every((row) => row.n === 0)" class="chart-empty">
            {{ t('No successful samples match these filters. First-seen timing requires novelty instrumentation; missing does not mean 0 ms.') }}
          </div>
          <EChart
            v-else
            :option="cdfOption"
            :height="330"
            :aria-label="t('Cumulative distribution of selected query latency by backend')"
          />
        </div>
        <div class="chart-box" data-chart="histogram">
          <h3 class="panel-section-title">{{ t('Histogram') }}</h3>
          <AxisScaleControls v-model:y="histogramYScale" :y-label="t('Y axis')" />
          <p class="chart-note">{{ t('X shows fixed equal-width latency bins, not a continuous numeric axis. Y may be linear or logarithmic; zero-count bins remain in the original data and tooltips.') }}</p>
          <div v-if="histogramBins.length === 0" class="chart-empty">
            {{ t('No selected latency samples to bin.') }}
          </div>
          <EChart
            v-else
            :option="histogramOption"
            :height="330"
            :aria-label="t('Histogram of selected query latency by backend')"
          />
        </div>
      </div>

      <div class="table-wrap" style="margin-top: 14px">
        <table class="data-table">
          <thead>
            <tr>
              <th>{{ t('Backend') }}</th>
              <th>{{ t('Mode') }}</th>
              <th class="numeric">{{ t('Selected n') }}</th>
              <th class="numeric">{{ t('Warm rows') }}</th>
              <th class="numeric">{{ t('First-pass rows') }}</th>
              <th class="numeric">{{ t('p50 selected') }}</th>
              <th class="numeric">{{ t('p95 selected') }}</th>
              <th class="numeric">{{ t('Min') }}</th>
              <th class="numeric">{{ t('Max') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in summaryRows" :key="row.backend">
              <td>{{ row.name }}</td>
              <td>
                <span class="badge" :class="{ static: row.static }">
                  {{ modeShortLabel(row.mode) }}
                </span>
              </td>
              <td class="numeric">{{ formatCount(row.n) }}</td>
              <td class="numeric">{{ formatCount(row.totalWarmCount) }}</td>
              <td class="numeric">{{ formatCount(row.firstQueryCount) }}</td>
              <td class="numeric">{{ formatMs(row.p50) }}</td>
              <td class="numeric">{{ formatMs(row.p95) }}</td>
              <td class="numeric">{{ formatMs(row.min) }}</td>
              <td class="numeric">{{ formatMs(row.max) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <p class="chart-note">
      <strong>{{ t('Percentiles:') }}</strong>
      {{ t('p50/p95 use the runner linear-interpolated quantile over successful raw rows. Pareto latency always uses repeated warm rows. p99 is not computed; consult the sample counts.') }}
    </p>
    <p v-if="staticBackends.length > 0" class="chart-note">
      <strong>{{ t('Static injection:') }}</strong>
      {{ staticBackends.map((backend) => backendName(report, backend.id)).join(', ') }}
      {{ t('read a precomputed context. A 0 ms static read does not demonstrate fast dynamic semantic search.') }}
    </p>
  </section>
</template>
