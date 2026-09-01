#!/usr/bin/env node
/**
 * Portable profile export/import (no DB -- profiles are just files).
 *
 * A profile on disk is three things:
 *   - identity.json          fingerprint (CAMOFOX_FINGERPRINT_FILE; default <profileDir>/identity.json)
 *   - <profileDir>/<sha256(userId)[:32]>/storage-state.json (+ meta.json)   cookies/localStorage/IndexedDB
 *   - proxy                  env (PROXY_*), NOT a file
 *
 * This bundles the two files + a manifest, and restores them onto another
 * host/slot with the exact same cookie keying as the engine (it imports the
 * engine's own getUserPersistencePaths). Three portability gotchas are handled
 * as explicit warnings, not silent failures:
 *   1. cookie dir key = sha256(userId) -> re-keyed automatically to the dest userId
 *   2. geo coherence   -> warns to use a same-geo PROXY_* (else timezone/locale/webrtc mismatch)
 *   3. IndexedDB       -> warns if the bundle lacks it (Gmail-style auth may not transfer)
 *
 * Usage:
 *   node scripts/profile-bundle.mjs export --profile-dir DIR --user-id ID \
 *        [--identity FILE] --out bundle.tgz
 *   node scripts/profile-bundle.mjs import --bundle bundle.tgz --profile-dir DIR \
 *        --user-id ID [--identity FILE] [--force]
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getUserPersistencePaths } from '../lib/persistence.js';

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}
async function readJsonSafe(p) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; }
}
function hasIndexedDB(storage) {
  return Array.isArray(storage?.origins)
    && storage.origins.some((o) => Array.isArray(o?.indexedDB) && o.indexedDB.length > 0);
}

export async function exportProfile({ profileDir, userId, identityPath, out }) {
  const idPath = identityPath || path.join(profileDir, 'identity.json');
  const { storageStatePath, metaPath } = getUserPersistencePaths(profileDir, userId);
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'cfx-profile-'));
  const warnings = [];

  let identity = null;
  if (await exists(idPath)) {
    await fs.copyFile(idPath, path.join(stage, 'identity.json'));
    identity = await readJsonSafe(idPath);
  } else {
    warnings.push(`no identity.json at ${idPath} (exporting cookies only)`);
  }

  let storage = null;
  if (await exists(storageStatePath)) {
    await fs.copyFile(storageStatePath, path.join(stage, 'storage-state.json'));
    storage = await readJsonSafe(storageStatePath);
    if (await exists(metaPath)) await fs.copyFile(metaPath, path.join(stage, 'meta.json'));
  } else {
    warnings.push(`no cookies for userId "${userId}" under ${profileDir} (exporting fingerprint only)`);
  }

  const manifest = {
    version: 1,
    exportedAt: new Date().toISOString(),
    userId,
    os: identity?.os ?? null,
    localeHint: identity?.fingerprint?.navigator?.language ?? null,
    hasIdentity: !!identity,
    hasCookies: !!storage,
    cookieCount: storage?.cookies?.length ?? 0,
    hasIndexedDB: hasIndexedDB(storage),
  };
  await fs.writeFile(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));
  if (manifest.hasCookies && !manifest.hasIndexedDB) {
    warnings.push('bundle has no IndexedDB records — auth logins (e.g. Gmail) may not transfer (capture with indexedDB:true)');
  }

  const outAbs = path.resolve(out);
  await fs.mkdir(path.dirname(outAbs), { recursive: true });
  execFileSync('tar', ['czf', outAbs, '-C', stage, '.']);
  await fs.rm(stage, { recursive: true, force: true });
  return { manifest, warnings, out: outAbs };
}

export async function importProfile({ bundle, profileDir, userId, identityPath, force = false }) {
  const idPath = identityPath || path.join(profileDir, 'identity.json');
  const { userDir, storageStatePath, metaPath } = getUserPersistencePaths(profileDir, userId);
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'cfx-profile-'));
  const warnings = [];
  try {
    execFileSync('tar', ['xzf', path.resolve(bundle), '-C', stage]);
    const manifest = (await readJsonSafe(path.join(stage, 'manifest.json'))) || {};

    const stagedId = path.join(stage, 'identity.json');
    if (await exists(stagedId)) {
      if ((await exists(idPath)) && !force) {
        throw new Error(`identity.json already exists at ${idPath} — refuse to overwrite (fingerprint is meant to be immutable); pass --force to override`);
      }
      await fs.mkdir(path.dirname(idPath), { recursive: true });
      await fs.copyFile(stagedId, idPath);
    }

    const stagedStorage = path.join(stage, 'storage-state.json');
    if (await exists(stagedStorage)) {
      if ((await exists(storageStatePath)) && !force) {
        throw new Error(`cookies already exist for userId "${userId}" at ${userDir} — pass --force to override`);
      }
      await fs.mkdir(userDir, { recursive: true });
      await fs.copyFile(stagedStorage, storageStatePath);
      const stagedMeta = path.join(stage, 'meta.json');
      if (await exists(stagedMeta)) await fs.copyFile(stagedMeta, metaPath);
    }

    if (manifest.userId && manifest.userId !== userId) {
      warnings.push(`re-keyed cookies from source userId "${manifest.userId}" to "${userId}"`);
    }
    if (manifest.hasCookies && !manifest.hasIndexedDB) {
      warnings.push('bundle has no IndexedDB — auth logins may need a re-login on first use');
    }
    warnings.push(`GEO: point PROXY_* at the SAME geo as this fingerprint (os=${manifest.os ?? '?'}, locale=${manifest.localeHint ?? '?'}). A different country/city mismatches timezone/locale/webrtc → detection.`);
    return { manifest, warnings, identityPath: idPath, userDir };
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

// --- CLI ---
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--force') { args.force = true; continue; }
    if (a.startsWith('--')) { args[a.slice(2)] = argv[++i]; }
  }
  return args;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = parseArgs(rest);
  const die = (m) => { console.error(`error: ${m}`); process.exit(1); };

  if (cmd === 'export') {
    if (!a['profile-dir'] || !a['user-id'] || !a.out) {
      die('export requires --profile-dir, --user-id, --out');
    }
    const { manifest, warnings, out } = await exportProfile({
      profileDir: a['profile-dir'], userId: a['user-id'], identityPath: a.identity, out: a.out,
    });
    console.log(`exported → ${out}`);
    console.log(JSON.stringify(manifest, null, 2));
    warnings.forEach((w) => console.warn(`warn: ${w}`));
  } else if (cmd === 'import') {
    if (!a.bundle || !a['profile-dir'] || !a['user-id']) {
      die('import requires --bundle, --profile-dir, --user-id');
    }
    const { warnings, identityPath, userDir } = await importProfile({
      bundle: a.bundle, profileDir: a['profile-dir'], userId: a['user-id'],
      identityPath: a.identity, force: a.force,
    });
    console.log(`imported → identity: ${identityPath}\n           cookies:  ${userDir}`);
    warnings.forEach((w) => console.warn(`warn: ${w}`));
  } else {
    die('usage: profile-bundle.mjs <export|import> [...] (see file header)');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(`error: ${err.message}`); process.exit(1); });
}
