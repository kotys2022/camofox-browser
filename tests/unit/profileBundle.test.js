/**
 * Round-trip test for profile export/import (scripts/profile-bundle.mjs).
 * Pure fs + tar; no browser. Verifies exact re-keying and no-clobber guard.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { exportProfile, importProfile } from '../../scripts/profile-bundle.mjs';

const hashDir = (userId) =>
  crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 32);

describe('profile-bundle export/import', () => {
  let src, dst, work;

  beforeEach(async () => {
    src = await fs.mkdtemp(path.join(os.tmpdir(), 'cfx-src-'));
    dst = await fs.mkdtemp(path.join(os.tmpdir(), 'cfx-dst-'));
    work = await fs.mkdtemp(path.join(os.tmpdir(), 'cfx-wrk-'));
    // identity.json at src root
    await fs.writeFile(path.join(src, 'identity.json'), JSON.stringify({
      version: 1, os: 'linux', fingerprint: { navigator: { language: 'de-DE' } },
    }));
    // cookies under the engine's sha256(userId) dir, with an IndexedDB origin
    const userDir = path.join(src, hashDir('acct-1'));
    await fs.mkdir(userDir, { recursive: true });
    await fs.writeFile(path.join(userDir, 'storage-state.json'), JSON.stringify({
      cookies: [{ name: 'sid', value: 'x' }],
      origins: [{ origin: 'https://mail.google.com', indexedDB: [{ name: 'db' }] }],
    }));
    await fs.writeFile(path.join(userDir, 'meta.json'), JSON.stringify({ savedAt: 1 }));
  });

  afterEach(async () => {
    for (const d of [src, dst, work]) await fs.rm(d, { recursive: true, force: true });
  });

  test('round-trips and re-keys cookies to the destination userId', async () => {
    const bundle = path.join(work, 'p.tgz');
    const exp = await exportProfile({ profileDir: src, userId: 'acct-1', out: bundle });
    expect(exp.manifest.hasCookies).toBe(true);
    expect(exp.manifest.hasIndexedDB).toBe(true);
    expect(exp.manifest.cookieCount).toBe(1);
    expect(exp.manifest.os).toBe('linux');

    const imp = await importProfile({ bundle, profileDir: dst, userId: 'acct-2' });

    // identity landed at dest root
    const idOut = JSON.parse(await fs.readFile(path.join(dst, 'identity.json'), 'utf8'));
    expect(idOut.os).toBe('linux');
    // cookies landed under the DEST userId's hash (re-keyed), not the source's
    const destCookies = path.join(dst, hashDir('acct-2'), 'storage-state.json');
    expect(JSON.parse(await fs.readFile(destCookies, 'utf8')).cookies[0].name).toBe('sid');
    await expect(fs.access(path.join(dst, hashDir('acct-1')))).rejects.toBeTruthy();

    expect(imp.warnings.join('\n')).toMatch(/re-keyed cookies from source userId "acct-1" to "acct-2"/);
    expect(imp.warnings.join('\n')).toMatch(/GEO:/);
  });

  test('refuses to clobber an existing identity without --force', async () => {
    const bundle = path.join(work, 'p.tgz');
    await exportProfile({ profileDir: src, userId: 'acct-1', out: bundle });
    await importProfile({ bundle, profileDir: dst, userId: 'acct-2' });

    await expect(importProfile({ bundle, profileDir: dst, userId: 'acct-2' }))
      .rejects.toThrow(/already exists|immutable|--force/);

    // --force overrides
    await expect(importProfile({ bundle, profileDir: dst, userId: 'acct-2', force: true }))
      .resolves.toBeTruthy();
  });

  test('exports fingerprint-only when the account has no cookies', async () => {
    const bundle = path.join(work, 'fp.tgz');
    const exp = await exportProfile({ profileDir: src, userId: 'no-such-account', out: bundle });
    expect(exp.manifest.hasIdentity).toBe(true);
    expect(exp.manifest.hasCookies).toBe(false);
    expect(exp.warnings.join('\n')).toMatch(/no cookies/);
  });

  test('warns when cookies lack IndexedDB (auth may not transfer)', async () => {
    const bareUser = path.join(src, hashDir('bare'));
    await fs.mkdir(bareUser, { recursive: true });
    await fs.writeFile(path.join(bareUser, 'storage-state.json'), JSON.stringify({
      cookies: [{ name: 'a', value: 'b' }], origins: [],
    }));
    const bundle = path.join(work, 'bare.tgz');
    const exp = await exportProfile({ profileDir: src, userId: 'bare', out: bundle });
    expect(exp.manifest.hasIndexedDB).toBe(false);
    expect(exp.warnings.join('\n')).toMatch(/no IndexedDB/);
  });
});
