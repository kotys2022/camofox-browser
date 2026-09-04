<div align="center">
  <img src="logo.png" alt="camofox-browser-ai" width="200" />
  <h1>camofox-browser-ai</h1>
  <p><strong>Anti-detection browser server for AI agents, powered by Camoufox</strong></p>
  <p>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
  </p>
  <p>
    Standing on the mighty shoulders of <a href="https://camoufox.com">Camoufox</a> — a Firefox fork with fingerprint spoofing at the C++ level.
  </p>
  <p>
    A fork of <a href="https://github.com/jo-inc/camofox-browser">jo-inc/camofox-browser</a> v1.14.0, with ergonomics &amp; defaults tuned for real agent workloads (data extraction over MCP), plus a <strong>NixOS deployment</strong> and a <strong>profile-fleet manager</strong>.
  </p>
</div>

<br/>

> **Developed and tested on NixOS.** A ready-to-use NixOS module (`nix/camofox-browser.nix`) and a fleet manager (`proxyctl`) ship in this repo — see [NixOS deployment](#nixos-deployment). Docker and plain `npm` work everywhere else.

```bash
git clone https://github.com/kotys2022/camofox-browser-ai && cd camofox-browser-ai
npm install && npm start
# -> http://localhost:9377
```

---

## Why

AI agents need to browse the real web. Playwright gets blocked. Headless Chrome gets fingerprinted. Stealth plugins become the fingerprint.

Camoufox patches Firefox at the **C++ implementation level** — `navigator.hardwareConcurrency`, WebGL renderers, AudioContext, screen geometry, WebRTC — all spoofed before JavaScript ever sees them. No shims, no wrappers, no tells.

This project wraps that engine in a REST API (plus an MCP adapter) built for agents: accessibility snapshots instead of bloated HTML, stable element refs for clicking, session isolation, and search macros for common sites.

## Features

- **C++ anti-detection** — bypasses Google, Cloudflare, and most bot detection
- **Persistent identity (fork)** — a stable fingerprint that survives restarts, idle-kill and crashes
- **Element refs** — stable `e1`, `e2`, `e3` identifiers for reliable interaction
- **Token-efficient** — accessibility snapshots are ~90% smaller than raw HTML
- **Session isolation** — separate cookies/storage per user
- **Cookie import** — inject Netscape-format cookie files for authenticated browsing
- **File upload** — attach files from a configured upload directory without a native OS dialog
- **Proxy + GeoIP** — route through residential/datacenter proxies with automatic locale/timezone; single-string import and proxy pools (fork)
- **Structured logging** — JSON log lines with request IDs
- **YouTube transcripts** — extract captions via yt-dlp, no API key needed
- **Search macros** — `@google_search`, `@youtube_search`, `@amazon_search`, and more
- **Snapshot screenshots** — base64 PNG alongside the accessibility snapshot
- **Download & image capture** — capture browser downloads and list DOM images via the API
- **REST + MCP** — a REST API plus a standalone MCP adapter (Claude Code, Cursor, Hermes, …)
- **NixOS module + fleet manager (fork)** — `services.camofox-docker` and `proxyctl` for a 1-image → N-profile container fleet
- **VNC interactive login** — log into sites visually via noVNC, export storage state for agent reuse
- **OpenAPI docs** — auto-generated spec at [`/openapi.json`](http://localhost:9377/openapi.json) and interactive docs at [`/docs`](http://localhost:9377/docs)
- **Session tracing** — opt-in per-session Playwright traces (screenshots + DOM + network)

## Capabilities

A full rundown of what the server can do. Items marked **(fork)** are additions or changes over upstream jo-inc/camofox-browser v1.14.0 — see [Fork changes](#fork-changes) for the rationale.

### Anti-detection & identity
- **C++-level fingerprint spoofing** via Camoufox — navigator, WebGL vendor/renderer, AudioContext, screen geometry and WebRTC are patched inside the engine, before any JavaScript can observe them. No JS shims, no wrapper tells.
- **Persistent fingerprint identity (fork)** — an `identity.json` is generated once per profile and re-injected on **every** launch (navigator / screen / fonts / WebGL pair + audio/canvas noise seeds + `canvas:aaOffset`), so a profile keeps the same identity across idle-kill, crash or container restart. Without it Camoufox re-randomizes each launch and platforms invalidate the session. Enable with `ENABLE_IDENTITY=1`; path via `CAMOFOX_FINGERPRINT_FILE`.
- **Proxy-coherent locale (fork)** — `navigator.language` is generated from `PROXY_COUNTRY` (ICU, no network) so the fingerprint's language matches the proxy geo; timezone, geolocation and WebRTC already follow the exit IP through GeoIP.

### Networking & proxy
- **Proxy + GeoIP** — route traffic through residential or datacenter proxies; timezone, locale, geolocation and WebRTC are auto-derived from the proxy exit IP each launch.
- **Single-string proxy import (fork)** — `PROXY_URL=scheme://user:pass@host:port` instead of five discrete vars; supports `http` / `https` / `socks5`; discrete `PROXY_*` still override.
- **Proxy pools (fork)** — `PROXY_URLS` (newline/comma separated) or `CAMOFOX_PROXY_LIST_FILE` enable `list` mode with per-session rotation across same-country proxies.
- **Backconnect & round-robin strategies** — decodo / generic providers with sticky-session usernames, or a fixed port pool with per-context rotation.

### Agent-friendly DOM
- **Accessibility snapshots** — ~90% smaller than raw HTML, with stable `e1` / `e2` / `e3` element refs for reliable click / type.
- **`evaluate` with result projection & byte caps (fork)** — run JS in the page and project or cap the result so a huge return value never blows the agent's context window; per-call `maxBytes` or default `CAMOFOX_EVALUATE_MAX_RESULT_BYTES`.
- **SPA readiness contract (fork)** — `waitFor` takes exactly one of `selector` / `text` / `networkQuietMs` with a capped timeout, so navigation waits until the app is actually ready instead of racing `networkidle` (which never fires on many SPAs).
- **First-class XHR/response capture (fork)** — `camofox_capture_response` captures a page's XHR/fetch response by URL pattern, rather than scraping rendered DOM.
- **Structured extract** — `POST /tabs/:id/extract` maps a JSON Schema to snapshot refs via `x-ref`.
- **Large-page handling** — automatic snapshot truncation with offset-based pagination.
- **DOM image extraction** — list `<img>` src/alt, optionally returning inline data URLs.

### Sessions, auth & files
- **Session isolation** — separate cookies/storage per user (`newContext` per userId).
- **Cookie persistence & import** — persisted `storage_state.json` per profile; inject Netscape-format cookie files for authenticated browsing.
- **File upload** — attach files from a configured directory without a native OS dialog.
- **VNC interactive login** — log into sites visually via noVNC, then export the storage state for agent reuse.

### Performance & operations
- **Lazy launch + idle shutdown** — ~40MB idle footprint; designed to share a box.
- **Browser keep-warm (fork)** — `BROWSER_IDLE_TIMEOUT_MS=0` disables idle shutdown and eagerly re-warms the browser after an unexpected close, removing cold-start latency under load.
- **Env-gated plugins (fork)** — enable any plugin with `ENABLE_<PLUGIN>=1`, no config edit required.
- **Configurable virtual display (fork)** — `CAMOFOX_DISPLAY_RESOLUTION` aligns a headless run with a VNC-watched run for screenshot parity.
- **Tool-arg observability (fork)** — opt-in `CAMOFOX_LOG_TOOL_ARGS` logs the evaluate expression with secret redaction and a length cap.
- **Session tracing** — opt-in per-session Playwright traces (screenshots + DOM + network) with list/fetch/delete endpoints; a default-path warning (fork) prevents silent trace loss on `--rm` without a volume.
- **Structured logging** — JSON log lines with request IDs for production observability.

### Media & search
- **YouTube transcripts** — extract captions via yt-dlp, no API key needed.
- **Search macros** — `@google_search`, `@youtube_search`, `@amazon_search`, `@reddit_subreddit`, and more.
- **Snapshot screenshots** — base64 PNG alongside the accessibility snapshot, or a REST snapshot **without** the image (fork) when only the tree is needed.
- **Download capture** — capture browser downloads and fetch them via API (optional inline base64).

### Interfaces & deployment
- **REST + MCP** — a REST API plus a standalone MCP adapter for MCP-compatible hosts.
- **OpenAPI docs** — auto-generated `/openapi.json` and interactive `/docs`.
- **Deploy** — NixOS module, Docker.

## Fork changes

This fork keeps upstream's default behavior — every new capability is **opt-in**. Upstream code was left untouched wherever a change could be made through a plugin or a hook; the core was modified minimally (one new pre-hook `browser:launchOptions`, a few optional parameters).

- **Identity plugin (new)** — persist + re-inject the fingerprint on every launch via the new mutating pre-hook `browser:launchOptions`; WebGL pin via `webgl_config`; canvas pin (`canvas:aaOffset`) via a post-resolution `browser:launching` rewrite of the `CAMOU_CONFIG_*` env chunks; a seed filter against the build's `properties.json` schema; proxy-coherent locale via bundled ICU.
- **MCP tools & REST** — new `camofox_capture_response` (`POST /tabs/:id/capture`); `evaluate` projection/`maxBytes`; a `waitFor` readiness contract on navigate/create-tab; `?screenshot=true` alias.
- **Plugins / config / observability** — unified `ENABLE_<PLUGIN>=1` gate; browser keep-warm (`BROWSER_IDLE_TIMEOUT_MS=0`); configurable `CAMOFOX_DISPLAY_RESOLUTION`; redacted evaluate-expression logging (`CAMOFOX_LOG_TOOL_ARGS`); an ephemeral-traces warning.
- **Proxy** — single-string `PROXY_URL`; proxy pools (`PROXY_URLS` / `CAMOFOX_PROXY_LIST_FILE`) with per-session rotation; proxy-country-driven locale (`CAMOFOX_LOCALE_FOLLOWS_PROXY`).
- **Tooling** — `scripts/profile-bundle.mjs` (export/import a profile as a tar with re-keying and geo/IndexedDB warnings); `scripts/verify-identity-e2e.sh` (live identity-stability E2E); `Dockerfile.test` (CI-parity runner with the real binary + xvfb).
- **NixOS** — a module and `proxyctl` fleet manager (see below).

## NixOS deployment

This fork is developed and tested on **NixOS**. The repo ships:

- **`nix/camofox-browser.nix`** — a NixOS module exposing `services.camofox-docker`.
- **`nix/camofox-manager/`** — the `proxyctl` fleet manager, an example profiles file, and an operator guide ([`USAGE.md`](nix/camofox-manager/USAGE.md), English [`USAGE.en.md`](nix/camofox-manager/USAGE.en.md)).

### Module

```nix
services.camofox-docker = {
  enable = true;
  # port         = 9377;                           # host port of the `default` profile (loopback)
  # image        = "camofox-browser-ai:local";        # local docker image (pull = never)
  # stateDir     = "/var/lib/camofox";             # <stateDir>/<id> = profile volume; <stateDir>/profiles.toml
  # profilesFile = "/var/lib/camofox/profiles.toml";
};
```

When enabled, the module:

- enables `virtualisation.docker`;
- puts `proxyctl` on `PATH`;
- creates `/var/lib/camofox` (`0700 root`, holds proxy credentials);
- registers two oneshots — **`camofox-migrate`** (bootstraps `profiles.toml` with a `default` profile) and **`camofox-apply`** (`proxyctl apply` at boot, reconciling containers to the file);
- installs operator shell aliases (fish/bash) with `sudo` already inside them:

| Alias | Runs |
|---|---|
| `pcx <cmd>` | `sudo proxyctl -f …/profiles.toml <cmd>` |
| `pcxedit` | `sudoedit …/profiles.toml` |
| `pcxls` | list profiles + status |
| `pcxplan` | `apply` (dry-run) |
| `pcxapply` | `apply --apply` |
| `pcxprune` | `apply --apply --prune` |
| `pcxhealth` | ping all proxies |
| `pcxheal` | auto-replace dead proxies |

> Nix holds only the **static** parts (rebuild-safe): docker, `proxyctl`, the state directory, the two oneshots. Containers are supervised by docker (`--restart=unless-stopped`); a rebuild does **not** touch running containers or `/var/lib/camofox`, so profile data is never overwritten.

### Fleet manager (`proxyctl`)

`profiles.toml` **is** the control panel. You edit it and run `pcxapply` — there are no separate create/edit/delete commands.

```toml
# /var/lib/camofox/profiles.toml
[profiles.default]          # direct (no proxy) — the engine Hermes/MCP talks to
kind = "sticky"
port = 9377

[profiles.acct-de]          # sticky: one fixed proxy, stable identity<->IP (logins)
kind    = "sticky"
country = "DE"
port    = 9401
proxy   = "http://user:pass@gate.example:11001"

[profiles.parse-de]         # pool: same-country proxies, rotated per session (bulk parsing)
kind    = "pool"
country = "DE"
port    = 9403
proxies = [ "http://user:pass@h1.example:11001", "http://user:pass@h2.example:11002" ]

[spares]                    # live backups per country, consumed by `pcxheal`
DE = [ "http://user:pass@spare.example:11001" ]
```

```bash
pcxls                 # profiles: kind / country / port / proxy count / status
pcxplan               # dry-run: what apply would create/recreate/remove
pcxapply              # bring the fleet in line with profiles.toml
pcxhealth             # ping each proxy through itself
pcxheal               # swap dead proxies for a live same-country spare
```

See [`nix/camofox-manager/USAGE.md`](nix/camofox-manager/USAGE.md) for the full operations guide (create/edit/delete, healing, per-profile REST checks, rev-bump, fresh-host deploy, troubleshooting).

> **Secrets stay out of git.** Only [`profiles.example.toml`](nix/camofox-manager/profiles.example.toml) (placeholders) is committed. The real `profiles.toml` and every profile's identity/cookies live in `/var/lib/camofox`, outside the repo.

### Interactive profile menu (`camofox-profile.sh`)

[`camofox-profile.sh`](camofox-profile.sh) (repo root) is a **thin interactive wrapper over `proxyctl`** for operators who prefer a menu to hand-editing TOML. It only collects answers and generates/removes the `[profiles.<id>]` block — all TOML validation, `apply`, and container reconciliation are delegated to `proxyctl` (it never parses TOML for writing). Bilingual **EN/UA** — pick the language at startup, or set `CAMOFOX_PROFILE_LANG=en|ua`.

```bash
sudo bash camofox-profile.sh    # needs proxyctl on PATH (installed by the module) + sudo
```

Menu: **List** (profiles, live status, and which have a saved login) **/ Create / Edit / Delete / Health**. Highlights:

- **Guided proxy setup** — direct / single proxy / same-country pool; paste a full `scheme://user:pass@host:port` URL at any prompt; optional `country` and `localeFollowsProxy`.
- **Port safety** — auto-suggests a free port and rejects one already used by another profile (TOML) or bound on the host (a foreign container/process).
- **Validate-before-commit** — the new content is validated in a temp file and only written to `profiles.toml` if valid, then applied. A single `Створити/оновити й застосувати?` confirm; declining leaves the file untouched (no half-applied state).
- **VNC cookie capture (login)** — offered after `apply` in Create/Edit. It temporarily runs a VNC-enabled container on the profile's volume (`--network host`, noVNC on loopback `:6080`), opens the login URL, and prints `http://127.0.0.1:6080/vnc.html`. You log in visually (MFA/CAPTCHA included); on `Enter` the authenticated `storage-state.json` is persisted into the profile volume. Future sessions of that profile using `userId=<profile id>` are then already logged in (via the persistence plugin). Keyed by userId, so use the same `userId` for authenticated work.

## Profile & identity model

The fleet model is **1 image → N profile-containers**: one Docker image, many long-lived containers, each a fully isolated browser profile.

- **1 profile = 1 container = 1 fingerprint.** The browser is a singleton per container, so each container carries exactly one identity. Need N parallel identities → run N containers.
- **Stable identity by design.** Each profile's `identity.json` is generated once and re-injected on every launch, so the fingerprint survives idle-kill, crash and container restart. Replacing a proxy of the **same country** is non-destructive — the container is recreated on the new IP, the fingerprint stays.
- **Identifiers everywhere.** A profile is addressed by its `<id>` (`camofox-<id>` container, `127.0.0.1:<port>:9377`, volume `/var/lib/camofox/<id>/`). Inside a profile, per-user sessions are partitioned by `sha256(userId)`, and tabs are grouped by `sessionKey`.
- **Country = container boundary.** GeoIP is launch-bound; never mix countries inside one pool.
- **Move a profile 1-to-1.** Copy `/var/lib/camofox/<id>/` to another machine and add its block to `profiles.toml`; or use `scripts/profile-bundle.mjs` to export/import a profile (fingerprint + cookies) as a tar with `userId` re-keying and geo/IndexedDB warnings.

```
/var/lib/camofox/
├── profiles.toml            # source of truth (0600 root)
└── <id>/                    # one profile
    ├── profiles/identity.json   # the pinned fingerprint
    ├── cookies/                 # bootstrap Netscape cookie files
    └── ...                      # storage_state.json (per hashed userId), traces, uploads
```

Reset a fingerprint by deleting `identity.json` and re-applying — the next launch generates a new one for the current country.

## Optional Dependencies

| Dependency | Purpose | Install |
|-----------|---------|---------|
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | YouTube transcript extraction (fast path) | `pip install yt-dlp` or `brew install yt-dlp` |

The Docker image includes yt-dlp. For local dev, install it for the `/youtube/transcript` endpoint. Without it, the endpoint falls back to a slower browser-based method.

## Quick Start

### Standalone

```bash
git clone https://github.com/kotys2022/camofox-browser-ai
cd camofox-browser-ai
npm install
npm start  # downloads Camoufox on first run (~300MB)
```

Default port is `9377`. See [Environment Variables](#environment-variables) for all options.

> **Note:** the postinstall script unsets `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` for itself before fetching the Camoufox binary. Without that override, an exported `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` (common when Playwright is configured to use system Chrome) would silently skip the binary download and crash the server at runtime.
>
> **External Camoufox executable:** set `CAMOUFOX_EXECUTABLE=/path/to/camoufox-bin` before `npm install` and when starting the server to skip the bundled download and launch that executable. Compatibility aliases are `CAMOUFOX_EXECUTABLE_PATH` and `CAMOFOX_EXECUTABLE_PATH`. This is useful for NixOS store paths such as `/nix/store/.../camoufox-bin`; the executable must come from a Camoufox bundle that includes `properties.json`, `version.json`, and `fontconfig/`.
>
> **Air-gapped or custom binary management:** prefer `CAMOUFOX_EXECUTABLE` when you already have a Camoufox bundle. Otherwise disable the auto-fetch with `npm install --ignore-scripts` (skips lifecycle scripts for *every* dependency) or, more surgically, `npm install --omit=optional` plus a manual `npx camoufox-js fetch` step against your mirror.

### Docker

The included `Makefile` auto-detects your CPU architecture and pre-downloads Camoufox + yt-dlp binaries outside the Docker build, so rebuilds are fast (~30s vs ~3min).

```bash
# Build and start (auto-detects arch: aarch64 on M1/M2, x86_64 on Intel)
make up

# Stop and remove the container
make down

# Force a clean rebuild (e.g. after upgrading VERSION/RELEASE)
make reset

# Just download binaries (without building)
make fetch

# Override arch or version explicitly
make up ARCH=x86_64
make up VERSION=135.0.1 RELEASE=beta.24
```

> **WARNING: Do not run `docker build` directly.** The Dockerfile uses bind mounts to pull pre-downloaded binaries from `dist/`. Always use `make up` (or `make fetch` then `make build`) — it downloads the binaries first.

### MCP Adapter

The standalone MCP adapter lives in [`mcp/`](mcp/) and is built from source. It exposes the browser to any MCP-compatible host (Claude Code, Cursor, Hermes, …) by forwarding to the REST server.

**Tools:** `camofox_create_tab`  |  `camofox_snapshot`  |  `camofox_click`  |  `camofox_type`  |  `camofox_navigate`  |  `camofox_scroll`  |  `camofox_screenshot`  |  `camofox_close_tab`  |  `camofox_list_tabs`  |  `camofox_import_cookies`  |  `camofox_capture_response`  |  `camofox_list_profiles`  |  `camofox_use_profile`  |  `camofox_current_profile`

The REST server must be running; the MCP server only forwards calls (`CAMOFOX_BASE_URL` points it at the REST server). See [`mcp/README.md`](mcp/README.md) for host wiring.

**Fleet discovery & routing (fork).** With a running fleet (see [NixOS deployment](#nixos-deployment)), one adapter drives every profile — no per-profile MCP server needed. `camofox_list_profiles` lists the fleet (id, port, country, proxy, `loggedIn`, status) from the sanitized registry `proxyctl` writes (`/run/camofox-registry.json`); `camofox_use_profile("<id>")` then switches routing so subsequent tools act as that profile — its proxy, identity, and saved login (keyed by `userId=<id>`); `camofox_current_profile` shows the active routing. Typical flow: `list_profiles` → `use_profile("acct-de")` → navigate/snapshot as that logged-in profile.

## Usage

### Cookie Import

Import cookies from your browser into Camoufox to skip interactive login on sites like LinkedIn, Amazon, etc.

**1. Generate a secret key:**

```bash
openssl rand -hex 32
```

**2. Set the environment variable before starting the server:**

```bash
export CAMOFOX_API_KEY="your-generated-key"
npm start
```

The same key is used by both the client (to authenticate requests) and the server (to verify them).

> **Why an env var?** The key is a secret. Set `CAMOFOX_API_KEY` in your shell profile, systemd unit, or Docker env — not in a plaintext config file.
>
> **Cookie import is disabled by default.** If `CAMOFOX_API_KEY` is not set, the server rejects all cookie requests with 403.

**3. Export cookies from your browser** in Netscape format (e.g. a "cookies.txt" extension) and place the file:

```bash
mkdir -p ~/.camofox/cookies
cp ~/Downloads/linkedin_cookies.txt ~/.camofox/cookies/linkedin.txt
```

The default directory is `~/.camofox/cookies/`. Override with `CAMOFOX_COOKIES_DIR`.

**4. Ask your agent to import them** ("Import my LinkedIn cookies from linkedin.txt"). The agent calls `camofox_import_cookies` → the tool parses the file and POSTs to `/sessions/:userId/cookies` with the Bearer token → cookies are injected into the session.

- `cookiesPath` is resolved relative to the cookies directory — path traversal outside it is blocked
- Max 500 cookies per request, 5MB file size limit
- Cookie objects are sanitized to an allowlist of Playwright fields

Direct REST call:

```bash
curl -X POST http://localhost:9377/sessions/agent1/cookies \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_CAMOFOX_API_KEY' \
  -d '{"cookies":[{"name":"foo","value":"bar","domain":"example.com","path":"/","expires":-1,"httpOnly":false,"secure":false}]}'
```

### Session Persistence

By default, camofox persists each user's cookies and localStorage to `~/.camofox/profiles/`. Sessions survive browser restarts — log in once (via cookies or VNC), and subsequent sessions restore the authenticated state automatically.

```
~/.camofox/
├── cookies/          # Bootstrap cookie files (Netscape format)
└── profiles/         # Persisted session state (auto-managed)
    └── <hashed-userId>/
        └── storage_state.json
```

Override the directory with `CAMOFOX_PROFILE_DIR` or set `"profileDir"` in the persistence plugin config. To disable persistence, set `"persistence": { "enabled": false }` in `camofox.config.json`.

By default, storage state contains cookies and localStorage only. To also persist IndexedDB, set `"indexedDB": true` in the persistence plugin config. This captures all serializable IndexedDB records — not only authentication data — and may make snapshots significantly larger and checkpoints slower.

### Session Tracing

Capture a Playwright trace of every action in a session: page screenshots, DOM snapshots, network requests, and console output. Output is a single `.zip` you can open in Playwright's Trace Viewer.

Opt-in per session by passing `trace: true` when opening the first tab:

```bash
curl -X POST http://localhost:9377/tabs \
  -H 'Content-Type: application/json' \
  -d '{"userId":"agent1","sessionKey":"task1","url":"https://example.com","trace":true}'
```

The trace is written when the session closes. Close the session to flush it, then list, fetch, and view:

```bash
curl -X DELETE http://localhost:9377/sessions/agent1                      # flush
curl http://localhost:9377/sessions/agent1/traces                        # list
curl http://localhost:9377/sessions/agent1/traces/trace-....zip > s.zip  # download
npx playwright show-trace s.zip                                          # view
curl -X DELETE http://localhost:9377/sessions/agent1/traces/trace-....zip # delete
```

Why traces instead of video: Camoufox is Firefox-based, and Playwright's `recordVideo` is Chromium-only. Tracing cannot be toggled on an existing session — `DELETE /sessions/:userId` first if you need to change the flag.

Storage defaults to `~/.camofox/traces/<hashed-userId>/` and is swept on startup:

- `CAMOFOX_TRACES_DIR` — base directory (default: `~/.camofox/traces`)
- `CAMOFOX_TRACES_MAX_BYTES` — max size per trace, removed at next startup if exceeded (default: 50MB)
- `CAMOFOX_TRACES_TTL_HOURS` — traces older than this are removed at next startup (default: 24)

### Proxy + GeoIP

Route all browser traffic through a proxy with automatic locale, timezone, and geolocation derived from the proxy's IP via Camoufox's built-in GeoIP.

**Single string (fork):**

```bash
export PROXY_URL="http://myuser:mypass@166.88.179.132:46040"   # http/https/socks5
npm start
```

**Discrete vars (override PROXY_URL):**

```bash
export PROXY_HOST=166.88.179.132 PROXY_PORT=46040 \
       PROXY_USERNAME=myuser PROXY_PASSWORD=mypass
npm start
```

**Proxy pool (fork) — per-session rotation across same-country proxies:**

```bash
export PROXY_COUNTRY=DE
export PROXY_URLS=$'http://user:pass@h1:11001\nhttp://user:pass@h2:11002'
# or: export CAMOFOX_PROXY_LIST_FILE=/path/to/proxies.txt
npm start
```

**Backconnect (rotating sticky sessions)** for providers like Decodo / Bright Data / Oxylabs:

```bash
export PROXY_STRATEGY=backconnect \
       PROXY_BACKCONNECT_HOST=gate.provider.com PROXY_BACKCONNECT_PORT=7000 \
       PROXY_USERNAME=myuser PROXY_PASSWORD=mypass
npm start
```

When a proxy is configured, all traffic routes through it and GeoIP sets `locale`, `timezone`, and `geolocation` to match the exit IP. With `CAMOFOX_LOCALE_FOLLOWS_PROXY=1`, a persisted profile also re-homes `navigator.language` to `PROXY_COUNTRY` each launch (locale only — the rest of the fingerprint stays stable). Without a proxy, defaults are `en-US`, `America/Los_Angeles`, San Francisco coordinates.

### Structured Logging

All log output is JSON (one object per line):

```json
{"ts":"2026-02-11T23:45:01.234Z","level":"info","msg":"req","reqId":"a1b2c3d4","method":"POST","path":"/tabs","userId":"agent1"}
{"ts":"2026-02-11T23:45:01.567Z","level":"info","msg":"res","reqId":"a1b2c3d4","status":200,"ms":333}
```

Health check requests (`/health`) are excluded from request logging to reduce noise.

### Basic Browsing

```bash
# Create a tab
curl -X POST http://localhost:9377/tabs \
  -H 'Content-Type: application/json' \
  -d '{"userId": "agent1", "sessionKey": "task1", "url": "https://example.com"}'

# Get accessibility snapshot with element refs
curl "http://localhost:9377/tabs/TAB_ID/snapshot?userId=agent1"
# -> { "snapshot": "[button e1] Submit  [link e2] Learn more", ... }

# Click by ref
curl -X POST http://localhost:9377/tabs/TAB_ID/click \
  -H 'Content-Type: application/json' \
  -d '{"userId": "agent1", "ref": "e1"}'

# Type into an element
curl -X POST http://localhost:9377/tabs/TAB_ID/type \
  -H 'Content-Type: application/json' \
  -d '{"userId": "agent1", "ref": "e2", "text": "hello", "pressEnter": true}'

# Navigate with a search macro
curl -X POST http://localhost:9377/tabs/TAB_ID/navigate \
  -H 'Content-Type: application/json' \
  -d '{"userId": "agent1", "macro": "@google_search", "query": "best coffee beans"}'
```

## API

### Tab Lifecycle

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/tabs` | Create tab with initial URL |
| `GET` | `/tabs?userId=X` | List open tabs |
| `GET` | `/tabs/:id/stats` | Tab stats (tool calls, visited URLs) |
| `DELETE` | `/tabs/:id` | Close tab |
| `DELETE` | `/tabs/group/:groupId` | Close all tabs in a group |
| `DELETE` | `/sessions/:userId` | Close all tabs for a user |

### Page Interaction

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/tabs/:id/snapshot` | Accessibility snapshot with element refs. Query params: `includeScreenshot=true` / `?screenshot=true` (add base64 PNG), `offset=N` (paginate) |
| `POST` | `/tabs/:id/click` | Click element by ref or CSS selector |
| `POST` | `/tabs/:id/type` | Type text into element |
| `POST` | `/tabs/:id/press` | Press a keyboard key |
| `POST` | `/tabs/:id/scroll` | Scroll page (up/down/left/right) |
| `POST` | `/tabs/:id/navigate` | Navigate to URL or search macro; supports the `waitFor` readiness contract |
| `POST` | `/tabs/:id/wait` | Wait for selector or timeout |
| `POST` | `/tabs/:id/evaluate` | Run JS in the page; supports `projection` and `maxBytes` |
| `POST` | `/tabs/:id/capture` | Capture the first XHR/fetch response matching a URL pattern |
| `POST` | `/tabs/:id/extract` | Map a JSON Schema to snapshot refs via `x-ref` |
| `POST` | `/tabs/:id/upload` | Attach a file from the uploads directory |
| `GET` | `/tabs/:id/links` | Extract all links on page |
| `GET` | `/tabs/:id/images` | List `<img>` elements. Query: `includeData=true`, `maxBytes=N`, `limit=N` |
| `GET` | `/tabs/:id/downloads` | List captured downloads. Query: `includeData=true`, `consume=true`, `maxBytes=N` |
| `GET` | `/tabs/:id/screenshot` | Take screenshot |
| `POST` | `/tabs/:id/back` \| `/forward` \| `/refresh` | History navigation |

### YouTube Transcript

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/youtube/transcript` | Extract captions from a YouTube video |

```bash
curl -X POST http://localhost:9377/youtube/transcript \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "languages": ["en"]}'
```

Uses [yt-dlp](https://github.com/yt-dlp/yt-dlp) when available (fast, no browser needed). Falls back to a browser-based intercept method if yt-dlp is not installed.

### Server

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check |
| `POST` | `/start` | Start browser engine |
| `POST` | `/stop` | Stop browser engine (requires `CAMOFOX_ADMIN_KEY`) |

### Sessions

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/sessions/:userId/cookies` | Add cookies to a user session (Playwright cookie objects) |
| `GET` | `/sessions/:userId/storage_state` | Export persisted browser storage ([VNC plugin](plugins/vnc/)) |
| `DELETE` | `/sessions/:userId/storage_state` | Reset the live session and delete its persisted storage ([persistence plugin](plugins/persistence/)) |

## Search Macros

`@google_search`  |  `@youtube_search`  |  `@amazon_search`  |  `@reddit_search`  |  `@reddit_subreddit`  |  `@wikipedia_search`  |  `@twitter_search`  |  `@yelp_search`  |  `@spotify_search`  |  `@netflix_search`  |  `@linkedin_search`  |  `@instagram_search`  |  `@tiktok_search`  |  `@twitch_search`

Reddit macros return JSON directly (no HTML parsing needed):
- `@reddit_search` — search all of Reddit, returns JSON with 25 results
- `@reddit_subreddit` — browse a subreddit (query `"programming"` → `/r/programming.json`)

## Browser Configuration

Browser behavior can be tuned in `camofox.config.json`:

```json
{
  "newPageTimeoutMs": 10000
}
```

`newPageTimeoutMs` controls how long tab creation waits for Firefox to create a page. If the context is unresponsive, Camofox replaces only that user's context and retries once. The default is 10 seconds.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CAMOFOX_PORT` / `PORT` | Server port (`PORT` is the PaaS fallback) | `9377` |
| `CAMOFOX_BIND_HOST` | Bind host. `127.0.0.1` for loopback-only, `0.0.0.0` for all IPv4 interfaces. Unset = Node default | - |
| `CAMOFOX_API_KEY` | Enable cookie import endpoint (disabled if unset) | - |
| `CAMOFOX_ADMIN_KEY` | Required for `POST /stop` | - |
| `CAMOFOX_ACCESS_KEY` | If set, all routes (except `/health`, cookie import, `/stop`) require `Authorization: Bearer <key>` | - |
| `CAMOFOX_EVALUATE_MAX_BODY_SIZE` | Max JSON body for `POST /tabs/:id/evaluate` (other JSON routes stay at `100kb`) | `1mb` |
| `CAMOFOX_EVALUATE_MAX_RESULT_BYTES` | Default cap on `evaluate` result size (fork) | `0` (no cap) |
| `CAMOUFOX_EXECUTABLE` | External Camoufox executable (aliases: `CAMOUFOX_EXECUTABLE_PATH`, `CAMOFOX_EXECUTABLE_PATH`) | - |
| `CAMOFOX_DISABLE_DEFAULT_ADDONS` | `1`/`true` to skip the default uBlock Origin download/launch | `0` |
| `CAMOFOX_COOKIES_DIR` | Directory for cookie files | `~/.camofox/cookies` |
| `CAMOFOX_UPLOADS_DIR` | Directory allowed for `POST /tabs/:id/upload` (symlink escapes rejected) | `~/.camofox/uploads` |
| `CAMOFOX_PROFILE_DIR` | Directory for persisted session profiles | `~/.camofox/profiles` |
| `CAMOFOX_FINGERPRINT_FILE` | Path to the persisted `identity.json` (fork) | `<profileDir>/identity.json` |
| `ENABLE_IDENTITY` / `ENABLE_<PLUGIN>` | Env-activate a plugin (fork) | - |
| `CAMOFOX_TRACES_DIR` | Directory for session trace zips | `~/.camofox/traces` |
| `CAMOFOX_TRACES_MAX_BYTES` | Max size per trace, swept if exceeded | `52428800` (50MB) |
| `CAMOFOX_TRACES_TTL_HOURS` | Traces older than this are swept on startup | `24` |
| `CAMOFOX_DISPLAY_RESOLUTION` | Xvfb virtual-display resolution (fork) | `1280x720x24` |
| `CAMOFOX_LOG_TOOL_ARGS` | Log the evaluate expression, redacted (fork) | off |
| `MAX_SESSIONS` | Max concurrent browser sessions | `50` |
| `MAX_TABS_PER_SESSION` | Max tabs per session | `10` |
| `SESSION_TIMEOUT_MS` | Session inactivity timeout | `1800000` (30min) |
| `BROWSER_IDLE_TIMEOUT_MS` | Kill browser when idle (`0` = keep-warm, fork) | `300000` (5min) |
| `TAB_INACTIVITY_MS` | Close tabs idle longer than this | `300000` (5min) |
| `CAMOFOX_INTERACTIVE` | `desktop` opens a real local window; `off` = headless | `off` |
| `HANDLER_TIMEOUT_MS` | Max time for any handler | `30000` (30s) |
| `MAX_CONCURRENT_PER_USER` | Concurrent request cap per user | `3` |
| `MAX_OLD_SPACE_SIZE` | Node.js V8 heap limit (MB) | `128` |
| `PROXY_URL` | Full proxy as one string `scheme://user:pass@host:port` (`http`/`https`/`socks5`); discrete `PROXY_*` override (fork) | - |
| `PROXY_URLS` | Pool of distinct proxy URLs (newline/comma separated); `list` mode, per-session rotation (fork) | - |
| `CAMOFOX_PROXY_LIST_FILE` | File with one proxy URL per line (`#` comments); same as `PROXY_URLS` (fork) | - |
| `CAMOFOX_LOCALE_FOLLOWS_PROXY` | Re-home `navigator.language` to `PROXY_COUNTRY` each launch (fork) | off |
| `PROXY_STRATEGY` | `backconnect` (rotating sticky) or blank (single endpoint) | - |
| `PROXY_PROVIDER` | Provider name for session format (e.g. `decodo`) | `decodo` |
| `PROXY_HOST` / `PROXY_PORT` | Proxy host/port (simple mode) | - |
| `PROXY_USERNAME` / `PROXY_PASSWORD` | Proxy auth | - |
| `PROXY_BACKCONNECT_HOST` / `PROXY_BACKCONNECT_PORT` | Backconnect gateway | port `7000` |
| `PROXY_COUNTRY` / `PROXY_STATE` | Proxy geo-targeting | - |
| `ENABLE_VNC` | Enable the VNC plugin (`1`) | - |
| `VNC_PASSWORD` | Password for VNC access (recommended in production) | - |
| `NOVNC_PORT` | noVNC web UI port | `6080` |

## Interactive desktop & VNC

Camofox is headless by default. Two ways to see the browser:

- **Local desktop** — on a machine with a graphical desktop, opt in to a visible Camoufox window:

  ```bash
  CAMOFOX_INTERACTIVE=desktop npm start   # or "interactive": { "mode": "desktop" } in camofox.config.json
  ```

  Intended for a person at the same machine; it does not expose a remote browser-control service.

- **VNC (remote watch/login)** — enable the VNC plugin to watch or log in over the network, then export storage state for the agent to reuse:

  ```bash
  ENABLE_VNC=1 VNC_PASSWORD=secret npm start   # noVNC on NOVNC_PORT (default 6080)
  ```

## Architecture

```
Browser Instance (Camoufox)              # one per container = one fingerprint
└── User Session (BrowserContext)        # isolated cookies/storage, keyed by sha256(userId)
    ├── Tab Group (sessionKey: "conv1")
    │   ├── Tab (google.com)
    │   └── Tab (github.com)
    └── Tab Group (sessionKey: "conv2")
        └── Tab (amazon.com)
```

Sessions auto-expire after 30 minutes of inactivity. The browser shuts down after 5 minutes with no active sessions and relaunches on the next request (unless `BROWSER_IDLE_TIMEOUT_MS=0`). When a session's tab limit is reached, the oldest/least-used tab is recycled instead of erroring — so long-running agent sessions don't hit dead ends.

## Security Model

- **Code isolation** — all `process.env` reads are centralized in `lib/config.js`; all `child_process` usage is in `lib/launcher.js` (browser) and `plugins/youtube/youtube.js` (yt-dlp). `server.js` has route handlers but zero env reads and zero `child_process` imports.
- **No embedded secrets** — zero credentials, keys or tokens ship in this package; secrets are provided at runtime via env vars.
- **Cookie import disabled by default** — gated behind `CAMOFOX_API_KEY`; files read from a sandboxed directory with path-traversal protection; max 500 cookies / 5MB.
- **Access control** — `CAMOFOX_ACCESS_KEY` gives global bearer auth for all routes except `/health`. Recommended for any deployment beyond localhost.
- **Binary download** — the Camoufox engine (~300MB) is fetched at `npm install` by [`camoufox-js`](https://www.npmjs.com/package/camoufox-js) from official GitHub releases with integrity verification. No custom URLs.
- **Session persistence** — cookies/localStorage saved to `~/.camofox/profiles/<hashed-userId>/`; userIds hashed for directory names.
- **Fleet secrets** — proxy credentials live only in `/var/lib/camofox/profiles.toml` (`0600`/`0700`), never in git.

## Testing

```bash
npm test              # unit + e2e + plugin tests
npm run test:e2e      # e2e only
npm run test:live     # live site tests (Google, macros)
npm run test:debug    # with server output
```

Suites that spawn the server need the real Camoufox binary and are green in the CI-parity image:

```bash
docker build -f Dockerfile.test -t camofox-browser-ai:test .
docker run --rm --shm-size=2g camofox-browser-ai:test tests/unit
```

## License

MIT — a fork of [jo-inc/camofox-browser](https://github.com/jo-inc/camofox-browser), built on [Camoufox](https://camoufox.com).
