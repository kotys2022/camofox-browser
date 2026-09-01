# identity plugin

Persists and re-injects a **stable browser fingerprint** across every launch, so a
profile keeps the same identity after idle-kill, crash, or container restart.

Implements FIXES.md **#0** / ADR Open Question **#12**.

## The problem

`camoufox-js` generates a *fresh random* fingerprint on every `firefox.launch()`
unless `launchOptions()` is given an explicit `fingerprint` (plus matching noise
`config`). With `BROWSER_IDLE_TIMEOUT_MS` the browser relaunches **inside a live
container** — so without persistence the identity drifts and the platform
invalidates the session (relogin / bot detection), breaking the immutable-Profile
invariant.

## The seam

The plugin uses **two** hooks:

- **`browser:launchOptions`** (pre-resolution, added in core `server.js`): sets
  `launchArgs.fingerprint` + `launchArgs.config` + `launchArgs.webgl_config`. This is
  where fingerprint / seeds / WebGL must be set, because `launchOptions()` bakes them
  into the `CAMOU_CONFIG_*` env chunks. Mutating `options.fingerprint` in the later
  `browser:launching` hook would be a no-op.
- **`browser:launching`** (post-resolution): pins `canvas:aaOffset` by rewriting those
  `CAMOU_CONFIG_*` chunks — see below.

## What is persisted

`identity.json` holds two layers, both required for coherence:

1. **Browserforge `Fingerprint`** (navigator / screen / fonts) → `fingerprint`.
2. **WebGL vendor/renderer pair** → `webgl` (`[vendor, renderer]`). `launchOptions()`
   re-samples a *random* WebGL pair every launch and overwrites it, so a persisted
   fingerprint alone does **not** pin WebGL (verified: it drifts Mesa↔Intel across
   relaunch). We pass it back via `launchArgs.webgl_config` so the same pair is
   resolved deterministically each launch.
3. **Noise seeds** (`audio:seed`, `canvas:seed`, `fonts:spacing_seed`,
   `window.history.length`, `canvas:aaOffset`) → `config`. camoufox re-randomizes
   these each launch, so without persisting them canvas/audio would drift even with a
   stable fingerprint. Injection filters this to the keys the running build's
   `properties.json` recognizes — older/Firefox-135 builds lack `audio:seed` /
   `canvas:seed` and `launchOptions()` throws `UnknownProperty` on unknown keys.
   `identity.json` stores the full superset so it stays portable across builds.
4. **`canvas:aaOffset`** — special-cased. `launchOptions()` `mergeInto`-overwrites it
   with a fresh random value every launch and offers no input override, so it's pinned
   *post-resolution* in the `browser:launching` hook by reassembling the
   `CAMOU_CONFIG_*` env chunks, overriding the value, and re-chunking. Without this the
   raw canvas hash drifts every launch even with a stable fingerprint (verified).

**Not persisted** (intentionally): IP-exact fields — `webrtc:ipv4`, precise
geolocation. Left empty so `geoip=true` derives them from the current proxy IP each
launch, staying coherent across sticky-IP changes within the same geo (SPEC-002 §6.1).

The full fingerprint surface — navigator / screen / fonts / WebGL / canvas — is
verified stable across an idle-kill relaunch by `scripts/verify-identity-e2e.sh`.

## Configuration

```json
{
  "plugins": {
    "identity": {
      "enabled": true,
      "fingerprintFile": "/root/.camofox/slot/identity.json",
      "generate": true
    }
  }
}
```

Or via environment: `CAMOFOX_FINGERPRINT_FILE=/root/.camofox/slot/identity.json`.
(Env-gate activation `ENABLE_IDENTITY` requires FIXES.md **#1**; until then activate
via the `plugins` list.)

If `fingerprintFile` is omitted it defaults to `<profileDir>/identity.json`.

- **`generate`** (default `true`): self-generate `identity.json` on first launch if
  missing (SPEC-002 variant A). Set `false` to require an externally provisioned
  file (variant B); with no file the launch falls back to camoufox's per-launch
  random fingerprint (upstream behavior).

## Rotation

Fingerprint is **launch-bound** — it cannot be swapped on a live browser. To rotate
a different Profile onto a slot: `stop → replace identity.json → start`.

## Failure behavior

The hook never aborts a launch: any read/parse/generate error is logged and the
launch proceeds with camoufox's random fingerprint (degraded, not broken).
