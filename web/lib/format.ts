import { computed } from 'vue';
import { i18n } from './i18n';

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

export function isNum(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

const formatters = computed(() => {
  const locale = i18n.global.locale.value === 'zh-CN' ? 'zh-CN' : 'en-US';
  return {
    numbers: [0, 1, 2, 3].map(maximumFractionDigits => new Intl.NumberFormat(locale, { maximumFractionDigits })),
    significant: new Intl.NumberFormat(locale, { maximumSignificantDigits: 3 }),
    percentSignificant: new Intl.NumberFormat(locale, { style: 'percent', maximumSignificantDigits: 3 }),
    percent: new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }),
    percentCompact: new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }),
    currency: new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }),
    currencySmall: new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', minimumFractionDigits: 6, maximumFractionDigits: 6 }),
    currencyTiny: new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', minimumFractionDigits: 8, maximumFractionDigits: 8 }),
    date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }),
    list: new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }),
  };
});

export function formatCount(value: number | null | undefined): string {
  return isNum(value) ? formatters.value.numbers[0].format(value) : i18n.global.t('Unavailable');
}

export function formatDecimal(value: number | null | undefined): string {
  return isNum(value) ? formatters.value.numbers[1].format(value) : i18n.global.t('Unavailable');
}

export function formatPrecise(value: number | null | undefined): string {
  if (!isNum(value)) return i18n.global.t('Unavailable');
  return value !== 0 && Math.abs(value) < 0.001
    ? formatters.value.significant.format(value)
    : formatters.value.numbers[3].format(value);
}

export function formatPercent(value: number | null | undefined): string {
  if (!isNum(value)) return i18n.global.t('Unavailable');
  return value !== 0 && Math.abs(value) < 0.001
    ? formatters.value.percentSignificant.format(value)
    : formatters.value.percent.format(value);
}

export function formatPercentCompact(value: number | null | undefined): string {
  return isNum(value) ? formatters.value.percentCompact.format(value) : i18n.global.t('Unavailable');
}

export function formatMs(value: number | null | undefined): string {
  if (!isNum(value)) return i18n.global.t('Unavailable');
  if (value === 0) return '0 ms';
  if (Math.abs(value) < 0.001) return `${formatPrecise(value)} ms`;
  const digits = Math.abs(value) < 1 ? 3 : Math.abs(value) < 10 ? 2 : 1;
  return `${formatters.value.numbers[digits].format(value)} ms`;
}

export function formatCi(ci: [number, number] | null | undefined): string {
  if (!ci || !isNum(ci[0]) || !isNum(ci[1])) return i18n.global.t('Unavailable');
  return `${formatPercent(ci[0])} – ${formatPercent(ci[1])}`;
}

export function formatBytes(value: number | null | undefined): string {
  if (!isNum(value)) return i18n.global.t('Unavailable');
  if (value === 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const exponent = Math.max(
    0,
    Math.min(units.length - 1, Math.floor(Math.log(Math.abs(value)) / Math.log(1024))),
  );
  const scaled = value / 1024 ** exponent;
  return `${formatters.value.numbers[2].format(scaled)} ${units[exponent]}`;
}

export function formatUsd(value: number | null | undefined): string {
  if (!isNum(value)) return i18n.global.t('Unavailable');
  if (value === 0) return formatters.value.currency.format(value);
  const absolute = Math.abs(value);
  if (absolute < 0.0001) return formatters.value.currencyTiny.format(value);
  if (absolute < 0.01) return formatters.value.currencySmall.format(value);
  return formatters.value.currency.format(value);
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return i18n.global.t('Unavailable');
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : formatters.value.date.format(date);
}

export function formatDurationMs(value: number | null | undefined): string {
  if (!isNum(value)) return i18n.global.t('Unavailable');
  if (value < 1000) return `${formatters.value.numbers[1].format(value)} ms`;
  return `${formatters.value.numbers[2].format(value / 1000)} s`;
}

export function formatList(values: readonly string[]): string {
  return values.length > 0 ? formatters.value.list.format(values) : i18n.global.t('Unavailable');
}
