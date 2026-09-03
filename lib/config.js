/**
 * Centralized environment configuration for camofox-browser.
 *
 * All process.env access is centralized here for auditability.
 * flag plugin.ts or server.js for env-harvesting (env + network in same file).
 */

import { join, dirname } from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import os from 'os';
import { normalizeDisplayResolution, DEFAULT_DISPLAY_RESOLUTION } from './display.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '..');

const CONFIG_PATH = join(ROOT_DIR, 'camofox.config.json');

function readCamofoxConfig(configPath = CONFIG_PATH) {
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** @deprecated crashReporter config moved to Cloudflare Worker relay. */
function readCrashReporterConfig() {
  return {};
}

/**
 * Parse PROXY_PORTS env var into an array of port numbers.
 * Supports range ("10001-10010") or comma-separated ("10001,10002,10003").
 * Falls back to single PROXY_PORT if PROXY_PORTS is not set.
 */
function parseProxyPorts(portsEnv, singlePort) {
  if (portsEnv) {
    if (portsEnv.includes('-')) {
      const [start, end] = portsEnv.split('-').map(s => parseInt(s.trim(), 10));
      if (!isNaN(start) && !isNaN(end) && end >= start) {
        return Array.from({ length: end - start + 1 }, (_, i) => start + i);
      }
    }
    const parsed = portsEnv.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
    if (parsed.length > 0) return parsed;
  }
  if (singlePort) {
    const p = parseInt(singlePort, 10);
    if (!isNaN(p)) return [p];
  }
  return [];
}

function inferProxyStrategy(explicitStrategy) {
  if (explicitStrategy) return explicitStrategy;
  return 'round_robin';
}

/**
 * Parse a full proxy URL (`scheme://user:pass@host:port`) into discrete fields
 * so a single PROXY_URL can stand in for PROXY_HOST/PORT/USERNAME/PASSWORD
 * (fork change #9). Returns `{}` on empty/invalid input so callers transparently
 * fall back to the discrete PROXY_* vars -- a malformed URL never aborts launch.
 * Credentials are percent-decoded (normalizePlaywrightProxy decodes again at use;
 * decoding here keeps the discrete-field view coherent for logging / DSL building).
 * Only proxy schemes Playwright accepts are honored; anything else is ignored.
 */
export function parseProxyUrl(urlEnv) {
  const raw = String(urlEnv || '').trim();
  if (!raw) return {};
  let url;
  try {
    url = new URL(raw);
  } catch {
    return {};
  }
  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  if (!['http', 'https', 'socks5', 'socks5h', 'socks4'].includes(scheme)) return {};
  if (!url.hostname) return {};
  const decode = (v) => {
    try { return decodeURIComponent(v); } catch { return v; }
  };
  return {
    scheme,
    host: url.hostname,
    port: url.port || '',
    username: url.username ? decode(url.username) : '',
    password: url.password ? decode(url.password) : '',
  };
}

/**
 * Parse a pool of full proxy URLs from PROXY_URLS (newline/comma separated) and/or
 * CAMOFOX_PROXY_LIST_FILE (one URL per line, `#` comments and blanks ignored) into
 * an array of discrete proxy objects (fork change #10). Deduped by scheme://host:port.
 * Each entry is parsed with parseProxyUrl; invalid/unsupported lines are skipped so
 * a bad line never aborts launch. A missing list file is ignored (falls back to the
 * rest). All entries should be the SAME country -- geoip is launch-bound, so mixing
 * countries in one pool yields incoherent tz/locale for the off-country contexts.
 */
function parseProxyList(urlsEnv, listFileEnv) {
  const raw = [];
  if (urlsEnv) raw.push(...String(urlsEnv).split(/[\n,]+/));
  if (listFileEnv) {
    try {
      raw.push(...readFileSync(listFileEnv, 'utf8').split(/\r?\n/));
    } catch { /* missing/unreadable file -> ignore */ }
  }
  const out = [];
  const seen = new Set();
  for (const line of raw) {
    const trimmed = String(line).trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const p = parseProxyUrl(trimmed);
    if (!p.host) continue;
    const key = `${p.scheme}://${p.host}:${p.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function camoufoxCacheDir(env = process.env) {
  const home = os.homedir();
  if (process.platform === 'darwin') return join(home, 'Library', 'Caches', 'camoufox');
  if (process.platform === 'win32') {
    const base = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    return join(base, 'camoufox', 'camoufox', 'Cache');
  }
  return join(env.XDG_CACHE_HOME || join(home, '.cache'), 'camoufox');
}

function camoufoxExecutablePath(env = process.env) {
  return (
    env.CAMOUFOX_EXECUTABLE ||
    env.CAMOUFOX_EXECUTABLE_PATH ||
    env.CAMOFOX_EXECUTABLE_PATH ||
    ''
  ).trim();
}

function normalizeInteractiveMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return ['off', 'desktop', 'novnc', 'auto'].includes(mode) ? mode : 'off';
}

function loadConfig({ configPath = CONFIG_PATH } = {}) {
  const externalCamoufoxExecutable = camoufoxExecutablePath();
  const browserIdleTimeoutMs = parseInt(process.env.BROWSER_IDLE_TIMEOUT_MS, 10);
  const fileConfig = readCamofoxConfig(configPath);
  const configuredNewPageTimeoutMs = Number(fileConfig.newPageTimeoutMs);
  const newPageTimeoutMs = Number.isFinite(configuredNewPageTimeoutMs) && configuredNewPageTimeoutMs > 0
    ? configuredNewPageTimeoutMs
    : 10000;
  const configuredInteractiveMode = fileConfig.interactive?.mode;
  const interactiveMode = normalizeInteractiveMode(process.env.CAMOFOX_INTERACTIVE || configuredInteractiveMode);
  return {
    port: parseInt(process.env.CAMOFOX_PORT || process.env.PORT || '9377', 10),
    bindHost: (process.env.CAMOFOX_BIND_HOST || '').trim(),
    nodeEnv: process.env.NODE_ENV || 'development',
    flyMachineId: process.env.FLY_MACHINE_ID || '',
    flyAppName: process.env.FLY_APP_NAME || '',
    flyApiToken: process.env.FLY_API_TOKEN || '',
    adminKey: process.env.CAMOFOX_ADMIN_KEY || '',
    apiKey: process.env.CAMOFOX_API_KEY || '',
    accessKey: (process.env.CAMOFOX_ACCESS_KEY || '').trim(),
    evaluateMaxBodySize: process.env.CAMOFOX_EVALUATE_MAX_BODY_SIZE || '1mb',
    // Optional default byte-cap on evaluate results (0 = unlimited). A per-call
    // `maxBytes` overrides this. See lib/evaluate-projection.js / fork change #2.
    evaluateMaxResultBytes: parseInt(process.env.CAMOFOX_EVALUATE_MAX_RESULT_BYTES, 10) || 0,
    cookiesDir: process.env.CAMOFOX_COOKIES_DIR || join(os.homedir(), '.camofox', 'cookies'),
    uploadsDir: process.env.CAMOFOX_UPLOADS_DIR || join(os.homedir(), '.camofox', 'uploads'),
    profileDir: process.env.CAMOFOX_PROFILE_DIR || join(os.homedir(), '.camofox', 'profiles'),
    tracesDir: process.env.CAMOFOX_TRACES_DIR || join(os.homedir(), '.camofox', 'traces'),
    // When false, tracesDir is the default (container-ephemeral) path -- trace.zip
    // is lost on `docker run --rm` without a volume; the engine warns once (fork change).
    tracesDirExplicit: !!process.env.CAMOFOX_TRACES_DIR,
    tracesMaxBytes: parseInt(process.env.CAMOFOX_TRACES_MAX_BYTES || String(50 * 1024 * 1024), 10),
    tracesTtlHours: parseInt(process.env.CAMOFOX_TRACES_TTL_HOURS || '24', 10),
    handlerTimeoutMs: parseInt(process.env.HANDLER_TIMEOUT_MS) || 30000,
    newPageTimeoutMs,
    maxConcurrentPerUser: parseInt(process.env.MAX_CONCURRENT_PER_USER) || 3,
    sessionTimeoutMs: parseInt(process.env.SESSION_TIMEOUT_MS) || 600000,
    tabInactivityMs: parseInt(process.env.TAB_INACTIVITY_MS) || 300000,
    maxSessions: parseInt(process.env.MAX_SESSIONS) || 50,
    maxTabsPerSession: parseInt(process.env.MAX_TABS_PER_SESSION) || 10,
    maxTabsGlobal: parseInt(process.env.MAX_TABS_GLOBAL) || 50,
    navigateTimeoutMs: parseInt(process.env.NAVIGATE_TIMEOUT_MS) || 25000,
    buildrefsTimeoutMs: parseInt(process.env.BUILDREFS_TIMEOUT_MS) || 12000,
    // Idle grace before closing the browser with no sessions. Set to 0 to keep it
    // warm indefinitely (fork change #8) -- disables idle shutdown + enables re-warm.
    browserIdleTimeoutMs: Number.isFinite(browserIdleTimeoutMs) ? browserIdleTimeoutMs : 300000,
    nativeMemRestartThresholdMb: parseInt(process.env.NATIVE_MEM_RESTART_THRESHOLD_MB) || 300,
    browserRssRestartThresholdMb: parseInt(process.env.BROWSER_RSS_RESTART_THRESHOLD_MB) || 1500,
    camoufoxExecutablePath: externalCamoufoxExecutable,
    camoufoxCacheDir: camoufoxCacheDir(),
    prometheusEnabled: process.env.PROMETHEUS_ENABLED === '1' || process.env.PROMETHEUS_ENABLED === 'true',
    disableDefaultAddons: process.env.CAMOFOX_DISABLE_DEFAULT_ADDONS === '1' || process.env.CAMOFOX_DISABLE_DEFAULT_ADDONS === 'true',
    // Default virtual-display (Xvfb) resolution "WxHxDepth". Configurable so a
    // headless run can be aligned with a VNC-watched run for screenshot parity
    // (fork change #5). The vnc plugin still overrides this with its own resolution.
    displayResolution: normalizeDisplayResolution(process.env.CAMOFOX_DISPLAY_RESOLUTION) || DEFAULT_DISPLAY_RESOLUTION,
    // Opt-in: log tool arguments (currently the evaluate expression) with secret
    // redaction + length cap, so agent runs are debuggable (fork change #7). Off by
    // default because expressions can carry sensitive data.
    logToolArgs: process.env.CAMOFOX_LOG_TOOL_ARGS === '1' || process.env.CAMOFOX_LOG_TOOL_ARGS === 'true',
    interactiveMode,
    proxy: (() => {
      // PROXY_URL is a convenience base: discrete PROXY_* vars always win over it,
      // so you can paste a full URL yet still override a single field (fork change #9).
      const url = parseProxyUrl(process.env.PROXY_URL);
      const host = process.env.PROXY_HOST || url.host || '';
      const port = process.env.PROXY_PORT || url.port || '';
      // Pool of distinct full-proxy endpoints (fork change #10). When present with no
      // explicit strategy, activates 'list' mode (per-context rotation).
      const urls = parseProxyList(process.env.PROXY_URLS, process.env.CAMOFOX_PROXY_LIST_FILE);
      return {
      strategy: inferProxyStrategy(process.env.PROXY_STRATEGY || (urls.length ? 'list' : '')),
      providerName: process.env.PROXY_PROVIDER || 'decodo',
      urls,
      // Playwright proxy scheme (http/https/socks5). Only PROXY_URL carries it;
      // discrete-var configs stay on the http default they always used.
      scheme: url.scheme || 'http',
      host,
      port,
      ports: parseProxyPorts(process.env.PROXY_PORTS, port),
      username: process.env.PROXY_USERNAME || url.username || '',
      password: process.env.PROXY_PASSWORD || url.password || '',
      backconnectHost: process.env.PROXY_BACKCONNECT_HOST || url.host || '',
      backconnectPort: parseInt(process.env.PROXY_BACKCONNECT_PORT || url.port || '7000', 10),
      country: process.env.PROXY_COUNTRY || '',
      state: process.env.PROXY_STATE || '',
      city: process.env.PROXY_CITY || '',
      zip: process.env.PROXY_ZIP || '',
      sessionDurationMinutes: parseInt(process.env.PROXY_SESSION_DURATION_MINUTES || '10', 10),
      };
    })(),
    // Plugin activation gate: loadPlugins() checks each plugin's plugin.json
    // `enableEnvVar` against this map. Use the full ambient env so ANY plugin can
    // be enabled by its own env var (ENABLE_<PLUGIN>), not just VNC (fork change #1).
    // Plugins already run in this process, so this exposes no env they couldn't
    // already read via process.env.
    pluginEnv: process.env,
    // Env vars forwarded to the server subprocess
    serverEnv: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: process.env.NODE_ENV,
      CAMOFOX_BIND_HOST: process.env.CAMOFOX_BIND_HOST,
      CAMOFOX_ADMIN_KEY: process.env.CAMOFOX_ADMIN_KEY,
      CAMOFOX_API_KEY: process.env.CAMOFOX_API_KEY,
      CAMOFOX_ACCESS_KEY: process.env.CAMOFOX_ACCESS_KEY,
      CAMOFOX_EVALUATE_MAX_BODY_SIZE: process.env.CAMOFOX_EVALUATE_MAX_BODY_SIZE,
      CAMOFOX_EVALUATE_MAX_RESULT_BYTES: process.env.CAMOFOX_EVALUATE_MAX_RESULT_BYTES,
      CAMOFOX_COOKIES_DIR: process.env.CAMOFOX_COOKIES_DIR,
      CAMOFOX_UPLOADS_DIR: process.env.CAMOFOX_UPLOADS_DIR,
      CAMOFOX_TRACES_DIR: process.env.CAMOFOX_TRACES_DIR,
      CAMOFOX_TRACES_MAX_BYTES: process.env.CAMOFOX_TRACES_MAX_BYTES,
      CAMOFOX_TRACES_TTL_HOURS: process.env.CAMOFOX_TRACES_TTL_HOURS,
      CAMOFOX_DISABLE_DEFAULT_ADDONS: process.env.CAMOFOX_DISABLE_DEFAULT_ADDONS,
      CAMOFOX_DISPLAY_RESOLUTION: process.env.CAMOFOX_DISPLAY_RESOLUTION,
      CAMOFOX_LOG_TOOL_ARGS: process.env.CAMOFOX_LOG_TOOL_ARGS,
      CAMOFOX_LOCALE_FOLLOWS_PROXY: process.env.CAMOFOX_LOCALE_FOLLOWS_PROXY,
      CAMOFOX_INTERACTIVE: process.env.CAMOFOX_INTERACTIVE,
      CAMOUFOX_EXECUTABLE: process.env.CAMOUFOX_EXECUTABLE,
      CAMOUFOX_EXECUTABLE_PATH: process.env.CAMOUFOX_EXECUTABLE_PATH,
      CAMOFOX_EXECUTABLE_PATH: process.env.CAMOFOX_EXECUTABLE_PATH,
      PROXY_URL: process.env.PROXY_URL,
      PROXY_URLS: process.env.PROXY_URLS,
      CAMOFOX_PROXY_LIST_FILE: process.env.CAMOFOX_PROXY_LIST_FILE,
      PROXY_STRATEGY: process.env.PROXY_STRATEGY,
      PROXY_PROVIDER: process.env.PROXY_PROVIDER,
      PROXY_HOST: process.env.PROXY_HOST,
      PROXY_PORT: process.env.PROXY_PORT,
      PROXY_PORTS: process.env.PROXY_PORTS,
      PROXY_USERNAME: process.env.PROXY_USERNAME,
      PROXY_PASSWORD: process.env.PROXY_PASSWORD,
      PROXY_BACKCONNECT_HOST: process.env.PROXY_BACKCONNECT_HOST,
      PROXY_BACKCONNECT_PORT: process.env.PROXY_BACKCONNECT_PORT,
      PROXY_COUNTRY: process.env.PROXY_COUNTRY,
      PROXY_STATE: process.env.PROXY_STATE,
      PROXY_CITY: process.env.PROXY_CITY,
      PROXY_ZIP: process.env.PROXY_ZIP,
      PROXY_SESSION_DURATION_MINUTES: process.env.PROXY_SESSION_DURATION_MINUTES,
      ENABLE_VNC: process.env.ENABLE_VNC,
      VNC_RESOLUTION: process.env.VNC_RESOLUTION,
      VNC_PASSWORD: process.env.VNC_PASSWORD,
      VIEW_ONLY: process.env.VIEW_ONLY,
      VNC_PORT: process.env.VNC_PORT,
      NOVNC_PORT: process.env.NOVNC_PORT,
      VNC_BIND: process.env.VNC_BIND,
    },
    // Crash reporter (opt-in, reports sent to Cloudflare Worker relay)
    crashReportEnabled:   process.env.CAMOFOX_CRASH_REPORT_ENABLED !== 'false',
    crashReportUrl:       process.env.CAMOFOX_CRASH_REPORT_URL || '',
    crashReportRepo:      process.env.CAMOFOX_CRASH_REPORT_REPO,
    crashReportRateLimit: parseInt(process.env.CAMOFOX_CRASH_REPORT_RATE_LIMIT, 10) || 10,
    crashReporterConfig:  readCrashReporterConfig(),
    sentryDsn: process.env.SENTRY_DSN || '',
  };
}

export { loadConfig, readCamofoxConfig };
