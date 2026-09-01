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

    // File written on first launch: full portable superset of seeds.
    const saved = JSON.parse(await fs.readFile(file, 'utf-8'));
    expect(saved.fingerprint).toBeTruthy();
    expect(saved.config['audio:seed']).toBeGreaterThan(0);
    expect(saved.config['canvas:seed']).toBeGreaterThan(0);

    // Injected fingerprint matches; injected config is the (possibly schema-
    // filtered) subset of the persisted config -- every injected key/value must
    // come from the saved superset. (A real build filters out audio:seed/
    // canvas:seed; a host without the binary injects the whole set.)
    expect(a.fingerprint).toEqual(saved.fingerprint);
    expect(Object.keys(a.config).length).toBeGreaterThan(0);
    for (const [k, v] of Object.entries(a.config)) {
      expect(saved.config[k]).toBe(v);
    }

    // Second (relaunch) reads the same file -> identical injected identity.
    const b = makeLaunchArgs();
    await events.emitAsync('browser:launchOptions', { launchArgs: b });
    expect(b.fingerprint).toEqual(a.fingerprint);
    expect(b.config).toEqual(a.config);
  });

  test('filters injected seeds to the build property schema (regression: audio:seed)', async () => {
    // Fake build dir whose properties.json lacks audio:seed / canvas:seed
    // (mirrors the Firefox-135 camoufox schema that rejected them).
    const binDir = path.join(tmpDir, 'bin');
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(path.join(binDir, 'properties.json'), JSON.stringify([
      { property: 'fonts:spacing_seed', type: 'uint' },
      { property: 'window.history.length', type: 'uint' },
    ]));
    const file = path.join(tmpDir, 'identity.json');
    await register(mockApp, ctx, { fingerprintFile: file });

    const a = makeLaunchArgs();
    a.executable_path = path.join(binDir, 'camoufox'); // -> dirname/properties.json
    await events.emitAsync('browser:launchOptions', { launchArgs: a });

    // Injected config keeps only schema-known seeds.
    expect(a.config['fonts:spacing_seed']).toBeGreaterThan(0);
    expect(a.config['window.history.length']).toBeGreaterThan(0);
    expect('audio:seed' in a.config).toBe(false);
    expect('canvas:seed' in a.config).toBe(false);

    // identity.json still persists the full portable superset.
    const saved = JSON.parse(await fs.readFile(file, 'utf-8'));
    expect(saved.config['audio:seed']).toBeGreaterThan(0);
    expect(saved.config['canvas:seed']).toBeGreaterThan(0);
  });

  test('pins canvas:aaOffset in CAMOU_CONFIG env chunks on browser:launching', async () => {
    const binDir = path.join(tmpDir, 'bin');
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(path.join(binDir, 'properties.json'), JSON.stringify([
      { property: 'canvas:aaOffset', type: 'int' },
      { property: 'canvas:aaCapOffset', type: 'bool' },
      { property: 'fonts:spacing_seed', type: 'uint' },
      { property: 'window.history.length', type: 'uint' },
    ]));
    const file = path.join(tmpDir, 'identity.json');
    await register(mockApp, ctx, { fingerprintFile: file });

    // Resolve/generate identity for this launch.
    const a = makeLaunchArgs();
    a.executable_path = path.join(binDir, 'camoufox');
    await events.emitAsync('browser:launchOptions', { launchArgs: a });
    const persisted = JSON.parse(await fs.readFile(file, 'utf-8')).config['canvas:aaOffset'];

    // Simulate camoufox's resolved env with a *different* random aaOffset.
    const options = { env: { CAMOU_CONFIG_1: JSON.stringify({ 'canvas:aaOffset': 999, other: 1 }) } };
    await events.emitAsync('browser:launching', { options });

    const rebuilt = JSON.parse(
      Object.keys(options.env)
        .filter((k) => /^CAMOU_CONFIG_\d+$/.test(k))
        .sort((x, y) => Number(x.slice(13)) - Number(y.slice(13)))
        .map((k) => options.env[k])
        .join(''),
    );
    expect(rebuilt['canvas:aaOffset']).toBe(persisted); // pinned to persisted value
    expect(rebuilt.other).toBe(1); // unrelated keys preserved
  });

  test('generates a proxy-geo-coherent locale when proxy country is set (#0/SPEC-002)', async () => {
    const file = path.join(tmpDir, 'identity.json');
    ctx.config.proxy = { country: 'DE' };
    await register(mockApp, ctx, { fingerprintFile: file });

    const a = makeLaunchArgs();
    a.proxy = { server: 'http://proxy.example:8000' }; // proxy active -> locale applies
    await events.emitAsync('browser:launchOptions', { launchArgs: a });

    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(saved.locale).toBe('de-DE');
    expect(saved.fingerprint.navigator.language).toBe('de-DE');
    expect(a.fingerprint.navigator.language).toBe('de-DE'); // injected coherent
  });

  test('no locale claim without an active proxy (even if country configured)', async () => {
    const file = path.join(tmpDir, 'identity.json');
    ctx.config.proxy = { country: 'DE' };
    await register(mockApp, ctx, { fingerprintFile: file });
    await events.emitAsync('browser:launchOptions', { launchArgs: makeLaunchArgs() }); // proxy: null

    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(saved.locale).toBeNull(); // no proxy -> don't fake a foreign locale
    expect(saved.fingerprint.navigator.language).toBeTruthy();
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

    // Mirror the full launch contract: the pre-hook injects fingerprint/webgl,
    // then launchOptions() resolves (and re-randomizes canvas:aaOffset), then the
    // post-hook pins canvas:aaOffset back. Only after both hooks is the serialized
    // CAMOU_CONFIG expected to be identical across launches.
    const collect = async () => {
      const args = makeLaunchArgs();
      await events.emitAsync('browser:launchOptions', { launchArgs: args });
      const opts = await launchOptions(args);
      await events.emitAsync('browser:launching', { options: opts });
      return Object.fromEntries(
        Object.entries(opts.env).filter(([k]) => k.startsWith('CAMOU_CONFIG_')),
      );
    };

    const first = await collect();
    const second = await collect();
    expect(second).toEqual(first);
  }, 30000);
});
