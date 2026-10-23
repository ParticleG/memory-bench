<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { HeatmapSeriesOption } from 'echarts/charts';
import EChart from './EChart.vue';
import { backendName, categoryLabel } from '../lib/backend';
import { buildCategoryCells, uniqueCategories } from '../lib/derive';
import { CHART_FONT, TOOLTIP_STYLE } from '../lib/echarts';
import type { DashboardOption } from '../lib/echarts';
import { escapeHtml, formatCount, formatPercent, formatPercentCompact, isNum } from '../lib/format';
import type { FilterState, Report } from '../lib/types';

const props = defineProps<{
  report: Report;
  filters: FilterState;
}>();

const emit = defineEmits<{
  selectCategory: [category: string];
}>();

const { t } = useI18n();
const categories = computed(() => uniqueCategories(props.report));
const backendLabels = computed(() =>
  props.filters.backends.map((backend) => backendName(props.report, backend)),
);
const cells = computed(() => buildCategoryCells(props.report, props.filters));

const heatmapData = computed(() => {
  const data = [];
  for (const cell of cells.value) {
    const xIndex = categories.value.indexOf(cell.category);
    const yIndex = props.filters.backends.indexOf(cell.backend);
    if (xIndex < 0 || yIndex < 0) continue;
    const isSelected = props.filters.category === cell.category;
    data.push({
      value: [xIndex, yIndex, cell.coverage ?? -1, cell.n, cell.nRequests],
      label: { color: cell.coverage !== null && cell.coverage >= 0.5 ? '#0d1523' : '#dce6f3' },
      itemStyle: isSelected ? { borderColor: '#e7eef9', borderWidth: 2 } : undefined,
    });
  }
  return data;
});

const chartHeight = computed(() => {
  const rows = Math.max(1, props.filters.backends.length);
  return Math.max(380, Math.min(720, 220 + rows * 34 + categories.value.length * 8));
});

const needsZoom = computed(() => categories.value.length > 12);

const option = computed<DashboardOption>(() => {
  const series: HeatmapSeriesOption[] = [
    {
      type: 'heatmap',
      data: heatmapData.value,
      label: {
        show: true,
        color: '#dbe7f5',
        fontSize: 10,
        formatter: (params: unknown) => {
          const value = (params as { value?: unknown }).value;
          if (!Array.isArray(value) || !isNum(value[2])) return '';
          return value[2] < 0 ? '—' : formatPercentCompact(value[2]);
        },
      },
      emphasis: {
        itemStyle: { borderColor: '#ffffff', borderWidth: 2 },
      },
      itemStyle: {
        borderColor: '#0b0f16',
        borderWidth: 2,
        borderRadius: 4,
      },
    },
  ];

  return {
    animationDuration: 250,
    aria: { enabled: true },
    textStyle: { fontFamily: CHART_FONT, color: '#b5c2d6' },
    grid: {
      left: 24,
      right: 24,
      top: 16,
      bottom: needsZoom.value ? 96 : 72,
      containLabel: true,
    },
    tooltip: {
      trigger: 'item',
      ...TOOLTIP_STYLE,
      formatter: (params: unknown) => {
        const parameter = params as { value?: unknown };
        const value = parameter.value;
        if (!Array.isArray(value)) return '';
        const xIndex = Number(value[0]);
        const yIndex = Number(value[1]);
        const coverage = value[2];
        const n = value[3];
        const nRequests = value[4];
        const category = categoryLabel(categories.value[xIndex] ?? t('Unavailable'));
        const backend = backendLabels.value[yIndex] ?? t('Unavailable');
        const headline = `<strong>${escapeHtml(backend)}</strong><br/>${escapeHtml(category)}`;
        if (!isNum(coverage) || coverage < 0) {
          return `${headline}<br/>${t('Literal fact coverage: unavailable')}<br/>${t('No QueryResult coverage samples for this cell.')}`;
        }
        return [
          headline,
          t('Literal fact coverage (macro): {value}', { value: formatPercent(coverage) }),
          t('Samples with coverage: {count} · query requests: {requests}', { count: formatCount(n), requests: formatCount(nRequests) }),
        ].join('<br/>');
      },
    },
    xAxis: {
      type: 'category',
      data: categories.value.map(categoryLabel),
      axisLabel: {
        color: '#9aabc2',
        fontSize: 10,
        interval: 0,
        rotate: 28,
        margin: 12,
      },
      axisLine: { lineStyle: { color: '#2b3850' } },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'category',
      data: backendLabels.value,
      axisLabel: {
        color: '#b5c2d6',
        fontSize: 11,
        width: 160,
        overflow: 'truncate',
      },
      axisLine: { lineStyle: { color: '#2b3850' } },
      axisTick: { show: false },
    },
    visualMap: {
      type: 'continuous',
      dimension: 2, // Coverage; trailing dimensions contain sample counts.
      min: 0,
      max: 1,
      calculable: true,
      orient: 'horizontal',
      left: 'center',
      bottom: needsZoom.value ? 54 : 12,
      itemWidth: 12,
      itemHeight: 120,
      text: ['100%', '0%'],
      textStyle: { color: '#8192aa', fontSize: 10 },
      inRange: { color: ['#132238', '#1f5a78', '#2f9b8f', '#69cf8f', '#d8e86a'] },
      outOfRange: { color: '#151b25' },
    },
    dataZoom: needsZoom.value
      ? [
          {
            type: 'slider',
            xAxisIndex: 0,
            bottom: 14,
            height: 16,
            start: 0,
            end: Math.max(18, Math.min(100, Math.round((12 / categories.value.length) * 100))),
            borderColor: '#2b3850',
            backgroundColor: '#0c111a',
            fillerColor: 'rgba(106, 167, 255, 0.18)',
            handleStyle: { color: '#6aa7ff' },
            textStyle: { color: '#8192aa', fontSize: 10 },
          },
        ]
      : undefined,
    series,
  };
});

function onChartClick(params: unknown): void {
  const value = (params as { value?: unknown }).value;
  if (!Array.isArray(value) || !isNum(value[0])) return;
  const category = categories.value[value[0]];
  if (category) emit('selectCategory', category);
}
</script>

<template>
  <section class="panel chart-card" :aria-label="t('Coverage by category')" data-panel="heatmap">
    <div class="panel-head">
      <div>
        <h2 class="panel-title">{{ t('Literal fact coverage by category') }}</h2>
        <p class="panel-sub">{{ t('Macro coverage per backend/category is the unweighted mean of non-null QueryResult values. Cells without coverage samples show a dash, never zero. Click a cell to filter query-level views.') }}</p>
      </div>
      <div class="panel-head-side">
        <span v-if="filters.category" class="badge accent">{{ t('Category') }}: {{ categoryLabel(filters.category) }}</span>
        <span class="badge">{{ t('Categories: {count}', { count: formatCount(categories.length) }) }}</span>
      </div>
    </div>

    <div v-if="filters.backends.length === 0" class="chart-empty">{{ t('No backends selected.') }}</div>
    <div v-else-if="categories.length === 0" class="chart-empty">{{ t('No categories in the dataset.') }}</div>
    <EChart
      v-else
      :option="option"
      :height="chartHeight"
      :aria-label="t('Heatmap of macro literal fact coverage by backend and category')"
      @chart-click="onChartClick"
    />

    <p class="chart-note">
      <strong>{{ t('Coverage is literal:') }}</strong>
      {{ t('Gold-alias fact coverage is deterministic, not semantic recall. Empty cells are excluded from the visual scale. Tooltips show sample counts. Language and budget filters apply; the category filter only highlights its column so comparisons remain visible.') }}
    </p>
  </section>
</template>
