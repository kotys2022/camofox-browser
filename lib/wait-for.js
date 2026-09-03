/**
 * Readiness contract for navigate / create_tab (fork change #4).
 *
 * `networkidle` frequently never settles on these SPAs, so every caller
 * reinvents readiness with manual polling. A `waitFor` option lets the caller
 * declare the actual ready condition and have the server block until it holds
 * (or a fallback timeout elapses), returning whether it matched.
 *
 * Exactly one of:
 *   selector        wait until a CSS selector is visible
 *   text            wait until the page text contains this string
 *   networkQuietMs  wait until no network request for this many ms
 * plus optional timeoutMs (default 15000, capped 60000) as the fallback bound.
 *
 * This module validates/normalizes the spec (pure, unit-tested); the page-driving
 * side lives in server.js (applyWaitFor).
 */

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 60000;

export function normalizeWaitFor(input) {
  if (input == null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('waitFor must be an object like {selector|text|networkQuietMs, timeoutMs?}');
  }

  const { selector, text, networkQuietMs, timeoutMs } = input;
  const chosen = ['selector', 'text', 'networkQuietMs'].filter((k) => input[k] != null);
  if (chosen.length === 0) {
    throw new Error('waitFor requires one of: selector, text, networkQuietMs');
  }
  if (chosen.length > 1) {
    throw new Error(`waitFor accepts exactly one of selector/text/networkQuietMs (got ${chosen.join(', ')})`);
  }

  const spec = {};
  if (selector != null) {
    if (typeof selector !== 'string' || selector === '') {
      throw new Error('waitFor.selector must be a non-empty string');
    }
    spec.selector = selector;
  } else if (text != null) {
    if (typeof text !== 'string' || text === '') {
      throw new Error('waitFor.text must be a non-empty string');
    }
    spec.text = text;
  } else {
    if (!Number.isInteger(networkQuietMs) || networkQuietMs <= 0) {
      throw new Error('waitFor.networkQuietMs must be a positive integer');
    }
    spec.networkQuietMs = networkQuietMs;
  }

  let t = timeoutMs;
  if (t != null) {
    if (!Number.isInteger(t) || t <= 0) {
      throw new Error('waitFor.timeoutMs must be a positive integer');
    }
  } else {
    t = DEFAULT_TIMEOUT_MS;
  }
  spec.timeoutMs = Math.min(t, MAX_TIMEOUT_MS);
  return spec;
}
