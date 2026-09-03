/**
 * Tests for the capture-response URL matcher (fork change #3). Pure function.
 */
import { describe, test, expect } from '@jest/globals';
import { buildUrlMatcher } from '../../lib/capture.js';

describe('buildUrlMatcher', () => {
  test('substring match (default)', () => {
    const m = buildUrlMatcher('/exclusive');
    expect(m('https://example.com/api/v0/exclusive?x=1')).toBe(true);
    expect(m('https://example.com/api/v0/public')).toBe(false);
  });

  test('substring is case-sensitive and literal', () => {
    const m = buildUrlMatcher('api/v0/items');
    expect(m('https://h/api/v0/items/detail')).toBe(true);
    expect(m('https://h/API/V0/ITEMS')).toBe(false);
  });

  test('/regex/ form compiles a RegExp against the full URL', () => {
    const m = buildUrlMatcher('/\\/api\\/v\\d+\\/items/');
    expect(m('https://h/api/v0/items/x')).toBe(true);
    expect(m('https://h/api/v12/items')).toBe(true);
    expect(m('https://h/api/vX/items')).toBe(false);
  });

  test('non-string / empty pattern throws', () => {
    expect(() => buildUrlMatcher('')).toThrow(/non-empty string/);
    expect(() => buildUrlMatcher(null)).toThrow(/non-empty string/);
    expect(() => buildUrlMatcher(42)).toThrow(/non-empty string/);
  });

  test('matcher tolerates non-string input', () => {
    const m = buildUrlMatcher('/x');
    expect(m(undefined)).toBe(false);
    expect(m(null)).toBe(false);
  });
});
