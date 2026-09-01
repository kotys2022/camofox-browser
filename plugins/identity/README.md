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

The plugin subscribes to the **`browser:launchOptions`** pre-hook (added in core,
`server.js`), which fires *before* `launchOptions()` resolves, and sets
`launchArgs.fingerprint` + `launchArgs.config`.

> The older `browser:launching` hook is **too late**: by then `launchOptions()`
> has already serialized the fingerprint into the `CAMOU_CONFIG_*` env chunks, so
> mutating `options.fingerprint` there is a no-op.

## What is persisted

`identity.json` holds two layers, both required for coherence:

1. **Browserforge `Fingerprint`** (navigator / screen / webgl / fonts) → `fingerprint`.
2. **Noise seeds** (`audio:seed`, `canvas:seed`, `fonts:spacing_seed`,
   `window.history.length`) → `config`. camoufox re-randomizes these each launch
   (set-only-if-unset), so without persisting them canvas/audio would drift even
   with a stable fingerprint.

**Not persisted** (intentionally): IP-exact fields — `webrtc:ipv4`, precise
geolocation. Left empty so `geoip=true` derives them from the current proxy IP each
launch, staying coherent across sticky-IP changes within the same geo (SPEC-002 §6.1).

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
