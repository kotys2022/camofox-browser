/**
 * Sanitized auth-state summary from persisted storage state.
 *
 * Answers "does this userId have a saved login for these domains?" WITHOUT
 * exposing cookie values or names — only per-domain presence booleans. Intended
 * for an orchestrator (e.g. a Scheduler) to project login-state into its own
 * store without reaching into the engine's on-disk storage-state format or
 * handling raw secrets.
 *
 * This is a *possession* signal, not proof of *authorization*: cookies can be
 * expired or server-invalidated. Callers should treat a positive result as a
 * hint (skip the login step) and confirm real auth via an actual interaction.
 */

import fs from 'node:fs/promises';
import { getUserPersistencePaths } from './persistence.js';

function normalizeHost(host) {
  return String(host || '')
    .trim()
    .toLowerCase()
    .replace(/^\./, '');
}

/**
 * Mirror of the ADR §20 domain match: a cookie host covers a requested domain
 * when it is the domain itself or a subdomain of it.
 */
function domainMatches(cookieHost, domain) {
  const h = normalizeHost(cookieHost);
  const d = normalizeHost(domain);
  if (!h || !d) return false;
  return h === d || h.endsWith('.' + d);
}

/**
 * A cookie counts as live when it has no expiry, is a session cookie
 * (expires === -1), or its expiry (Playwright seconds-since-epoch) is in the
 * future relative to nowSec.
 */
function isLiveCookie(cookie, nowSec) {
  const exp = cookie?.expires;
  if (exp === undefined || exp === null) return true;
  if (exp === -1) return true;
  return exp > nowSec;
}

/**
 * Summarize saved-login presence for a userId.
 *
 * @param {object} args
 * @param {string} args.profileDir - persistence root
 * @param {string} args.userId
 * @param {string[]} [args.domains] - platform domains to check (e.g. ['x.com'])
 * @param {number} [args.now] - ms epoch (default Date.now())
 * @param {boolean} [args.ignoreExpired] - skip expired cookies (default true)
 * @returns {Promise<{hasStorageState: boolean, hasSavedLogin: boolean, domains: Record<string, boolean>}>}
 */
async function summarizeAuthState({
  profileDir,
  userId,
  domains = [],
  now = Date.now(),
  ignoreExpired = true,
}) {
  const wanted = (Array.isArray(domains) ? domains : []).map(normalizeHost).filter(Boolean);
  const result = {
    hasStorageState: false,
    hasSavedLogin: false,
    domains: Object.fromEntries(wanted.map((d) => [d, false])),
  };

  if (!profileDir) return result;

  const { storageStatePath } = getUserPersistencePaths(profileDir, userId);

  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(storageStatePath, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return result;
    throw err;
  }
  if (!parsed || !Array.isArray(parsed.cookies)) return result;
  result.hasStorageState = true;

  const nowSec = Math.floor(now / 1000);
  const liveCookies = parsed.cookies.filter((c) => !ignoreExpired || isLiveCookie(c, nowSec));

  for (const cookie of liveCookies) {
    for (const d of wanted) {
      if (!result.domains[d] && domainMatches(cookie.domain, d)) {
        result.domains[d] = true;
      }
    }
  }

  result.hasSavedLogin =
    wanted.length > 0 ? Object.values(result.domains).some(Boolean) : liveCookies.length > 0;

  return result;
}

export { summarizeAuthState, domainMatches, normalizeHost, isLiveCookie };
