/**
 * Tests for the PROXY_URL parser (fork change #9). Pure function.
 */
import { describe, test, expect } from '@jest/globals';
import { parseProxyUrl } from '../../lib/config.js';

describe('parseProxyUrl', () => {
  test('empty / undefined -> {} (fall back to discrete PROXY_* vars)', () => {
    expect(parseProxyUrl('')).toEqual({});
    expect(parseProxyUrl(undefined)).toEqual({});
    expect(parseProxyUrl('   ')).toEqual({});
  });

  test('http url with credentials, host and port', () => {
    expect(parseProxyUrl('http://user:pass@s-50809.sp6.ovh:11001')).toEqual({
      scheme: 'http',
      host: 's-50809.sp6.ovh',
      port: '11001',
      username: 'user',
      password: 'pass',
    });
  });

  test('socks5 scheme is honored', () => {
    expect(parseProxyUrl('socks5://u:p@1.2.3.4:1080').scheme).toBe('socks5');
  });

  test('percent-encoded credentials are decoded', () => {
    const r = parseProxyUrl('http://user%40acme:p%40ss%3Aword@host:8080');
    expect(r.username).toBe('user@acme');
    expect(r.password).toBe('p@ss:word');
  });

  test('url without port -> empty port string', () => {
    expect(parseProxyUrl('http://host').port).toBe('');
  });

  test('url without credentials -> empty username/password', () => {
    const r = parseProxyUrl('http://host:3128');
    expect(r.username).toBe('');
    expect(r.password).toBe('');
  });

  test('malformed url -> {} (never aborts launch)', () => {
    expect(parseProxyUrl('not a url')).toEqual({});
    expect(parseProxyUrl('://missing-scheme')).toEqual({});
  });

  test('unsupported scheme -> {} ', () => {
    expect(parseProxyUrl('ftp://host:21')).toEqual({});
    expect(parseProxyUrl('https://host:443').scheme).toBe('https');
  });
});
