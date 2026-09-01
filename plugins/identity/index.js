/**
 * Identity plugin for camofox-browser.
 *
 * Persists and re-injects a stable browser fingerprint across every launch so a
 * profile keeps the same identity after idle-kill, crash, or container restart.
 *
 * Why this exists (see FIXES.md #0 / ADR Open Question #12):
 *   camoufox-js generates a *fresh* random fingerprint on every firefox.launch()
 *   unless launchOptions() is given an explicit `fingerprint` (and matching noise
 *   `config`). With BROWSER_IDLE_TIMEOUT_MS the browser relaunches *inside* a live
 *   container, so without persistence the identity drifts and the platform
 *   invalidates the session (relogin / detection).
 *
 * How:
 *   Subscribes to the browser:launchOptions pre-hook (fires before launchOptions()
 *   resolves) and sets launchArgs.fingerprint + launchArgs.config from an on-disk
 *   identity.json. The later browser:launching hook is too late -- by then the
 *   fingerprint is already serialized into CAMOU_CONFIG_* env chunks.
 *
 * Two persisted layers (both required for coherence):
 *   1. Browserforge Fingerprint (navigator / screen / webgl / fonts) via `fingerprint`.
 *   2. Noise seeds (audio:seed, canvas:seed, fonts:spacing_seed, window.history.length)
 *      via `config` -- camoufox re-randomizes these each launch (set-only-if-unset),
 *      so without persisting them canvas/audio would drift even with a stable fp.
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
 * file is missing (SPEC-002 variant A). Set false to require an externally
 * provisioned file (variant B); with no file the launch falls back to camoufox's
 * per-launch random fingerprint (current upstream behavior).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { generateFingerprint } from 'camoufox-js/dist/fingerprints.js';
import { camoufoxPath } from 'camoufox-js/dist/pkgman.js';
import { getPossiblePairs } from 'camoufox-js/dist/webgl/sample.js';

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
function buildNoiseConfig() {
  return {
    'audio:seed': randSeed(),
    'canvas:seed': randSeed(),
    'fonts:spacing_seed': randSeed(),
    'window.history.length': Math.floor(Math.random() * 5) + 1,
  };
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

  events.on('browser:launchOptions', async ({ launchArgs }) => {
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
            let fingerprint;
            try {
              fingerprint = generateFingerprint(undefined, { operatingSystems: [launchArgs.os] });
            } catch {
              fingerprint = generateFingerprint();
            }
            const fresh = {
              version: IDENTITY_VERSION,
              generatedAt: new Date().toISOString(),
              os: launchArgs.os,
              fingerprint,
              webgl: await sampleWebglPair(launchArgs.os),
              config: buildNoiseConfig(),
            };
            await writeIdentity(fingerprintFile, fresh);
            log('info', 'identity plugin: generated new identity', {
              fingerprintFile,
              os: launchArgs.os,
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

  log('info', 'identity plugin: registered browser:launchOptions hook');
}

export default register;
