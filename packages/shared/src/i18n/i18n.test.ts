import { describe, expect, it } from 'vitest';
import { en } from './en';
import { LOCALES, MissingMessageError, catalogues, placeholdersOf, t, type MessageKey } from './index';

describe('i18n', () => {
  it('interpolates params', () => {
    expect(t('contribution.thanks', { name: 'Tino' })).toBe(
      'Thank you, Tino. Your contribution has been received.',
    );
  });

  it('throws on a missing param rather than rendering a raw placeholder', () => {
    expect(() => t('contribution.thanks')).toThrow(MissingMessageError);
  });

  it('throws on an unknown key', () => {
    expect(() => t('nope.key' as MessageKey)).toThrow(MissingMessageError);
  });

  it('falls back to English for untranslated locales', () => {
    expect(t('app.name', {}, 'sn')).toBe('Chema Wallet');
  });

  it.each(LOCALES)('%s catalogue only uses English keys with identical placeholders', (locale) => {
    for (const [key, template] of Object.entries(catalogues[locale])) {
      expect(Object.keys(en)).toContain(key);
      expect(placeholdersOf(template ?? '')).toEqual(placeholdersOf(en[key as MessageKey]));
    }
  });
});
