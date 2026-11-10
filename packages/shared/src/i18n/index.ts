// i18n: English live; Shona (sn) and Ndebele (nd) catalogues are i18n-ready
// and fall back to English per key until translations are approved (D15).
import { en, type MessageKey } from './en';

export const LOCALES = ['en', 'sn', 'nd'] as const;
export type Locale = (typeof LOCALES)[number];
export type { MessageKey };

export type Catalogue = Partial<Record<MessageKey, string>>;

export const catalogues: Record<Locale, Catalogue> = {
  en,
  sn: {},
  nd: {},
};

export class MissingMessageError extends Error {
  constructor(key: string, detail?: string) {
    super(detail ? `i18n ${key}: ${detail}` : `i18n: missing message key ${key}`);
    this.name = 'MissingMessageError';
  }
}

const PLACEHOLDER = /\{(\w+)\}/g;

export function placeholdersOf(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((m) => m[1] ?? '').sort();
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

export function t(key: MessageKey, params: Record<string, string> = {}, locale: Locale = 'en'): string {
  const template = catalogues[locale][key] ?? en[key];
  if (template === undefined) throw new MissingMessageError(key);
  return template.replace(PLACEHOLDER, (_m, name: string) => {
    const value = params[name];
    if (value === undefined) throw new MissingMessageError(key, `missing param {${name}}`);
    return value;
  });
}
