<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  backendName,
  backendRun,
  categoryLabel,
  languageLabel,
  statusLabel,
  modeLabel,
  statusTone,
} from '../lib/backend';
import {
  answersFor,
  indexDocuments,
  indexFacts,
  indexQueries,
  missingFactIds,
  resolveFacts,
} from '../lib/derive';
import type { IndexedDocument, ResolvedFact } from '../lib/derive';
import {
  formatCount,
  formatDate,
  formatMs,
  formatPercent,
  isNum,
} from '../lib/format';
import type { FilterState, QueryResult, Report } from '../lib/types';

const props = defineProps<{
  report: Report;
  filters: FilterState;
}>();

const { t } = useI18n();
const pageSize = 40;
const page = ref(0);
const selectedIndex = ref<number | null>(null);

const queries = computed(() => indexQueries(props.report.dataset));
const facts = computed(() => indexFacts(props.report.dataset));
const documents = computed(() => indexDocuments(props.report.dataset));

interface IndexedResult {
  result: QueryResult;
  index: number;
}

const filteredRows = computed<IndexedResult[]>(() => {
  const backends = new Set(props.filters.backends);
  return props.report.results
    .map((result, index) => ({ result, index }))
    .filter(
      ({ result }) =>
        backends.has(result.backend) &&
        (props.filters.budget === null || result.budget === props.filters.budget) &&
        (props.filters.category === null || result.category === props.filters.category) &&
        (props.filters.language === null || result.language === props.filters.language),
    )
    .sort(
      (a, b) =>
        a.result.queryId.localeCompare(b.result.queryId) ||
        a.result.backend.localeCompare(b.result.backend) ||
        a.result.budget - b.result.budget ||
        a.result.repeat - b.result.repeat ||
        a.result.phase.localeCompare(b.result.phase),
    );
});

const pageCount = computed(() => Math.max(1, Math.ceil(filteredRows.value.length / pageSize)));
const pageRows = computed(() => {
  const start = page.value * pageSize;
  return filteredRows.value.slice(start, start + pageSize);
});
const pageLabel = computed(() => {
  if (filteredRows.value.length === 0) return t('Result records: {count}', { count: formatCount(0) });
  const start = page.value * pageSize + 1;
  const end = Math.min(filteredRows.value.length, (page.value + 1) * pageSize);
  return t('Result records: {start}–{end} of {total}', { start: formatCount(start), end: formatCount(end), total: formatCount(filteredRows.value.length) });
});

const selected = computed<QueryResult | null>(() => {
  if (selectedIndex.value === null) return null;
  return props.report.results[selectedIndex.value] ?? null;
});

const selectedQuery = computed(() => {
  const result = selected.value;
  return result ? queries.value.get(result.queryId) : undefined;
});
const selectedBackend = computed(() => {
  const result = selected.value;
  return result ? backendRun(props.report, result.backend) : undefined;
});

const requiredFacts = computed<ResolvedFact[]>(() => {
  const result = selected.value;
  return result ? resolveFacts(result.requiredFactIds, facts.value) : [];
});
const foundFacts = computed<ResolvedFact[]>(() => {
  const result = selected.value;
  return result ? resolveFacts(result.foundFactIds, facts.value) : [];
});
const missingIds = computed(() => {
  const result = selected.value;
  return result ? missingFactIds(result.requiredFactIds, result.foundFactIds) : [];
});
const missingFacts = computed<ResolvedFact[]>(() =>
  selected.value ? resolveFacts(missingIds.value, facts.value) : [],
);
const forbiddenFacts = computed<ResolvedFact[]>(() => {
  const result = selected.value;
  return result ? resolveFacts(result.forbiddenFactIds, facts.value) : [];
});
const leakedFacts = computed<ResolvedFact[]>(() => {
  const result = selected.value;
  return result ? resolveFacts(result.leakedFactIds, facts.value) : [];
});
const extraFoundFacts = computed<ResolvedFact[]>(() => {
  const result = selected.value;
  if (!result) return [];
  const required = new Set(result.requiredFactIds);
  return resolveFacts(
    result.foundFactIds.filter((id) => !required.has(id)),
    facts.value,
  );
});

interface SourceEntry {
  id: string;
  document: IndexedDocument | null;
  viaGold: boolean;
  viaRetrieval: boolean;
}

const sourceEntries = computed<SourceEntry[]>(() => {
  const result = selected.value;
  if (!result) return [];
  const entries = new Map<string, SourceEntry>();
  const referencedFacts = resolveFacts(
    [
      ...new Set([
        ...result.requiredFactIds,
        ...result.foundFactIds,
        ...result.forbiddenFactIds,
        ...result.leakedFactIds,
      ]),
    ],
    facts.value,
  );
  for (const entry of referencedFacts) {
    if (!entry.fact) continue;
    for (const id of entry.fact.sourceDocumentIds) {
      const existing = entries.get(id);
      if (existing) {
        existing.viaGold = true;
      } else {
        entries.set(id, {
          id,
          document: documents.value.get(id) ?? null,
          viaGold: true,
          viaRetrieval: false,
        });
      }
    }
  }
  for (const item of result.items) {
    for (const id of item.sourceIds ?? []) {
      const existing = entries.get(id);
      if (existing) {
        existing.viaRetrieval = true;
      } else {
        entries.set(id, {
          id,
          document: documents.value.get(id) ?? null,
          viaGold: false,
          viaRetrieval: true,
        });
      }
    }
  }
  return [...entries.values()];
});

const selectedAnswers = computed(() => {
  const result = selected.value;
  return result ? answersFor(result, props.report.answers) : [];
});
const contextLength = computed(() => selected.value?.context.length ?? 0);

watch(
  filteredRows,
  (rows) => {
    page.value = 0;
    if (selectedIndex.value === null || !rows.some((row) => row.index === selectedIndex.value)) {
      selectedIndex.value = rows[0]?.index ?? null;
    }
  },
  { immediate: true },
);

watch(
  () => props.filters,
  () => {
    page.value = 0;
  },
  { deep: true },
);

function selectRow(index: number): void {
  selectedIndex.value = index;
}

function goPage(delta: number): void {
  page.value = Math.min(pageCount.value - 1, Math.max(0, page.value + delta));
}

function questionFor(queryId: string): string {
  return queries.value.get(queryId)?.text ?? t('Question unavailable: query id is not present in the dataset.');
}

function phaseLabel(phase: string): string {
  if (phase === 'first-query') return t('first query');
  if (phase === 'warm') return t('warm');
  return phase;
}
</script>

<template>
  <section class="panel" :aria-label="t('Query evidence drilldown')" data-panel="drilldown">
    <div class="panel-head">
      <div>
        <h2 class="panel-title">{{ t('Per-query evidence drilldown') }}</h2>
        <p class="panel-sub">{{ t('Select a QueryResult record to inspect its question, facts, context, flags, errors, timing, sources and matching AnswerResults. Evidence text, answers, transcripts, IDs and errors stay in their original language.') }}</p>
      </div>
      <div class="panel-head-side">
        <span class="badge">{{ t('Result records: {count}', { count: formatCount(filteredRows.length) }) }}</span>
        <span class="badge">{{ t('Dataset queries: {count}', { count: formatCount(report.dataset.queries.length) }) }}</span>
        <span class="badge">{{ t('Answers: {count}', { count: formatCount(report.answers.length) }) }}</span>
      </div>
    </div>

    <div class="drill-layout">
      <div>
        <div v-if="filteredRows.length === 0" class="empty-inline">
          {{ t('No QueryResult rows match the current filters.') }}
        </div>
        <template v-else>
          <div class="query-list" role="listbox" :aria-label="t('Query result records')">
            <button
              v-for="row in pageRows"
              :key="row.index"
              type="button"
              class="query-row"
              :class="{ active: selectedIndex === row.index }"
              role="option"
              :aria-selected="selectedIndex === row.index"
              @click="selectRow(row.index)"
            >
              <div class="query-row-main">
                <span class="query-row-dot" :class="{ error: Boolean(row.result.error) }" />
                <span
                  class="badge"
                  :class="statusTone(backendRun(report, row.result.backend)?.status ?? '')"
                >
                  {{ backendName(report, row.result.backend) }}
                </span>
                <span class="spacer" />
                <span class="tiny muted">{{ formatMs(row.result.latencyMs) }}</span>
              </div>
              <div class="query-row-text" :title="questionFor(row.result.queryId)">
                {{ questionFor(row.result.queryId) }}
              </div>
              <div class="query-row-meta">
                <span>{{ categoryLabel(row.result.category) }}</span>
                <span>{{ languageLabel(row.result.language) }}</span>
                <span>B{{ formatCount(row.result.budget) }}</span>
                <span>{{ phaseLabel(row.result.phase) }}</span>
                <span>{{ t('Repeat {count}', { count: formatCount(row.result.repeat) }) }}</span>
                <span v-if="row.result.recall !== null">
                  {{ t('Coverage: {value}', { value: formatPercent(row.result.recall) }) }}
                </span>
                <span v-else class="na">{{ t('Coverage: {value}', { value: t('Unavailable') }) }}</span>
                <span v-if="row.result.error" style="color: var(--bad)">{{ t('Error') }}</span>
              </div>
            </button>
          </div>
          <div class="pager">
            <button class="btn btn-small" type="button" :disabled="page === 0" @click="goPage(-1)">
              {{ t('Previous') }}
            </button>
            <span>{{ pageLabel }}</span>
            <button
              class="btn btn-small"
              type="button"
              :disabled="page >= pageCount - 1"
              @click="goPage(1)"
            >
              {{ t('Next') }}
            </button>
          </div>
        </template>
      </div>

      <div v-if="!selected" class="empty-inline">{{ t('Select a result row to inspect its evidence.') }}</div>
      <div v-else class="detail">
        <div class="detail-head">
          <div style="min-width: 0">
            <div class="row" style="margin-bottom: 6px">
              <span class="badge accent">{{ backendName(report, selected.backend) }}</span>
              <span v-if="selectedBackend" class="badge" :class="statusTone(selectedBackend.status)">
                {{ statusLabel(selectedBackend.status) }}
              </span>
              <span class="badge">{{ phaseLabel(selected.phase) }}</span>
              <span class="badge">{{ t('Repeat {count}', { count: formatCount(selected.repeat) }) }}</span>
              <span class="badge">B{{ formatCount(selected.budget) }}</span>
              <span v-if="selected.error" class="badge failed">{{ t('Error') }}</span>
            </div>
            <h3 class="detail-title">{{ questionFor(selected.queryId) }}</h3>
            <div class="detail-sub">
              {{ t('Query') }} <span class="mono">{{ selected.queryId }}</span> ·
              {{ categoryLabel(selected.category) }} · {{ languageLabel(selected.language) }} · {{ t('Corpus') }}
              <span class="mono">{{ selected.corpusId }}</span>
              <template v-if="selectedQuery">
                · {{ t('Project') }} <span class="mono">{{ selectedQuery.projectId }}</span>
              </template>
            </div>
          </div>
        </div>

        <div v-if="selected.error" class="callout danger" style="margin-bottom: 12px">
          <strong>{{ t('QueryResult error:') }}</strong> {{ selected.error }}
        </div>

        <dl class="detail-grid">
          <div class="kv">
            <dt>{{ t('Backend mode') }}</dt>
            <dd>{{ selectedBackend ? modeLabel(selectedBackend.mode) : t('Unavailable') }}</dd>
          </div>
          <div class="kv">
            <dt>{{ t('Query latency') }}</dt>
            <dd>{{ formatMs(selected.latencyMs) }}</dd>
          </div>
          <div class="kv">
            <dt>{{ t('Context tokens') }}</dt>
            <dd>{{ formatCount(selected.contextTokens) }}</dd>
          </div>
          <div class="kv">
            <dt>{{ t('Literal fact coverage') }}</dt>
            <dd>{{ formatPercent(selected.recall) }}</dd>
          </div>
          <div class="kv">
            <dt>{{ t('Evidence precision') }}</dt>
            <dd>{{ formatPercent(selected.evidencePrecision) }}</dd>
          </div>
          <div class="kv">
            <dt>{{ t('Complete evidence') }}</dt>
            <dd>
              <template v-if="selected.completeEvidence === null">{{ t('Unavailable') }}</template>
              <template v-else>{{ selected.completeEvidence ? t('yes') : t('no') }}</template>
            </dd>
          </div>
          <div class="kv">
            <dt>{{ t('Stale evidence hit') }}</dt>
            <dd>{{ selected.staleHit ? t('yes') : t('no') }}</dd>
          </div>
          <div class="kv">
            <dt>{{ t('Scope leak') }}</dt>
            <dd>{{ selected.scopeLeak ? t('yes') : t('no') }}</dd>
          </div>
          <div class="kv">
            <dt>{{ t('Required / found / missing') }}</dt>
            <dd>
              {{ formatCount(selected.requiredFactIds.length) }} /
              {{ formatCount(selected.foundFactIds.length) }} /
              {{ formatCount(missingIds.length) }}
            </dd>
          </div>
          <div class="kv">
            <dt>{{ t('Answerable') }}</dt>
            <dd>
              <template v-if="selectedQuery">{{ selectedQuery.answerable ? t('yes') : t('no') }}</template>
              <template v-else>{{ t('Unavailable') }}</template>
            </dd>
          </div>
          <div class="kv">
            <dt>{{ t('As of') }}</dt>
            <dd>{{ selectedQuery ? formatDate(selectedQuery.asOf) : t('Unavailable') }}</dd>
          </div>
          <div class="kv">
            <dt>{{ t('Context length') }}</dt>
            <dd>{{ t('{count} chars', { count: formatCount(contextLength) }) }}</dd>
          </div>
        </dl>

        <div class="detail-section">
          <h4>{{ t('Gold required facts') }}</h4>
          <div v-if="requiredFacts.length === 0" class="empty-inline">
            {{ t('No required gold fact IDs recorded for this query.') }}
          </div>
          <div v-else class="fact-list">
            <div
              v-for="entry in requiredFacts"
              :key="entry.id"
              class="fact"
              :class="{ found: selected.foundFactIds.includes(entry.id), missing: !selected.foundFactIds.includes(entry.id) }"
            >
              <div class="fact-head">
                <span class="badge" :class="selected.foundFactIds.includes(entry.id) ? 'complete' : 'failed'">
                  {{ selected.foundFactIds.includes(entry.id) ? t('found') : t('missing') }}
                </span>
                <span v-if="entry.fact?.stale" class="badge" style="color: var(--warn)">{{ t('stale gold') }}</span>
                <span class="mono tiny">{{ entry.id }}</span>
              </div>
              <div class="fact-text">
                {{ entry.fact?.text ?? t('Gold fact text unavailable: id is not present in the dataset.') }}
              </div>
              <div v-if="entry.fact">
                <div v-if="entry.fact.aliases.length > 0" class="fact-meta">
                  {{ t('Literal aliases:') }}
                  <code v-for="alias in entry.fact.aliases" :key="alias" style="margin-right: 6px">{{ alias }}</code>
                </div>
                <div class="fact-meta">
                  {{ t('Source documents:') }}
                  {{ entry.fact.sourceDocumentIds.length > 0 ? entry.fact.sourceDocumentIds.join(', ') : t('none recorded') }}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="detail-section">
          <h4>{{ t('Evidence found / missing / stale / leak') }}</h4>
          <div class="row" style="margin-bottom: 10px">
            <span class="badge complete">{{ t('Found fact IDs: {count}', { count: formatCount(foundFacts.length) }) }}</span>
            <span class="badge failed">{{ t('Missing required fact IDs: {count}', { count: formatCount(missingFacts.length) }) }}</span>
            <span class="badge" :class="selected.staleHit ? 'running' : 'idle'">
              {{ t('Stale evidence hit') }}: {{ selected.staleHit ? t('yes') : t('no') }}
            </span>
            <span class="badge" :class="selected.scopeLeak ? 'failed' : 'idle'">
              {{ t('Scope leak') }}: {{ selected.scopeLeak ? t('yes') : t('no') }}
            </span>
            <span class="badge" :class="selected.completeEvidence === null ? 'idle' : selected.completeEvidence ? 'complete' : 'failed'">
              {{ t('Complete evidence') }}:
              {{ selected.completeEvidence === null ? t('Unavailable') : selected.completeEvidence ? t('yes') : t('no') }}
            </span>
          </div>

          <div v-if="missingFacts.length > 0" class="fact-list" style="margin-bottom: 10px">
            <div v-for="entry in missingFacts" :key="`missing-${entry.id}`" class="fact missing">
              <div class="fact-head">
                <span class="badge failed">{{ t('missing') }}</span>
                <span class="mono tiny">{{ entry.id }}</span>
              </div>
              <div class="fact-text">
                {{ entry.fact?.text ?? t('Gold fact text unavailable: id is not present in the dataset.') }}
              </div>
            </div>
          </div>

          <div v-if="extraFoundFacts.length > 0" class="fact-list" style="margin-bottom: 10px">
            <div v-for="entry in extraFoundFacts" :key="`extra-${entry.id}`" class="fact">
              <div class="fact-head">
                <span class="badge complete">{{ t('found outside required set') }}</span>
                <span class="mono tiny">{{ entry.id }}</span>
              </div>
              <div class="fact-text">
                {{ entry.fact?.text ?? t('Gold fact text unavailable: id is not present in the dataset.') }}
              </div>
            </div>
          </div>

          <div class="grid-2">
            <div>
              <div class="panel-section-title">{{ t('Forbidden fact IDs') }}</div>
              <div v-if="forbiddenFacts.length === 0" class="muted small">{{ t('No forbidden facts recorded.') }}</div>
              <ul v-else class="small dim">
                <li v-for="entry in forbiddenFacts" :key="`forbidden-${entry.id}`">
                  <span class="mono tiny">{{ entry.id }}</span>
                  <template v-if="entry.fact"> — {{ entry.fact.text }}</template>
                </li>
              </ul>
            </div>
            <div>
              <div class="panel-section-title">{{ t('Leaked fact IDs') }}</div>
              <div v-if="leakedFacts.length === 0" class="muted small">{{ t('No leaked fact IDs recorded.') }}</div>
              <ul v-else class="small dim">
                <li v-for="entry in leakedFacts" :key="`leaked-${entry.id}`">
                  <span class="mono tiny">{{ entry.id }}</span>
                  <template v-if="entry.fact"> — {{ entry.fact.text }}</template>
                </li>
              </ul>
            </div>
          </div>
          <p v-if="selected.staleHit && requiredFacts.some((entry) => entry.fact?.stale)" class="chart-note">
            {{ t('Stale gold facts were present in the required set and a stale-evidence hit was recorded.') }}
          </p>
        </div>

        <div class="detail-section">
          <h4>{{ t('Retrieved context (original text)') }}</h4>
          <details class="details" open>
            <summary>
              {{ t('Context text · {chars} chars · {tokens} tokens', { chars: formatCount(contextLength), tokens: formatCount(selected.contextTokens) }) }}
            </summary>
            <div class="details-body">
              <pre v-if="selected.context.length > 0" class="context-block">{{ selected.context }}</pre>
              <p v-else class="muted small">{{ t('Retrieved context is empty.') }}</p>
            </div>
          </details>
        </div>

        <div class="detail-section">
          <h4>{{ t('Retrieved items (original text)') }}</h4>
          <div v-if="selected.items.length === 0" class="empty-inline">
            {{ t('No retrieval items recorded in QueryResult.') }}
          </div>
          <div v-else class="item-list">
            <div v-for="(item, index) in selected.items" :key="item.id ?? index" class="retrieved-item">
              <div class="retrieved-item-head">
                <span class="badge">{{ t('Item {count}', { count: formatCount(index + 1) }) }}</span>
                <span v-if="item.id" class="mono">id: {{ item.id }}</span>
                <span v-if="isNum(item.score)">{{ t('Score') }}: {{ item.score }}</span>
                <span v-if="item.sourceIds && item.sourceIds.length > 0" class="mono">
                  {{ t('Sources') }}: {{ item.sourceIds.join(', ') }}
                </span>
              </div>
              <div class="retrieved-text">{{ item.text }}</div>
            </div>
          </div>
        </div>

        <div class="detail-section">
          <h4>{{ t('Answers & judge (original text)') }}</h4>
          <div v-if="selectedAnswers.length === 0" class="empty-inline">
            {{ t('No AnswerResult record matches this backend, query, and budget.') }}
          </div>
          <div v-else class="item-list">
            <div
              v-for="(answer, index) in selectedAnswers"
              :key="`${answer.backend}-${answer.queryId}-${answer.budget}-${index}`"
              class="answer-card"
              :class="answer.correct ? 'correct' : 'incorrect'"
            >
              <div class="row">
                <span class="badge" :class="answer.correct ? 'complete' : 'failed'">
                  {{ answer.correct ? t('correct') : t('incorrect') }}
                </span>
                <span class="badge" :class="answer.abstained ? 'running' : 'idle'">
                  {{ answer.abstained ? t('abstained') : t('answered') }}
                </span>
                <span class="badge">{{ t('Answer latency: {value}', { value: formatMs(answer.latencyMs) }) }}</span>
                <span class="badge">B{{ formatCount(answer.budget) }}</span>
              </div>
              <div class="answer-text">{{ answer.answer }}</div>
              <div v-if="answer.supportedFactIds.length > 0" class="fact-meta">
                {{ t('Supported fact IDs:') }}
                <span class="mono">{{ answer.supportedFactIds.join(', ') }}</span>
              </div>
              <div v-if="answer.judgeExplanation" class="answer-explanation">
                <strong>{{ t('Judge') }}:</strong> {{ answer.judgeExplanation }}
              </div>
            </div>
          </div>
          <p class="chart-note">
            {{ t('AnswerResult has no repeat/phase field, so every matching backend/query/budget answer is shown. Successful evaluations record reader-only latency; evaluation errors record elapsed reader/judge time. Both exclude retrieval latency.') }}
          </p>
        </div>

        <div class="detail-section">
          <h4>{{ t('Source documents (original transcripts)') }}</h4>
          <div v-if="sourceEntries.length === 0" class="empty-inline">
            {{ t('No gold-fact or retrieved-item source document IDs were recorded.') }}
          </div>
          <div v-else class="item-list">
            <div v-for="entry in sourceEntries" :key="entry.id" class="source-doc">
              <div class="source-doc-head">
                <span class="mono">{{ entry.id }}</span>
                <span v-if="entry.viaGold" class="badge accent">{{ t('gold source') }}</span>
                <span v-if="entry.viaRetrieval" class="badge">{{ t('retrieved source') }}</span>
                <template v-if="entry.document">
                  <span>{{ formatDate(entry.document.document.timestamp) }}</span>
                  <span>{{ entry.document.corpusId }}</span>
                  <span>{{ entry.document.projectId }}</span>
                  <span>{{ languageLabel(entry.document.language) }}</span>
                </template>
                <span v-else class="badge unavailable">{{ t('document unavailable') }}</span>
              </div>
              <details v-if="entry.document" class="details" style="margin-top: 6px">
                <summary>
                  {{ t('Show {count} transcript messages', { count: formatCount(entry.document.document.messages.length) }) }}
                </summary>
                <div class="details-body">
                  <div v-if="entry.document.document.messages.length === 0" class="muted small">
                    {{ t('This source document has no messages.') }}
                  </div>
                  <div v-else class="source-doc-messages">
                    <div
                      v-for="(message, index) in entry.document.document.messages"
                      :key="index"
                      class="source-message"
                    >
                      <span class="role">{{ message.role }}</span>{{ message.content }}
                    </div>
                  </div>
                </div>
              </details>
            </div>
          </div>
        </div>

        <div class="detail-section">
          <details class="details">
            <summary>{{ t('Raw QueryResult record') }}</summary>
            <div class="details-body">
              <pre class="json-block">{{ JSON.stringify(selected, null, 2) }}</pre>
            </div>
          </details>
        </div>
      </div>
    </div>
  </section>
</template>
