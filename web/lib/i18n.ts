import { createI18n } from 'vue-i18n';
import zhCN from '../locales/zh-CN';

export type Locale = 'en' | 'zh-CN';
const browserLanguage = typeof navigator === 'undefined' ? 'en' : navigator.language ?? 'en';

export const i18n = createI18n({
  legacy: false,
  locale: browserLanguage.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en',
  fallbackLocale: 'en',
  // Source-English keys are literal phrases, including punctuation, not nested property paths.
  messageResolver: (messages, key) => Object.prototype.hasOwnProperty.call(messages, key)
    ? Reflect.get(messages as object, key)
    : null,
  messages: {
    en: Object.fromEntries(Object.keys(zhCN).map(key => [key, key])),
    'zh-CN': zhCN,
  },
});
