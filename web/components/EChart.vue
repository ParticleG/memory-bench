<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { echarts } from '../lib/echarts';
import type { DashboardOption } from '../lib/echarts';

const props = withDefaults(
  defineProps<{
    option: DashboardOption;
    height?: number;
    ariaLabel?: string;
  }>(),
  {
    height: 320,
  },
);

const emit = defineEmits<{
  chartClick: [params: unknown];
}>();

const { t, locale } = useI18n();
const container = ref<HTMLDivElement | null>(null);
const chart = shallowRef<ReturnType<typeof echarts.init> | null>(null);
let resizeObserver: ResizeObserver | null = null;

function handleClick(params: unknown): void {
  emit('chartClick', params);
}

onMounted(() => {
  const element = container.value;
  if (!element) return;
  resizeObserver = new ResizeObserver(() => chart.value?.resize());
  resizeObserver.observe(element);
});

watch(
  [container, () => props.option, locale],
  ([element, option, currentLocale], previous) => {
    if (!element) return;
    if (!chart.value || currentLocale !== previous[2]) {
      chart.value?.dispose();
      const instance = echarts.init(element, undefined, {
        renderer: 'canvas',
        locale: currentLocale === 'zh-CN' ? 'ZH' : 'EN',
      });
      chart.value = instance;
      instance.on('click', handleClick);
    }
    chart.value.setOption(option, true);
  },
  { flush: 'post' },
);

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  chart.value?.dispose();
  chart.value = null;
});
</script>

<template>
  <div
    ref="container"
    class="echart"
    :style="{ height: `${height}px` }"
    role="img"
    :aria-label="ariaLabel || t('Data chart')"
  />
</template>
