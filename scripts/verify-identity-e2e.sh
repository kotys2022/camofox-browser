#!/usr/bin/env bash
#
# E2E verification for FIX #0 (identity plugin): a persisted fingerprint stays
# stable across an idle-kill browser relaunch *inside a live container*.
#
# Phases:
#   POSITIVE  identity plugin ON  -> fingerprint identical before/after relaunch
#   NEGATIVE  identity plugin OFF -> fingerprint drifts (proves the probe discriminates)
#
# The relaunch is the real thing: BROWSER_IDLE_TIMEOUT_MS is set low, the session
# is dropped (sessions -> 0 schedules idle shutdown -> browser closes fully), then
# a new tab forces ensureBrowser() -> launchBrowserInstance() -> our hook again.
#
# The probe page is served by a sidecar container on a private docker network
# (the server only allows http/https URLs, not data:/about:).
#
# Usage:
#   scripts/verify-identity-e2e.sh              # build + positive + negative
#   SKIP_BUILD=1 scripts/verify-identity-e2e.sh # reuse existing image tag
#   NEGATIVE=0   scripts/verify-identity-e2e.sh # positive only
#
# Env knobs: IMAGE, PORT, IDLE_MS, KEEP (1=don't tear down on exit).
set -euo pipefail

IMAGE="${IMAGE:-camofox-browser:identity-test}"
PORT="${PORT:-9378}"
IDLE_MS="${IDLE_MS:-3000}"
NEGATIVE="${NEGATIVE:-1}"
BASE="http://127.0.0.1:${PORT}"
NET="idnet-e2e-$$"
PROBE="idprobe-$$"
PROBE_URL="http://${PROBE}/probe.html"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
CID=""

log()  { printf '\033[1;36m[e2e]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[FAIL]\033[0m %s\n' "$*"; exit 1; }
pass() { printf '\033[1;32m[PASS]\033[0m %s\n' "$*"; }

cleanup() {
  [ -z "${KEEP:-}" ] || { log "KEEP=1 — leaving $CID / $PROBE / $NET up"; rm -rf "$WORK"; return; }
  [ -n "$CID" ] && docker rm -f "$CID" >/dev/null 2>&1 || true
  docker rm -f "$PROBE" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

for bin in docker curl jq; do command -v "$bin" >/dev/null || fail "missing dependency: $bin"; done

# --- fingerprint probe: navigator/screen/webgl (fingerprint-derived, must be stable) ---
read -r -d '' FP_JS <<'JS' || true
JSON.stringify({
  ua: navigator.userAgent,
  platform: navigator.platform,
  hc: navigator.hardwareConcurrency,
  dm: navigator.deviceMemory,
  lang: (navigator.languages||[]).join(','),
  screen: [screen.width, screen.height, screen.colorDepth, window.devicePixelRatio],
  webgl: (function(){try{var g=document.createElement('canvas').getContext('webgl');var e=g.getExtension('WEBGL_debug_renderer_info');return [g.getParameter(e.UNMASKED_VENDOR_WEBGL), g.getParameter(e.UNMASKED_RENDERER_WEBGL)];}catch(_){return null;}})(),
  canvas: (function(){var c=document.createElement('canvas');c.width=220;c.height=40;var x=c.getContext('2d');x.textBaseline='top';x.font='14px Arial';x.fillStyle='#f60';x.fillRect(0,0,120,20);x.fillStyle='#069';x.fillText('camofox-identity',2,15);return c.toDataURL();})()
})
JS

wait_health() {
  for _ in $(seq 1 60); do
    if curl -fsS "$BASE/health" 2>/dev/null | jq -e '.ok==true' >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  docker logs "$CID" 2>&1 | tail -30 || true
  fail "container did not become healthy on $BASE"
}

# capture a fingerprint bundle via a fresh session; leaves sessions=0 afterwards
capture_fp() {
  local uid="$1" tab fp
  tab="$(curl -fsS -X POST "$BASE/tabs" -H 'content-type: application/json' \
    -d "$(jq -n --arg u "$uid" --arg s "s-$uid" --arg url "$PROBE_URL" \
          '{userId:$u,sessionKey:$s,url:$url}')" | jq -r '.tabId')"
  [ -n "$tab" ] && [ "$tab" != null ] || fail "tab create failed for $uid"
  fp="$(curl -fsS -X POST "$BASE/tabs/$tab/evaluate" -H 'content-type: application/json' \
    -d "$(jq -n --arg u "$uid" --arg e "$FP_JS" '{userId:$u,expression:$e}')" \
    | jq -r '.result')"
  curl -fsS -X DELETE "$BASE/sessions/$uid" >/dev/null || true
  printf '%s' "$fp"
}

run_container() {
  local cfg="$1"
  cp "$cfg" "$WORK/camofox.config.json"
  mkdir -p "$WORK/slot"; rm -f "$WORK/slot/identity.json"
  CID="$(docker run -d --rm --network "$NET" --shm-size=2g -p "127.0.0.1:${PORT}:9377" \
    -e "BROWSER_IDLE_TIMEOUT_MS=${IDLE_MS}" \
    -e CAMOFOX_CRASH_REPORT_ENABLED=false \
    -v "$WORK/camofox.config.json:/app/camofox.config.json:ro" \
    -v "$WORK/slot:/slot" \
    "$IMAGE")"
  wait_health
}

phase() {
  local name="$1" cfg="$2" expect="$3"   # expect: same|diff
  log "phase $name — starting container"
  run_container "$cfg"

  # Stable identity = fingerprint-derived fields (ua/platform/webgl/screen/...).
  # canvas:aaOffset is re-randomized every launch by camoufox on this build and is
  # NOT part of the persisted identity, so canvas is compared informationally only.
  local fp1 fp2 s1 s2
  fp1="$(capture_fp u1)"; s1="$(printf '%s' "$fp1" | jq -Sc 'del(.canvas)')"
  log "$name launch#1 webgl=$(printf '%s' "$fp1" | jq -c '.webgl')"
  [ -f "$WORK/slot/identity.json" ] && log "$name identity.json: $(jq -c '{generatedAt,webgl,seeds:(.config|keys)}' "$WORK/slot/identity.json" 2>/dev/null)" || log "$name no identity.json (expected for NEGATIVE)"

  log "$name waiting for idle-kill relaunch (> ${IDLE_MS}ms)..."
  sleep "$(awk "BEGIN{print ($IDLE_MS/1000)+3}")"

  fp2="$(capture_fp u2)"; s2="$(printf '%s' "$fp2" | jq -Sc 'del(.canvas)')"
  log "$name launch#2 webgl=$(printf '%s' "$fp2" | jq -c '.webgl')"

  local injects
  injects="$(docker logs "$CID" 2>&1 | grep -c 'injected persistent fingerprint' || true)"
  log "$name 'injected persistent fingerprint' log lines: $injects"

  docker rm -f "$CID" >/dev/null 2>&1 || true; CID=""

  if [ "$expect" = same ]; then
    [ "$s1" = "$s2" ] || { printf 'FP1=%s\nFP2=%s\n' "$s1" "$s2"; fail "$name: fingerprint drifted across relaunch (identity NOT stable)"; }
    [ "${injects:-0}" -ge 2 ] || fail "$name: expected >=2 identity injections, got $injects (hook not firing on relaunch)"
    pass "$name: fingerprint IDENTICAL across idle-kill relaunch; hook fired $injects times"
  else
    [ "$s1" != "$s2" ] || fail "$name: fingerprint identical without identity plugin — probe cannot detect drift, positive result is meaningless"
    pass "$name: fingerprint DRIFTED across relaunch (control confirms probe discriminates)"
  fi
}

# --- configs ---
cat >"$WORK/config.identity.json" <<'JSON'
{
  "plugins": {
    "identity": { "enabled": true, "fingerprintFile": "/slot/identity.json", "generate": true },
    "persistence": { "enabled": false },
    "vnc": { "enabled": false }
  },
  "newPageTimeoutMs": 15000,
  "interactive": { "mode": "off" }
}
JSON

cat >"$WORK/config.plain.json" <<'JSON'
{ "plugins": {}, "newPageTimeoutMs": 15000, "interactive": { "mode": "off" } }
JSON

# --- build ---
if [ -z "${SKIP_BUILD:-}" ]; then
  log "building $IMAGE from current sources (cached layers reused)..."
  docker build -t "$IMAGE" "$REPO" >/dev/null
else
  log "SKIP_BUILD=1 — using existing $IMAGE"
fi

# --- private network + probe sidecar (server only allows http/https URLs) ---
log "starting probe sidecar on private network $NET"
docker network create "$NET" >/dev/null
printf '%s' '<html><body>identity-probe</body></html>' >"$WORK/probe.html"
docker run -d --rm --name "$PROBE" --network "$NET" \
  -v "$WORK/probe.html:/srv/probe.html:ro" "$IMAGE" \
  sh -c 'python3 -m http.server 80 --directory /srv' >/dev/null

phase POSITIVE "$WORK/config.identity.json" same
[ "$NEGATIVE" = 1 ] && phase NEGATIVE "$WORK/config.plain.json" diff || log "NEGATIVE control skipped"

pass "identity E2E verification complete"
