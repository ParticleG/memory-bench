<script setup lang="ts">
import { useId } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AxisScale } from '../lib/axis';

defineProps<{ xLabel?: string; yLabel?: string }>();
const x = defineModel<AxisScale>('x', { default: 'linear' });
const y = defineModel<AxisScale>('y', { default: 'linear' });
const id = useId();
const { t } = useI18n();
</script>

<template>
  <div class="axis-controls">
    <label v-if="xLabel" :for="`${id}-x`">
      <span>{{ xLabel }}</span>
      <select :id="`${id}-x`" v-model="x" class="select" data-axis="x">
        <option value="linear">{{ t('Linear') }}</option>
        <option value="log">{{ t('Logarithmic (base 10)') }}</option>
      </select>
    </label>
    <label v-if="yLabel" :for="`${id}-y`">
      <span>{{ yLabel }}</span>
      <select :id="`${id}-y`" v-model="y" class="select" data-axis="y">
        <option value="linear">{{ t('Linear') }}</option>
        <option value="log">{{ t('Logarithmic (base 10)') }}</option>
      </select>
    </label>
  </div>
  <p v-if="(xLabel && x === 'log') || (yLabel && y === 'log')" class="chart-note axis-note">
    {{ t('Logarithmic axes require strictly positive values. Non-positive values are omitted only from the chart; original records and statistics remain unchanged.') }}
  </p>
</template>

<style scoped>
.axis-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 16px;
  margin: 12px 0;
}
.axis-controls label {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: var(--text-dim);
  font-size: 12px;
}
.axis-controls .select { max-width: 100%; }
.axis-note { margin-bottom: 12px; }
@media (max-width: 560px) {
  .axis-controls label { width: 100%; justify-content: space-between; }
}
</style>
