/**
 * Tests for evaluate result shaping (projection + byte cap) -- FIXES.md #2.
 * Pure functions, no server spawn.
 */
import { describe, test, expect } from '@jest/globals';
import {
  projectResult,
  capResultBytes,
  shapeEvaluateResult,
} from '../../lib/evaluate-projection.js';

describe('projectResult', () => {
  const obj = { data: { items: [{ name: 'a' }, { name: 'b' }], count: 2 }, s: 'hi' };

  test('resolves dot + bracket paths', () => {
    expect(projectResult(obj, 'data.items[0].name')).toEqual({ matched: true, value: 'a' });
    expect(projectResult(obj, 'data.items.1.name')).toEqual({ matched: true, value: 'b' });
    expect(projectResult(obj, 'data.count')).toEqual({ matched: true, value: 2 });
  });

  test('returns matched:false for missing paths', () => {
    expect(projectResult(obj, 'data.nope')).toEqual({ matched: false, value: undefined });
    expect(projectResult(obj, 'data.items[9].name')).toEqual({ matched: false, value: undefined });
    expect(projectResult(obj, 's.deep.path')).toEqual({ matched: false, value: undefined });
  });

  test('empty path returns the whole value', () => {
    expect(projectResult(obj, '')).toEqual({ matched: true, value: obj });
  });
});

describe('capResultBytes', () => {
  test('passes through under the cap', () => {
    const r = capResultBytes('short', 100);
    expect(r.truncated).toBe(false);
    expect(r.value).toBe('short');
  });

  test('truncates a long string with a marker and true size', () => {
    const s = 'x'.repeat(1000);
    const r = capResultBytes(s, 50);
    expect(r.truncated).toBe(true);
    expect(r.totalBytes).toBe(1000);
    expect(r.value).toContain('truncated');
    expect(r.value).toContain('of 1000 bytes');
    expect(r.value.startsWith('x'.repeat(50))).toBe(true);
  });

  test('serializes objects before capping', () => {
    const big = { blob: 'y'.repeat(500) };
    const r = capResultBytes(big, 40);
    expect(r.truncated).toBe(true);
    expect(typeof r.value).toBe('string');
    expect(r.value.startsWith('{"blob":"yyy')).toBe(true);
  });

  test('does not split a multibyte char at the boundary', () => {
    const r = capResultBytes('€€€€€', 4); // each € is 3 bytes
    expect(r.truncated).toBe(true);
    // 4-byte cut lands mid-char; the partial byte is dropped -> one clean €
    expect(r.value.startsWith('€…')).toBe(true);
  });
});

describe('shapeEvaluateResult', () => {
  const result = { pageProps: { details: { pct: 19.4, huge: 'z'.repeat(10000) } } };

  test('no opts -> unchanged, empty meta', () => {
    expect(shapeEvaluateResult(result, {})).toEqual({ result, meta: {} });
    expect(shapeEvaluateResult(result)).toEqual({ result, meta: {} });
  });

  test('projection extracts only the subtree', () => {
    const out = shapeEvaluateResult(result, { projection: 'pageProps.details.pct' });
    expect(out.result).toBe(19.4);
    expect(out.meta.projection).toEqual({ path: 'pageProps.details.pct', matched: true });
    expect(out.meta.truncated).toBeUndefined();
  });

  test('missing projection -> null result, matched:false', () => {
    const out = shapeEvaluateResult(result, { projection: 'pageProps.missing' });
    expect(out.result).toBeNull();
    expect(out.meta.projection.matched).toBe(false);
  });

  test('maxBytes truncates and reports bytes', () => {
    const out = shapeEvaluateResult(result, { maxBytes: 100 });
    expect(out.meta.truncated).toBe(true);
    expect(out.meta.bytes.total).toBeGreaterThan(100);
    expect(out.meta.bytes.returned).toBeLessThanOrEqual(100);
    expect(typeof out.result).toBe('string');
  });

  test('projection then cap compose; small projected result is not truncated', () => {
    const out = shapeEvaluateResult(result, { projection: 'pageProps.details.pct', maxBytes: 100 });
    expect(out.result).toBe(19.4);
    expect(out.meta.truncated).toBeUndefined();
  });

  test('maxBytes ignored when non-positive or non-finite', () => {
    expect(shapeEvaluateResult(result, { maxBytes: 0 }).meta.truncated).toBeUndefined();
    expect(shapeEvaluateResult(result, { maxBytes: NaN }).meta.truncated).toBeUndefined();
  });
});
