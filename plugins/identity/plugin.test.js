import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';
import { createPluginEvents } from '../../lib/plugins.js';
import { launchOptions } from 'camoufox-js';
import { register } from './index.js';

// Minimal launchArgs mirroring server.js launchBrowserInstance().
function makeLaunchArgs() {
  return {
    os: 'linux',
    humanize: true,
    enable_cache: true,
    geoip: false,
    proxy: null,
  };
}

describe('identity plugin', () => {
  let tmpDir, events, ctx, mockApp;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-identity-'));
    events = createPluginEvents();
    mockApp = {};
    ctx = { events, config: { profileDir: tmpDir }, log: jest.fn() };
  });

  afterEach(async () => {
    delete process.env.CAMOFOX_FINGERPRINT_FILE;
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('disables when no fingerprintFile and no profileDir', async () => {
    ctx.config = {};
    await register(mockApp, ctx, {});
    expect(ctx.log).toHaveBeenCalledWith('warn', expect.stringContaining('no fingerprintFile'));
  });

  test('generates identity.json on first launch and reuses it (stable fp + seeds)', async () => {
    const file = path.join(tmpDir, 'identity.json');
    await register(mockApp, ctx, { fingerprintFile: file });

    const a = makeLaunchArgs();
    await events.emitAsync('browser:launchOptions', { launchArgs: a });

    // File written and injected on first launch.
    const saved = JSON.parse(await fs.readFile(file, 'utf-8'));
    expect(saved.fingerprint).toBeTruthy();
    expect(saved.config['audio:seed']).toBeGreaterThan(0);
    expect(a.fingerprint).toEqual(saved.fingerprint);
    expect(a.config['canvas:seed']).toBe(saved.config['canvas:seed']);

    // Second (relaunch) reads the same file -> identical identity.
    const b = makeLaunchArgs();
    await events.emitAsync('browser:launchOptions', { launchArgs: b });
    expect(b.fingerprint).toEqual(a.fingerprint);
    expect(b.config).toEqual(a.config);
  });

  test('does not clobber a fingerprint already set by another plugin', async () => {
    await register(mockApp, ctx, { fingerprintFile: path.join(tmpDir, 'identity.json') });
    const a = makeLaunchArgs();
    a.fingerprint = { sentinel: true };
    await events.emitAsync('browser:launchOptions', { launchArgs: a });
    expect(a.fingerprint).toEqual({ sentinel: true });
  });

  test('generate=false with no file falls back to random (no injection, no write)', async () => {
    const file = path.join(tmpDir, 'missing.json');
    await register(mockApp, ctx, { fingerprintFile: file, generate: false });
    const a = makeLaunchArgs();
    await events.emitAsync('browser:launchOptions', { launchArgs: a });
    expect(a.fingerprint).toBeUndefined();
    await expect(fs.access(file)).rejects.toBeTruthy();
  });

  // Requires the camoufox browser build (loadProperties/launchPath) -- launchOptions()
  // will otherwise try to *download* ~663MB. Gated behind RUN_LIVE_TESTS so normal
  // runs never touch the network (matches the repo's test:live convention).
  const maybeLive = process.env.RUN_LIVE_TESTS ? test : test.skip;
  maybeLive('injected config produces stable CAMOU_CONFIG env across launches (end-to-end)', async () => {
    const file = path.join(tmpDir, 'identity.json');
    await register(mockApp, ctx, { fingerprintFile: file });

    const collect = async () => {
      const args = makeLaunchArgs();
      await events.emitAsync('browser:launchOptions', { launchArgs: args });
      const opts = await launchOptions(args);
      return Object.fromEntries(
        Object.entries(opts.env).filter(([k]) => k.startsWith('CAMOU_CONFIG_')),
      );
    };

    const first = await collect();
    const second = await collect();
    expect(second).toEqual(first);
  }, 30000);
});
