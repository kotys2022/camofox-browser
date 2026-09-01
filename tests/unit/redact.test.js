/**
 * Tests for tool-arg redaction/truncation (FIXES.md #7). Pure functions.
 */
import { describe, test, expect } from '@jest/globals';
import { redactSecrets, redactToolArg } from '../../lib/redact.js';

describe('redactSecrets', () => {
  test('masks quoted secret values, keeps the key', () => {
    expect(redactSecrets(`{password: "hunter2"}`)).toBe(`{password: "***"}`);
    expect(redactSecrets(`Authorization: 'Bearer abc123xyz'`)).toBe(`Authorization: '***'`);
    expect(redactSecrets(`{"token":"eyJhbGciOi"}`)).toBe(`{"token":"***"}`);
  });

  test('masks unquoted secret values', () => {
    expect(redactSecrets('api_key=sk_live_0123456789')).toBe('api_key=***');
    expect(redactSecrets('access-key = AKIA1234567890')).toBe('access-key = ***');
  });

  test('leaves non-secret content intact', () => {
    const s = 'document.querySelector("#price").innerText';
    expect(redactSecrets(s)).toBe(s);
  });

  test('handles multiple secrets in one string', () => {
    const out = redactSecrets(`fetch(u,{headers:{authorization:"Bearer T",cookie:"sid=xyz"}})`);
    expect(out).not.toContain('Bearer T');
    expect(out).toContain('authorization:"***"');
  });
});

describe('redactToolArg', () => {
  test('redacts then passes through under the cap', () => {
    expect(redactToolArg('a=1', 100)).toBe('a=1');
    expect(redactToolArg('password:"x1234"', 100)).toBe('password:"***"');
  });

  test('caps long input with a byte marker', () => {
    const s = 'x'.repeat(1000);
    const out = redactToolArg(s, 50);
    expect(out.startsWith('x'.repeat(50))).toBe(true);
    expect(out).toMatch(/…\[\+\d+B\]$/);
  });

  test('redaction happens before the cap', () => {
    const out = redactToolArg(`token:"SECRETVALUE" ${'y'.repeat(1000)}`, 40);
    expect(out).not.toContain('SECRETVALUE');
    expect(out).toContain('token:"***"');
  });
});
