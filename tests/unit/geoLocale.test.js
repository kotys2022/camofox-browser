/**
 * Tests for country -> locale mapping (FIXES.md #0). Pure, ICU-based.
 */
import { describe, test, expect } from '@jest/globals';
import { localeFromCountry, applyLocaleToFingerprint } from '../../lib/geo-locale.js';

describe('localeFromCountry', () => {
  test('maps common proxy countries to their primary locale', () => {
    expect(localeFromCountry('DE')).toBe('de-DE');
    expect(localeFromCountry('FR')).toBe('fr-FR');
    expect(localeFromCountry('US')).toBe('en-US');
    expect(localeFromCountry('GB')).toBe('en-GB');
    expect(localeFromCountry('JP')).toBe('ja-JP');
    expect(localeFromCountry('UA')).toBe('uk-UA');
    expect(localeFromCountry('BR')).toBe('pt-BR');
  });

  test('is case-insensitive', () => {
    expect(localeFromCountry('de')).toBe('de-DE');
    expect(localeFromCountry('Fr')).toBe('fr-FR');
  });

  test('returns null for missing / malformed input', () => {
    for (const bad of [null, undefined, '', 'D', 'DEU', 'D1', 12, '  ']) {
      expect(localeFromCountry(bad)).toBeNull();
    }
  });
});

describe('applyLocaleToFingerprint', () => {
  const fp = (lang) => ({ navigator: { language: lang, languages: [lang], userAgent: 'x' }, screen: {} });

  test('overwrites only navigator.language / languages, in place', () => {
    const f = fp('en-US');
    const r = applyLocaleToFingerprint(f, 'de-DE');
    expect(r).toEqual({ changed: true, from: 'en-US', to: 'de-DE' });
    expect(f.navigator.language).toBe('de-DE');
    expect(f.navigator.languages).toEqual(['de-DE']);
    expect(f.navigator.userAgent).toBe('x'); // identifying fields untouched
    expect(f.screen).toEqual({});
  });

  test('no-op when locale already matches', () => {
    const f = fp('de-DE');
    expect(applyLocaleToFingerprint(f, 'de-DE')).toEqual({ changed: false, from: 'de-DE', to: 'de-DE' });
    expect(f.navigator.languages).toEqual(['de-DE']);
  });

  test('no-op on falsy locale or missing navigator', () => {
    const f = fp('en-US');
    expect(applyLocaleToFingerprint(f, null)).toEqual({ changed: false });
    expect(f.navigator.language).toBe('en-US');
    expect(applyLocaleToFingerprint({}, 'de-DE')).toEqual({ changed: false });
    expect(applyLocaleToFingerprint(undefined, 'de-DE')).toEqual({ changed: false });
  });
});
