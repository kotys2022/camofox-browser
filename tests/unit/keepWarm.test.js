/**
 * Tests for keep-warm decision logic (FIXES.md #8). Pure functions.
 */
import { describe, test, expect } from '@jest/globals';
import { isKeepWarm, shouldRewarmAfterClose } from '../../lib/keep-warm.js';

describe('isKeepWarm', () => {
  test('on when idle timeout is disabled (<= 0)', () => {
    expect(isKeepWarm(0)).toBe(true);
    expect(isKeepWarm(-1)).toBe(true);
  });
  test('off for a positive idle timeout or non-finite', () => {
    expect(isKeepWarm(300000)).toBe(false);
    expect(isKeepWarm(1)).toBe(false);
    expect(isKeepWarm(NaN)).toBe(false);
    expect(isKeepWarm(undefined)).toBe(false);
  });
});

describe('shouldRewarmAfterClose', () => {
  test('never re-warms when keep-warm is off', () => {
    expect(shouldRewarmAfterClose('browser_disconnected', false)).toBe(false);
    expect(shouldRewarmAfterClose('crash', false)).toBe(false);
  });

  test('re-warms unexpected closes under keep-warm', () => {
    for (const reason of ['browser_disconnected', 'browser_rss_pressure', 'memory_pressure', 'browser_restart:foo', 'crash']) {
      expect(shouldRewarmAfterClose(reason, true)).toBe(true);
    }
  });

  test('does NOT re-warm deliberate stops even under keep-warm', () => {
    expect(shouldRewarmAfterClose('shutdown:SIGTERM', true)).toBe(false);
    expect(shouldRewarmAfterClose('admin_stop', true)).toBe(false);
    expect(shouldRewarmAfterClose('idle_shutdown', true)).toBe(false);
  });

  test('tolerates null/undefined reason', () => {
    expect(shouldRewarmAfterClose(undefined, true)).toBe(true);
    expect(shouldRewarmAfterClose(null, false)).toBe(false);
  });
});
