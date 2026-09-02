/**
 * Tests for the proxy-pool 'list' mode (FIXES.md #10): a pool of distinct
 * full-proxy endpoints rotated per context.
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { createProxyPool } from '../../lib/proxy.js';
import { loadConfig } from '../../lib/config.js';

const entry = (host, port, scheme = 'http', username = 'u', password = 'p') => ({
  scheme, host, port, username, password,
});

describe('createProxyPool - list mode', () => {
  test('returns null when strategy is list but no entries', () => {
    expect(createProxyPool({ strategy: 'list', urls: [] })).toBeNull();
    expect(createProxyPool({ strategy: 'list' })).toBeNull();
  });

  test('builds a pool; getNext round-robins across entries per context', () => {
    const pool = createProxyPool({
      strategy: 'list',
      urls: [entry('a.example', '1111'), entry('b.example', '2222'), entry('c.example', '3333')],
    });
    expect(pool.mode).toBe('list');
    expect(pool.size).toBe(3);
    expect(pool.canRotateSessions).toBe(false);
    expect(pool.launchRetries).toBe(3);
    const servers = [pool.getNext(), pool.getNext(), pool.getNext(), pool.getNext()].map((p) => p.server);
    expect(servers).toEqual([
      'http://a.example:1111',
      'http://b.example:2222',
      'http://c.example:3333',
      'http://a.example:1111', // wraps
    ]);
  });

  test('getLaunchProxy rotates across attempts (dead endpoint retried with next)', () => {
    const pool = createProxyPool({
      strategy: 'list',
      urls: [entry('a.example', '1111'), entry('b.example', '2222')],
    });
    expect(pool.getLaunchProxy().server).toBe('http://a.example:1111');
    expect(pool.getLaunchProxy().server).toBe('http://b.example:2222');
    expect(pool.getLaunchProxy().server).toBe('http://a.example:1111');
  });

  test('carries scheme and credentials; omits empty port', () => {
    const pool = createProxyPool({
      strategy: 'list',
      urls: [entry('h', '', 'socks5', 'user', 'pass')],
    });
    const p = pool.getNext();
    expect(p).toEqual({ server: 'socks5://h', username: 'user', password: 'pass' });
  });

  test('launchRetries capped at 10', () => {
    const urls = Array.from({ length: 25 }, (_, i) => entry(`h${i}`, String(1000 + i)));
    expect(createProxyPool({ strategy: 'list', urls }).launchRetries).toBe(10);
  });
});

describe('loadConfig - PROXY_URLS', () => {
  const KEYS = ['PROXY_URLS', 'CAMOFOX_PROXY_LIST_FILE', 'PROXY_STRATEGY', 'PROXY_URL', 'PROXY_HOST'];
  let saved;
  beforeEach(() => { saved = {}; for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  test('PROXY_URLS activates list strategy and parses/dedupes entries', () => {
    process.env.PROXY_URLS = 'http://u:p@a.example:1111\nhttp://u:p@b.example:2222, http://u:p@a.example:1111';
    const p = loadConfig().proxy;
    expect(p.strategy).toBe('list');
    expect(p.urls.map((e) => `${e.host}:${e.port}`)).toEqual(['a.example:1111', 'b.example:2222']); // deduped
  });

  test('no PROXY_URLS -> not list strategy', () => {
    expect(loadConfig().proxy.strategy).not.toBe('list');
    expect(loadConfig().proxy.urls).toEqual([]);
  });

  test('explicit PROXY_STRATEGY overrides list default', () => {
    process.env.PROXY_URLS = 'http://u:p@a.example:1111';
    process.env.PROXY_STRATEGY = 'backconnect';
    expect(loadConfig().proxy.strategy).toBe('backconnect');
  });
});
