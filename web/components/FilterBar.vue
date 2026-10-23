<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { backendColorMap, backendName, backendRun, categoryLabel, languageLabel, modeShortLabel, statusLabel, statusTone } from '../lib/backend';
import { formatCount } from '../lib/format';
import { uniqueBudgets, uniqueCategories, uniqueLanguages } from '../lib/derive';
import type { FilterState, Report } from '../lib/types';

const props = defineProps<{
  report: Report;
  filters: FilterState;
}>();

const emit = defineEmits<{
  'update:filters': [filters: FilterState];
}>();

const { t } = useI18n();
const colors = computed(() => backendColorMap(props.report));
const budgets = computed(() => uniqueBudgets(props.report));
const categories = computed(() => uniqueCategories(props.report));
const languages = computed(() => uniqueLanguages(props.report));
const backendOptions = computed(() => {
  const ids = props.report.backends.map((backend) => backend.id);
  const seen = new Set(ids);
  for (const result of props.report.results) {
    if (!seen.has(result.backend)) {
      seen.add(result.backend);
      ids.push(result.backend);
    }
  }
  for (const aggregate of props.report.aggregates) {
    if (!seen.has(aggregate.backend)) {
      seen.add(aggregate.backend);
      ids.push(aggregate.backend);
    }
  }
  for (const answer of props.report.answers) {
    if (!seen.has(answer.backend)) {
      seen.add(answer.backend);
      ids.push(answer.backend);
    }
  }
  return ids;
});

function patch(next: Partial<FilterState>): void {
  emit('update:filters', { ...props.filters, ...next });
}

function toggleBackend(id: string): void {
  const active = props.filters.backends.includes(id);
  patch({
    backends: active
      ? props.filters.backends.filter((backend) => backend !== id)
      : [...props.filters.backends, id],
  });
}

function onBudget(event: Event): void {
  const raw = (event.target as HTMLSelectElement).value;
  const value = raw === '' ? null : Number(raw);
  patch({ budget: value !== null && Number.isFinite(value) ? value : null });
}

function onCategory(event: Event): void {
  const raw = (event.target as HTMLSelectElement).value;
  patch({ category: raw === '' ? null : raw });
}

function onLanguage(event: Event): void {
  const raw = (event.target as HTMLSelectElement).value;
  patch({ language: raw === '' ? null : raw });
}

function reset(): void {
  patch({
    backends: backendOptions.value.slice(),
    budget: null,
    category: null,
    language: null,
  });
}
</script>

<template>
  <section class="panel filter-panel" :aria-label="t('Result filters')" data-panel="filters">
    <div class="filter-row">
      <div class="filter-group" style="flex: 1 1 520px">
        <div class="row">
          <span class="filter-label">{{ t('Backends') }}</span>
          <span class="tiny muted">{{ t('Selected: {selected} / {total}', { selected: formatCount(filters.backends.length), total: formatCount(backendOptions.length) }) }}</span>
          <span class="spacer" />
          <button class="btn btn-small" type="button" @click="patch({ backends: backendOptions.slice() })">
            {{ t('All') }}
          </button>
          <button class="btn btn-small" type="button" @click="patch({ backends: [] })">{{ t('None') }}</button>
        </div>
        <div class="chip-row" role="group" :aria-label="t('Select backends')">
          <button
            v-for="id in backendOptions"
            :key="id"
            type="button"
            class="chip"
            :class="[
              { active: filters.backends.includes(id) },
              statusTone(backendRun(report, id)?.status ?? 'unreported'),
            ]"
            :aria-pressed="filters.backends.includes(id)"
            :title="`${modeShortLabel(backendRun(report, id)?.mode ?? '')}${backendRun(report, id)?.error ? ` · ${backendRun(report, id)?.error}` : ''}`"
            @click="toggleBackend(id)"
          >
            <span class="swatch" :style="{ background: colors[id] }" />
            {{ backendName(report, id) }}
            <span class="chip-status">{{ statusLabel(backendRun(report, id)?.status ?? 'unreported') }}</span>
          </button>
        </div>
      </div>

      <div class="filter-group">
        <label class="filter-label" for="budget-filter">{{ t('Token budget') }}</label>
        <select id="budget-filter" class="select" :value="filters.budget ?? ''" @change="onBudget">
          <option value="">{{ t('All budgets') }}</option>
          <option v-for="budget in budgets" :key="budget" :value="budget">
            {{ t('{count} tokens', { count: formatCount(budget) }) }}
          </option>
        </select>
      </div>

      <div class="filter-group">
        <label class="filter-label" for="category-filter">{{ t('Category') }}</label>
        <select id="category-filter" class="select" :value="filters.category ?? ''" @change="onCategory">
          <option value="">{{ t('All categories') }}</option>
          <option v-for="category in categories" :key="category" :value="category">
            {{ categoryLabel(category) }}
          </option>
        </select>
      </div>

      <div class="filter-group">
        <label class="filter-label" for="language-filter">{{ t('Dataset language') }}</label>
        <select id="language-filter" class="select" :value="filters.language ?? ''" @change="onLanguage">
          <option value="">{{ t('All languages') }}</option>
          <option v-for="language in languages" :key="language" :value="language">
            {{ languageLabel(language) }}
          </option>
        </select>
      </div>

      <div class="filter-group" style="align-self: flex-end">
        <button class="btn" type="button" @click="reset">{{ t('Reset filters') }}</button>
      </div>
    </div>

    <p class="filter-help">
      <strong>{{ t('Scope:') }}</strong>
      {{ t('Backend and budget filters apply to aggregate and query-level views. Category and language filter query-level views; runner aggregate columns have no category/language breakdown. The budget chart deliberately spans every budget.') }}
      <template v-if="filters.backends.length === 0">
        <strong style="color: var(--warn)">{{ t('No backends selected, so no measurements can be shown.') }}</strong>
      </template>
    </p>
  </section>
</template>
