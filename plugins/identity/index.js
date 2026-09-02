/**
 * Identity plugin for camofox-browser.
 *
 * Persists and re-injects a stable browser fingerprint across every launch so a
 * profile keeps the same identity after idle-kill, crash, or container restart.
 *
 * Why this exists (see FIXES.md #0):
 *   camoufox-js generates a *fresh* random fingerprint on every firefox.launch()
 *   unless launchOptions() is given an explicit `fingerprint` (and matching noise
 *   `config`). With BROWSER_IDLE_TIMEOUT_MS the browser relaunches *inside* a live
 *   container, so without persistence the identity drifts and the platform
 *   invalidates the session (relogin / detection).
 *
 * How:
 *   1. browser:launchOptions pre-hook (before launchOptions() resolves): sets
 *      launchArgs.fingerprint + launchArgs.config + launchArgs.webgl_config from an
 *      on-disk identity.json. This is where fingerprint/seeds/WebGL must be set --
 *      launchOptions() bakes them into CAMOU_CONFIG_* env chunks.
 *   2. browser:launching post-hook (after resolution): pins canvas:aaOffset by
 *      rewriting those env chunks, because launchOptions() mergeInto-overwrites it
 *      every launch and offers no input override.
 *
 * Persisted identity layers (for full coherence across relaunch):
 *   - Browserforge Fingerprint (navigator / screen / fonts) via `fingerprint`,
 *     generated under the proxy country's locale so navigator.language matches the
 *     proxy geo (timezone/locale/geolocation/webrtc already follow it via geoip).
 *   - WebGL vendor/renderer pair via `webgl` -> launchArgs.webgl_config (else
 *     launchOptions re-samples a random GPU each launch, overriding the fingerprint).
 *   - Noise seeds (audio:seed, canvas:seed, fonts:spacing_seed, window.history.length,
 *     canvas:aaOffset) via `config` -- camoufox re-randomizes these each launch, so
 *     without persisting them canvas/audio would drift even with a stable fp.
 *     Injection filters `config` to the running build's properties.json schema.
 *
 * NOT persisted: IP-exact fields (webrtc:ipv4, precise geolocation). Those are left
 * empty so geoip=true derives them from the current proxy IP each launch (stays
 * coherent across sticky-IP changes within the same geo).
 *
 * Configuration (camofox.config.json):
 *   {
 *     "plugins": {
 *       "identity": {
 *         "enabled": true,
 *         "fingerprintFile": "/root/.camofox/slot/identity.json",
 *         "generate": true
 *       }
 *     }
 *   }
 *
 * The file path can also be set via environment variable:
 *   CAMOFOX_FINGERPRINT_FILE=/root/.camofox/slot/identity.json
 *
 * generate (default: true): self-generate an identity.json on first launch if the
 * file is missing (self-generate). Set false to require an externally
 * provisioned file (variant B); with no file the launch falls back to camoufox's
 * per-launch random fingerprint (current upstream behavior).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { generateFingerprint } from 'camoufox-js/dist/fingerprints.js';
import { camoufoxPath } from 'camoufox-js/dist/pkgman.js';
import { getPossiblePairs } from 'camoufox-js/dist/webgl/sample.js';
import { localeFromCountry } from '../../lib/geo-locale.js';

const IDENTITY_VERSION = 1;

// launchOptions() re-samples a random WebGL vendor/renderer every launch and
// mergeInto-overwrites it, so a persisted Browserforge fingerprint alone does
// NOT pin WebGL. Passing webgl_config=[vendor,renderer] makes launchOptions
// resolve that exact pair deterministically. Map host OS -> sampleWebGL OS code.
const OS_SHORT = { linux: 'lin', macos: 'mac', windows: 'win' };

// Pick a random valid [vendor, renderer] pair for the OS, or null if the WebGL
// dataset can't be read (e.g. better-sqlite3 unbuilt) -- degrade to per-launch
// random WebGL rather than failing.
async function sampleWebglPair(os) {
  try {
    const pairs = (await getPossiblePairs())[OS_SHORT[os] || 'lin'] || [];
    if (!pairs.length) return null;
    const p = pairs[Math.floor(Math.random() * pairs.length)];
    return [p.vendor, p.renderer];
  } catch {
    return null;
  }
}

// Seeds are 1..2^32-1 -- 0 is a no-op in the C++ noise managers.
const randSeed = () => Math.floor(Math.random() * 4_294_967_295) + 1;

// Persist the *superset* of possible noise seeds so identity.json is portable
// across camoufox builds; injection filters to the keys the running build knows.
// (Older/Firefox-135 builds lack audio:seed/canvas:seed and reject unknown keys.)
//
// canvas:aaOffset is special: launchOptions() mergeInto-overwrites it with a fresh
// random value every launch, ignoring any config we pass, so it can only be pinned
// *after* resolution by rewriting the CAMOU_CONFIG_* env chunks (browser:launching).
function buildNoiseConfig() {
  return {
    'audio:seed': randSeed(),
    'canvas:seed': randSeed(),
    'fonts:spacing_seed': randSeed(),
    'window.history.length': Math.floor(Math.random() * 5) + 1,
    'canvas:aaOffset': Math.floor(Math.random() * 101) - 50, // -50..50, mirrors camoufox
    'canvas:aaCapOffset': true,
  };
}

const CANVAS_PIN_KEYS = ['canvas:aaOffset', 'canvas:aaCapOffset'];

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && k in obj) out[k] = obj[k];
  return out;
}

/**
 * Override keys inside the resolved CAMOU_CONFIG_* env chunks (the serialized
 * config Camoufox reads at spawn). Reassembles the numbered chunks, applies the
 * overrides, and re-chunks with camoufox's own chunk size. Used for canvas:aaOffset,
 * which has no launchOptions() input override. Returns { changed, applied }.
 */
function rewriteCamouConfig(env, overrides) {
  if (!env || !overrides || !Object.keys(overrides).length) return { changed: false };
  const prefix = 'CAMOU_CONFIG_';
  const chunkKeys = Object.keys(env)
    .filter((k) => /^CAMOU_CONFIG_\d+$/.test(k))
    .sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)));
  if (!chunkKeys.length) return { changed: false };
  let cfg;
  try {
    cfg = JSON.parse(chunkKeys.map((k) => env[k]).join(''));
  } catch {
    return { changed: false };
  }
  let changed = false;
  for (const [k, v] of Object.entries(overrides)) {
    if (cfg[k] !== v) { cfg[k] = v; changed = true; }
  }
  if (!changed) return { changed: false, applied: overrides };
  for (const k of chunkKeys) delete env[k];
  const out = JSON.stringify(cfg);
  const chunkSize = process.platform === 'win32' ? 2047 : 32767;
  for (let i = 0, n = 1; i < out.length; i += chunkSize, n += 1) {
    env[`${prefix}${n}`] = out.slice(i, i + chunkSize);
  }
  return { changed: true, applied: overrides };
}

/**
 * Load the running build's known config-property names from its properties.json
 * (the same file camoufox-js validates against). Returns a Set, or null if it
 * can't be determined -- in which case injection passes the config through
 * unfiltered (a launch is only reachable when the binary, hence the schema,
 * exists). Never triggers a download: camoufoxPath(false) throws if missing.
 */
async function loadKnownProperties(executablePath) {
  try {
    const dir = executablePath
      ? path.dirname(String(executablePath))
      : camoufoxPath(false).toString();
    const candidates = [
      path.join(dir, 'properties.json'),
      path.join(dir, 'Camoufox.app', 'Contents', 'Resources', 'properties.json'), // macOS
    ];
    for (const propFile of candidates) {
      try {
        const props = JSON.parse(await fs.readFile(propFile, 'utf-8'));
        return new Set(props.map((p) => p.property));
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function filterToKnown(config, known) {
  if (!known) return { ...config };
  const out = {};
  for (const [k, v] of Object.entries(config)) if (known.has(k)) out[k] = v;
  return out;
}

async function readIdentity(file) {
  const raw = await fs.readFile(file, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || !parsed.fingerprint) {
    throw new Error('identity file missing "fingerprint"');
  }
  return parsed;
}

async function writeIdentity(file, identity) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(identity, null, 2));
  await fs.rename(tmp, file); // atomic swap
}

export async function register(app, ctx, pluginConfig = {}) {
  const { events, config, log } = ctx;

  const fingerprintFile =
    process.env.CAMOFOX_FINGERPRINT_FILE ||
    pluginConfig.fingerprintFile ||
    (config?.profileDir ? path.join(config.profileDir, 'identity.json') : null);

  if (!fingerprintFile) {
    log('warn', 'identity plugin: no fingerprintFile configured, plugin disabled');
    return;
  }

  const generate = pluginConfig.generate !== false;

  log('info', 'identity plugin enabled', { fingerprintFile, generate });

  // Serialize first-launch generation so concurrent relaunch attempts don't race
  // to write the same file.
  let generating = null;
  // Carry the identity resolved in browser:launchOptions to the later
  // browser:launching hook (same launch, fired sequentially) so canvas:aaOffset
  // can be pinned post-resolution. Reset each launch to avoid stale carry-over.
  let pending = null;

  events.on('browser:launchOptions', async ({ launchArgs }) => {
    pending = null;
    // Never let identity resolution abort a launch -- degrade to camoufox's
    // per-launch random fingerprint on any error.
    try {
      if (launchArgs.fingerprint) {
        // Another plugin already set an identity; don't clobber it.
        return;
      }

      let identity;
      try {
        identity = await readIdentity(fingerprintFile);
      } catch (err) {
        if (err?.code !== 'ENOENT') {
          log('warn', 'identity plugin: failed to read identity file', {
            fingerprintFile,
            error: err.message,
          });
          return;
        }
        if (!generate) {
          log('info', 'identity plugin: no identity file and generate=false, using random fingerprint', {
            fingerprintFile,
          });
          return;
        }
        // First launch: generate once, persist, then reuse forever.
        if (!generating) {
          generating = (async () => {
            // Generate the fingerprint coherent with the proxy geo: navigator.language
            // etc. should match the country the proxy exits from.
            // timezone/locale/geolocation/webrtc already follow the proxy via geoip.
            // Only when a proxy is actually active -- without one, claiming a foreign
            // locale would itself be incoherent with the (direct) connection.
            const locale = launchArgs.proxy ? localeFromCountry(config?.proxy?.country) : null;
            const fpOpts = { operatingSystems: [launchArgs.os], ...(locale ? { locales: [locale] } : {}) };
            let fingerprint;
            try {
              fingerprint = generateFingerprint(undefined, fpOpts);
            } catch {
              // Fall back progressively: drop locale, then os, rather than fail.
              try { fingerprint = generateFingerprint(undefined, { operatingSystems: [launchArgs.os] }); }
              catch { fingerprint = generateFingerprint(); }
            }
            const fresh = {
              version: IDENTITY_VERSION,
              generatedAt: new Date().toISOString(),
              os: launchArgs.os,
              locale: locale || null,
              fingerprint,
              webgl: await sampleWebglPair(launchArgs.os),
              config: buildNoiseConfig(),
            };
            await writeIdentity(fingerprintFile, fresh);
            log('info', 'identity plugin: generated new identity', {
              fingerprintFile,
              os: launchArgs.os,
              locale: locale || null,
              proxyCountry: config?.proxy?.country || null,
            });
            return fresh;
          })().finally(() => { generating = null; });
        }
        identity = await generating;
      }

      // Only inject seeds the running build recognizes -- launchOptions()
      // validateConfig() throws UnknownProperty on any key absent from the
      // build's properties.json (e.g. audio:seed on Firefox-135 builds).
      const known = await loadKnownProperties(launchArgs.executable_path);
      const noiseConfig = filterToKnown(identity.config || {}, known);

      // Deep-clone: launchOptions() mutates the config object in place
      // (webgl, canvas:aaOffset, geolocation), which must not leak back to disk.
      launchArgs.fingerprint = structuredClone(identity.fingerprint);
      launchArgs.config = {
        ...(launchArgs.config || {}),
        ...structuredClone(noiseConfig),
      };
      // Pin WebGL vendor/renderer so it doesn't drift across relaunch.
      if (Array.isArray(identity.webgl) && identity.webgl.length === 2) {
        launchArgs.webgl_config = [...identity.webgl];
      }
      // Hand off the canvas offset (filtered to schema) to browser:launching --
      // it can't be pinned via launchArgs.config (launchOptions overwrites it).
      pending = { canvas: filterToKnown(pick(identity.config || {}, CANVAS_PIN_KEYS), known) };
      log('info', 'identity plugin: injected persistent fingerprint', {
        fingerprintFile,
        generatedAt: identity.generatedAt || null,
        seeds: Object.keys(noiseConfig),
        webgl: launchArgs.webgl_config || null,
      });
    } catch (err) {
      log('error', 'identity plugin: launchOptions hook failed, using random fingerprint', {
        error: err.message,
      });
    }
  });

  // Post-resolution: pin canvas:aaOffset in the serialized CAMOU_CONFIG_* env
  // chunks. launchOptions() re-randomizes it each launch (mergeInto overwrite)
  // with no input override, so this is the only seam to keep the canvas hash
  // stable across relaunch.
  events.on('browser:launching', async ({ options }) => {
    try {
      const overrides = pending?.canvas;
      if (!overrides || !Object.keys(overrides).length || !options?.env) return;
      const { changed, applied } = rewriteCamouConfig(options.env, overrides);
      if (changed) log('info', 'identity plugin: pinned canvas anti-aliasing offset', { applied });
    } catch (err) {
      log('warn', 'identity plugin: canvas pin failed (non-fatal)', { error: err.message });
    }
  });

  log('info', 'identity plugin: registered browser:launchOptions + browser:launching hooks');
}

export default register;
