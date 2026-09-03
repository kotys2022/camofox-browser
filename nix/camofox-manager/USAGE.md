# camofox proxyctl — guide (architecture + operations + deployment)

Fleet model: **1 image → N profile-containers**, each with its own volume
(identity + cookies) and its own proxy. The source of truth is
`/var/lib/camofox/profiles.toml`. Management is via `proxyctl` (reconcile into
docker). Module: `../camofox-browser.nix`; manager: `proxyctl` (in this folder).

---

## Architecture and principles

- **Repo separation:** the engine (public `kotys2022/camofox-browser`) knows only
  `PROXY_URL`/`PROXY_URLS`/`PROXY_COUNTRY`. All orchestration — "profile↔proxy, many
  containers, health/heal" — lives here, in the private repo. Operational secrets
  (proxy lists) never reach the public repo.
- **1 profile = 1 container = 1 fingerprint** (singleton fingerprint per container).
  N profiles = N containers.
- **Country = container boundary** (geoip is launch-bound; mixing countries in one pool is not allowed).
- **Proxy is launch-bound:** changing the proxy = restarting the container. The
  `identity.json` in the volume survives the restart → replacing a proxy **of the
  same country** is non-destructive.
- **"Beyond declarative" model:** Nix holds only the STATIC parts (rebuild-safe): docker,
  `proxyctl` in PATH, the `/var/lib/camofox` directory, and two oneshots — `camofox-migrate`
  (bootstrap/migration) and `camofox-apply` (`proxyctl apply` at boot).
  Containers are supervised by docker itself (`--restart=unless-stopped`); reconcile is `proxyctl
  apply` by the `camofox.managed` labels + `spec-hash`. **A rebuild does NOT touch containers or
  `/var/lib/camofox`** → profile data is not overwritten.
- **Source of truth:** `/var/lib/camofox/profiles.toml` — `0600 root`, runtime-mutable.
  Proxy credentials are in cleartext (protection: permissions + an encrypted disk; sops-at-rest
  is a possible future hardening).
- **Per-profile container parameters (automatic):** `camofox-<id>`, port
  `127.0.0.1:<port>:9377`, `--shm-size=2g`, volume `/var/lib/camofox/<id>:/root/.camofox`;
  env `ENABLE_IDENTITY=1` + `CAMOFOX_CRASH_REPORT_ENABLED=false` + `MAX_OLD_SPACE_SIZE=2048`
  + `PROXY_COUNTRY` + `PROXY_URL` (sticky) / `PROXY_URLS` (pool) + optional
  `CAMOFOX_LOCALE_FOLLOWS_PROXY=1`.

---

## 0. Basics

The profiles file is `0600 root`, so all commands go through `sudo`. Full form:
```bash
sudo proxyctl -f /var/lib/camofox/profiles.toml <command>
```
**Aliases are provided by the module itself** (`environment.shellAliases`, working in
fish/bash after deploy, in a new shell session) — no need to create them by hand:

| Alias | Expands to |
|---|---|
| `pcx <cmd>` | `sudo proxyctl -f …/profiles.toml <cmd>` (base) |
| `pcxedit` | `sudoedit …/profiles.toml` |
| `pcxls` | `… ls` |
| `pcxplan` | `… apply` (dry-run) |
| `pcxapply` | `… apply --apply` |
| `pcxprune` | `… apply --apply --prune` |
| `pcxhealth` | `… health` |
| `pcxheal` | `… heal --apply` |

⚠️ sudo is already INSIDE the alias → type `pcxls`, **not** `sudo pcxls`.
Further in this guide, `pcx` = `sudo proxyctl -f /var/lib/camofox/profiles.toml`.

**Workflow model:** edit `profiles.toml` (with any editor) → `pcx apply --apply`.
There are no separate `create`/`edit`/`delete` commands — the file *is* the control
panel, and `apply` means "apply it".

Key paths/facts:
- profiles: `/var/lib/camofox/profiles.toml`
- data for profile `<id>`: `/var/lib/camofox/<id>/` (identity.json, storage-state, cookies)
- profile container: `camofox-<id>`, port `127.0.0.1:<port>:9377`
- image: `camofox-browser:local`

---

## 1. View state

```bash
pcx ls           # profiles: kind / country / port / proxy count / status (up|down)
pcx validate     # toml check (kind, port uniqueness, presence of proxies)
pcx apply        # DRY-RUN: what apply would do (create/recreate/remove/orphan)
```

Health of a profile's own engine (e.g. default on :9377):
```bash
curl -s http://127.0.0.1:9377/health        # {"ok":true,"browserConnected":...}
```

---

## 2. Create a profile

Open the file:
```bash
sudoedit /var/lib/camofox/profiles.toml
```

### 2a. Direct (no proxy) — e.g. a local engine
```toml
[profiles.default]
kind = "sticky"
port = 9377
```

### 2b. Sticky — a single fixed proxy (login accounts, stable identity↔IP pair)
```toml
[profiles.acct-de]
kind    = "sticky"
country = "DE"
port    = 9401
proxy   = "http://user:pass@gate.example:11001"
```

### 2c. Pool — a list of proxies of one country, per-session rotation (bulk scraping)
```toml
[profiles.parse-de]
kind    = "pool"
country = "DE"
port    = 9403
proxies = [
  "http://user:pass@h1.example:11001",
  "http://user:pass@h2.example:11002",
]
```

### Optional profile fields
```toml
localeFollowsProxy = true          # update navigator.language to match PROXY_COUNTRY each launch
[profiles.parse-de.env]            # arbitrary NON-secret env for this profile
CAMOFOX_DISPLAY_RESOLUTION = "1920x1080"
BROWSER_IDLE_TIMEOUT_MS    = "0"   # keep-warm (do not idle-close the browser)
```

Apply:
```bash
pcx apply              # look at the plan first (dry-run)
pcx apply --apply      # bring up the container(s)
pcx ls                 # confirm: status = up
```
Proxy schemes: `http` / `https` / `socks5`. Each profile's port is unique.

---

## 3. Edit a profile

You edit the needed lines in `profiles.toml` and apply. A container is **recreated**
only if something that affects it changed (proxy/port/country/env) — **identity in the
volume is preserved**.

```bash
sudoedit /var/lib/camofox/profiles.toml     # changed proxy / port / added to pool
pcx apply                                    # plan: you'll see "~ recreate ..."
pcx apply --apply
```

Examples:
- **Replace a proxy (same country):** edit `proxy = "..."` → `apply --apply`
  (the container is recreated on the new IP, the fingerprint stays the same).
- **Add a proxy to a pool:** append a line to `proxies = [ ... ]` → `apply --apply`.
- **Change the port:** edit `port` → `apply --apply` (recreation).
- **Re-home to another country:** change `country` + set `localeFollowsProxy = true`
  (otherwise `navigator.language` stays the old one). geoip (tz/geo/webrtc) follows automatically.

---

## 4. Delete a profile

Remove its `[profiles.<id>]` block from the file and apply with `--prune`:
```bash
sudoedit /var/lib/camofox/profiles.toml       # erase the profile block
pcx apply --apply --prune                      # remove the container that is no longer in the toml
```
> **Data is NOT deleted** automatically — `/var/lib/camofox/<id>/` (identity + cookies)
> remains. To remove it for good:
> ```bash
> sudo rm -rf /var/lib/camofox/<id>
> ```

⚠️ `--prune` removes **all** managed containers that are not in the toml. Without `--prune`
such containers remain (marked `! orphan` in the plan) — this is a safeguard against an
accidental teardown caused by the wrong file. Always look at `pcx apply` (dry-run) before `--prune`.

---

## 5. Proxies: checking and auto-replacement

Reserves (spares) per country in the same file:
```toml
[spares]
DE = [ "http://user:pass@spare1.example:11001" ]
SI = [ "http://user:pass@spare2.example:11001" ]
```

```bash
pcx health                 # pings each profile's proxy (and spares) through the proxy itself
pcx health --timeout 6     # shorter proxy timeout

pcx heal                   # DRY-RUN: which dead ones would be replaced by a live spare of the same country
pcx heal --apply           # execute: swap in the toml (+ .bak) and apply
```
`heal` takes a live spare **of the same country**, substitutes it for the dead one (preserving
the file's format/comments), and applies. The used spare stays in `[spares]` but is
skipped afterwards (it's already in a profile). Remove it manually if you wish.

---

## 6. Working with a profile's engine (REST on its port)

Each profile is a separate REST engine on `127.0.0.1:<port>`.

```bash
P=9403   # profile port

# health
curl -s http://127.0.0.1:$P/health

# create a tab (http/https only; about: is blocked)
TAB=$(curl -s -X POST http://127.0.0.1:$P/tabs -H 'content-type: application/json' \
  -d '{"userId":"u1","sessionKey":"s1","url":"https://api.ipify.org?format=json"}')
TABID=$(echo "$TAB" | python3 -c 'import sys,json;print(json.load(sys.stdin)["tabId"])')

# run JS in the page (e.g. check exit-IP / locale / tz)
curl -s -X POST http://127.0.0.1:$P/tabs/$TABID/evaluate -H 'content-type: application/json' \
  -d '{"userId":"u1","expression":"({ip:JSON.parse(document.body.innerText).ip, lang:navigator.language, tz:Intl.DateTimeFormat().resolvedOptions().timeZone})"}'

# close the user's session (context + cookies of this userId)
curl -s -X DELETE http://127.0.0.1:$P/sessions/u1
```
Geo-coherence check for the profile: `ip` must be the proxy's exit-IP, `tz`/`lang` must match the country.

---

## 7. Move / preserve identity

- **Not losing the fingerprint when replacing a proxy:** do nothing — `apply` recreates
  the container, while `identity.json` sits in the volume `/var/lib/camofox/<id>/` and survives it.
- **Move a profile to another machine 1-to-1:** copy `/var/lib/camofox/<id>/` +
  add its block to `profiles.toml` on the new machine → `pcx apply --apply`.
- **Reset the fingerprint (generate a new one):** `sudo rm /var/lib/camofox/<id>/profiles/identity.json`
  → `pcx apply --apply` (the next launch generates a new one for the current country).

---

## 8. Updating the engine image (rev-bump)

When a new version of the fork is out:
1. bump the SHA in **flake.nix** (input url) + `nix flake update camofox-browser` (flake.lock)
   + **deploy.sh** (`CAMOFOX_REV`) — the same SHA in three places;
2. `sudo bash deploy.sh` (the rev-guard rebuilds the image; log at `/var/lib/camofox/build-*.log`;
   on an actual rebuild the managed containers are recreated on the new image, identity preserved).

Force a rebuild: `CAMOFOX_REBUILD=1 sudo bash deploy.sh`.

---

## 9. Deployment on new hardware (fresh)

### What deploy.sh reproduces automatically
- **The engine image** — after switch, deploy.sh clones the pinned rev (`CAMOFOX_REV` in
  deploy.sh == flake-input `camofox-browser` in flake.lock) and runs `make build`
  (~15-20 min once, Camoufox ~712 MB). Log: `/var/lib/camofox/build-<rev>.log`.
- **The MCP adapter** (`hermes.nix`) — from the same pinned rev.
- **proxyctl** — the package from `./camofox-manager` (in PATH).
- **The `default` profile** — `camofox-migrate` seeds `profiles.toml` itself (`[profiles.default]`,
  :9377, direct), `camofox-apply` brings up the container. The engine for Hermes comes up on its own.

### What does NOT travel (runtime state, outside git)
- The specific **proxy/pool profiles + their identity/cookies** from `/var/lib/camofox/`.
  You add them again on the new machine. Fingerprints will be generated anew (per-machine).
- To move a profile 1-to-1 — manually copy `/var/lib/camofox/<id>/` (section 7).

### Steps
1. Standard fresh NixOS: generate `hardware-configuration.nix`
   (`nixos-generate-config`), place the sops age key (for the rest of the config's secrets).
2. `sudo bash deploy.sh` (the first time — with the image, ~15-20 min).
   - Watch the build: `sudo tail -f /var/lib/camofox/build-*.log`.
   - If the image did not build — force: `CAMOFOX_REBUILD=1 sudo bash deploy.sh`.
3. Check: `pcx ls` (default = up), `curl -s http://127.0.0.1:9377/health`.

### Startup order (why it's clean)
On a fresh box, `camofox-apply` runs during switch — **earlier** than deploy.sh
builds the image. `proxyctl apply` sees this (no image yet) and **cleanly defers** the
create (the oneshot is green, no failures). After `make build`, deploy.sh runs
`systemctl restart camofox-apply` → the image is now present → `default` comes up.

---

## 10. Troubleshooting

```bash
pcx ls                                          # profile status
docker ps -a --filter name=camofox              # containers + state
docker logs camofox-<id> 2>&1 | tail -40        # a profile engine's log
journalctl -u camofox-apply -u camofox-migrate  # fleet oneshots
docker images | grep camofox-browser            # whether :local exists
sudo tail -f /var/lib/camofox/build-*.log       # image build log
```
- `status=down` / `browserConnected:false` while idle — normal (lazy launch), it comes up on the first `/tabs`.
- a profile is not created and there is no image → build it: `CAMOFOX_REBUILD=1 sudo bash deploy.sh`.
- a leftover container remains → `pcx apply --apply --prune` (look at `pcx apply` first).

---

## Cheat sheet

| Action | Command |
|---|---|
| List profiles | `pcxls` |
| Change plan (dry-run) | `pcxplan` |
| Apply | `pcxapply` |
| Apply + remove leftovers | `pcxprune` |
| Create/edit | `pcxedit` + `pcxapply` |
| Delete a profile | erase the block + `pcxprune` (+ `rm -rf <id>`) |
| Check proxies | `pcxhealth` |
| Auto-replace dead ones | `pcxheal` |
| Reset the fingerprint | `rm .../<id>/profiles/identity.json` + `pcxapply` |
