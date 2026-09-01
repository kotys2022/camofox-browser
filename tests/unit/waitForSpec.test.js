/**
 * Tests for the waitFor readiness-spec normalizer (FIXES.md #4). Pure function.
 */
import { describe, test, expect } from '@jest/globals';
import { normalizeWaitFor } from '../../lib/wait-for.js';

describe('normalizeWaitFor', () => {
  test('null/undefined -> null (no waiting)', () => {
    expect(normalizeWaitFor(null)).toBeNull();
    expect(normalizeWaitFor(undefined)).toBeNull();
  });

  test('selector spec with default timeout', () => {
    expect(normalizeWaitFor({ selector: '#app .ready' })).toEqual({
      selector: '#app .ready',
      timeoutMs: 15000,
    });
  });

  test('text spec with custom timeout', () => {
    expect(normalizeWaitFor({ text: 'Vesting', timeoutMs: 5000 })).toEqual({
      text: 'Vesting',
      timeoutMs: 5000,
    });
  });

  test('networkQuietMs spec', () => {
    expect(normalizeWaitFor({ networkQuietMs: 800 })).toEqual({
      networkQuietMs: 800,
      timeoutMs: 15000,
    });
  });

  test('timeoutMs is capped at 60000', () => {
    expect(normalizeWaitFor({ selector: '#x', timeoutMs: 999999 }).timeoutMs).toBe(60000);
  });

  test('requires exactly one condition', () => {
    expect(() => normalizeWaitFor({})).toThrow(/requires one of/);
    expect(() => normalizeWaitFor({ selector: '#a', text: 'b' })).toThrow(/exactly one/);
  });

  test('rejects wrong types', () => {
    expect(() => normalizeWaitFor([])).toThrow(/must be an object/);
    expect(() => normalizeWaitFor({ selector: '' })).toThrow(/non-empty string/);
    expect(() => normalizeWaitFor({ text: 42 })).toThrow(/non-empty string/);
    expect(() => normalizeWaitFor({ networkQuietMs: 0 })).toThrow(/positive integer/);
    expect(() => normalizeWaitFor({ networkQuietMs: 1.5 })).toThrow(/positive integer/);
    expect(() => normalizeWaitFor({ selector: '#x', timeoutMs: -1 })).toThrow(/positive integer/);
  });
});
