/**
 * Tests for default virtual-display resolution parsing (FIXES.md #5). Pure fn.
 */
import { describe, test, expect } from '@jest/globals';
import { normalizeDisplayResolution, DEFAULT_DISPLAY_RESOLUTION } from '../../lib/display.js';

describe('normalizeDisplayResolution', () => {
  test('WxH gets a default depth of 24', () => {
    expect(normalizeDisplayResolution('1920x1080')).toBe('1920x1080x24');
    expect(normalizeDisplayResolution('1280x720')).toBe('1280x720x24');
  });

  test('WxHxDepth is preserved', () => {
    expect(normalizeDisplayResolution('1600x900x16')).toBe('1600x900x16');
    expect(normalizeDisplayResolution('1920x1080x24')).toBe('1920x1080x24');
  });

  test('case/whitespace tolerant', () => {
    expect(normalizeDisplayResolution('  1920X1080  ')).toBe('1920x1080x24');
  });

  test('malformed / missing -> null (caller falls back to default)', () => {
    for (const bad of [null, undefined, '', 'abc', '1920', '1920x', 'x1080', '0x1080', '1920x0', '12x34x0']) {
      expect(normalizeDisplayResolution(bad)).toBeNull();
    }
  });

  test('DEFAULT_DISPLAY_RESOLUTION is a real (non-1x1) size', () => {
    expect(DEFAULT_DISPLAY_RESOLUTION).toBe('1280x720x24');
    expect(normalizeDisplayResolution(DEFAULT_DISPLAY_RESOLUTION)).toBe('1280x720x24');
  });
});
