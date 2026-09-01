/**
 * Tests for the capture-response URL matcher (FIXES.md #3). Pure function.
 */
import { describe, test, expect } from '@jest/globals';
import { buildUrlMatcher } from '../../lib/capture.js';

describe('buildUrlMatcher', () => {
  test('substring match (default)', () => {
    const m = buildUrlMatcher('/exclusive');
    expect(m('https://cryptorank.io/api/v0/exclusive?x=1')).toBe(true);
    expect(m('https://cryptorank.io/api/v0/public')).toBe(false);
  });

  test('substring is case-sensitive and literal', () => {
    const m = buildUrlMatcher('api/v0/coins');
    expect(m('https://h/api/v0/coins/vesting')).toBe(true);
    expect(m('https://h/API/V0/COINS')).toBe(false);
  });

  test('/regex/ form compiles a RegExp against the full URL', () => {
    const m = buildUrlMatcher('/\\/api\\/v\\d+\\/coins/');
    expect(m('https://h/api/v0/coins/x')).toBe(true);
    expect(m('https://h/api/v12/coins')).toBe(true);
    expect(m('https://h/api/vX/coins')).toBe(false);
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
