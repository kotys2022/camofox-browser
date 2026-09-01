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

const IDENTITY_VERSION = 1;

// Seeds are 1..2^32-1 -- 0 is a no-op in the C++ noise managers.
const randSeed = () => Math.floor(Math.random() * 4_294_967_295) + 1;

function buildNoiseConfig() {
  return {
    'audio:seed': randSeed(),
    'canvas:seed': randSeed(),
    'fonts:spacing_seed': randSeed(),
    'window.history.length': Math.floor(Math.random() * 5) + 1,
  };
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

      // Deep-clone: launchOptions() mutates the config object in place
      // (webgl, canvas:aaOffset, geolocation), which must not leak back to disk.
      launchArgs.fingerprint = structuredClone(identity.fingerprint);
      launchArgs.config = {
        ...(launchArgs.config || {}),
        ...structuredClone(identity.config || {}),
      };
      log('info', 'identity plugin: injected persistent fingerprint', {
        fingerprintFile,
        generatedAt: identity.generatedAt || null,
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
