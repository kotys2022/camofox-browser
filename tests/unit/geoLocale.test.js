/**
 * Tests for country -> locale mapping (FIXES.md #0 / SPEC-002). Pure, ICU-based.
 */
import { describe, test, expect } from '@jest/globals';
import { localeFromCountry } from '../../lib/geo-locale.js';

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
