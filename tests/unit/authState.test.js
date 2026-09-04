/**
 * Tests for sanitized auth-state summary (fork) -- lib/auth-state.js.
 * Pure filesystem reads, no server spawn.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  summarizeAuthState,
  domainMatches,
  normalizeHost,
  isLiveCookie,
} from '../../lib/auth-state.js';
import { getUserPersistencePaths } from '../../lib/persistence.js';

const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const PAST = Math.floor(Date.now() / 1000) - 3600;

async function writeState(profileDir, userId, cookies) {
  const { userDir, storageStatePath } = getUserPersistencePaths(profileDir, userId);
  await fs.mkdir(userDir, { recursive: true });
  await fs.writeFile(storageStatePath, JSON.stringify({ cookies, origins: [] }));
}

describe('normalizeHost / domainMatches', () => {
  test('strips leading dot and lowercases', () => {
    expect(normalizeHost('.X.com')).toBe('x.com');
    expect(normalizeHost('  Twitter.COM ')).toBe('twitter.com');
  });

  test('matches domain and subdomains, not siblings', () => {
    expect(domainMatches('.x.com', 'x.com')).toBe(true); // cookie for .x.com covers x.com
    expect(domainMatches('sub.x.com', 'x.com')).toBe(true); // subdomain
    expect(domainMatches('x.com', 'twitter.com')).toBe(false);
    expect(domainMatches('notx.com', 'x.com')).toBe(false); // suffix but not a subdomain
    expect(domainMatches('', 'x.com')).toBe(false);
  });
});

describe('isLiveCookie', () => {
  const nowSec = Math.floor(Date.now() / 1000);
  test('session cookie (-1) and missing expiry count as live', () => {
    expect(isLiveCookie({ expires: -1 }, nowSec)).toBe(true);
    expect(isLiveCookie({}, nowSec)).toBe(true);
  });
  test('future live, past expired', () => {
    expect(isLiveCookie({ expires: FUTURE }, nowSec)).toBe(true);
    expect(isLiveCookie({ expires: PAST }, nowSec)).toBe(false);
  });
});

describe('summarizeAuthState', () => {
  let profileDir;
  beforeAll(async () => {
    profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cfx-auth-'));
    await writeState(profileDir, 'logged', [
      { name: 'auth_token', value: 'SECRET', domain: '.x.com', expires: FUTURE },
      { name: 'sess', value: 'SECRET2', domain: 'reddit.com', expires: -1 },
      { name: 'stale', value: 'OLD', domain: '.linkedin.com', expires: PAST },
    ]);
  });
  afterAll(async () => {
    await fs.rm(profileDir, { recursive: true, force: true });
  });

  test('reports per-domain presence, no values leaked', async () => {
    const out = await summarizeAuthState({
      profileDir,
      userId: 'logged',
      domains: ['x.com', 'reddit.com', 'twitter.com'],
    });
    expect(out.hasStorageState).toBe(true);
    expect(out.hasSavedLogin).toBe(true);
    expect(out.domains).toEqual({ 'x.com': true, 'reddit.com': true, 'twitter.com': false });
    // sanitized: serialized result must not contain any cookie value
    expect(JSON.stringify(out)).not.toMatch(/SECRET/);
  });

  test('expired cookies excluded by default, included with ignoreExpired=false', async () => {
    const def = await summarizeAuthState({ profileDir, userId: 'logged', domains: ['linkedin.com'] });
    expect(def.domains['linkedin.com']).toBe(false);
    const incl = await summarizeAuthState({
      profileDir,
      userId: 'logged',
      domains: ['linkedin.com'],
      ignoreExpired: false,
    });
    expect(incl.domains['linkedin.com']).toBe(true);
  });

  test('no domains requested -> hasSavedLogin reflects any live cookie', async () => {
    const out = await summarizeAuthState({ profileDir, userId: 'logged', domains: [] });
    expect(out.hasSavedLogin).toBe(true);
    expect(out.domains).toEqual({});
  });

  test('unknown userId -> no storage state, all false', async () => {
    const out = await summarizeAuthState({ profileDir, userId: 'nobody', domains: ['x.com'] });
    expect(out).toEqual({ hasStorageState: false, hasSavedLogin: false, domains: { 'x.com': false } });
  });

  test('missing profileDir -> empty summary', async () => {
    const out = await summarizeAuthState({ profileDir: '', userId: 'logged', domains: ['x.com'] });
    expect(out.hasStorageState).toBe(false);
    expect(out.hasSavedLogin).toBe(false);
  });
});
