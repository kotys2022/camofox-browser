/**
 * Keep-warm decision logic (FIXES.md #8).
 *
 * The browser is a singleton per container, pre-warmed at startup but idle-closed
 * after BROWSER_IDLE_TIMEOUT_MS with no sessions -- so a batch of runs spaced
 * further apart than the idle window pays a ~10s cold start each time. Setting
 * BROWSER_IDLE_TIMEOUT_MS=0 enables keep-warm: never idle-close, and proactively
 * re-warm after an unexpected close so the next request isn't cold.
 *
 * (A multi-container pool is orchestration external to the engine — the browser is
 * a singleton per container; this is only the per-container keep-warm half.)
 */

/** Keep-warm is on when the idle timeout is disabled (<= 0). */
export function isKeepWarm(browserIdleTimeoutMs) {
  return Number.isFinite(browserIdleTimeoutMs) && browserIdleTimeoutMs <= 0;
}

/**
 * Whether to proactively re-warm the browser after it closed. Only in keep-warm
 * mode, and never for deliberate stops (server shutdown, admin stop, or an idle
 * shutdown that shouldn't occur under keep-warm anyway).
 * @param {string} reason - closeBrowserFully reason
 * @param {boolean} keepWarm
 */
export function shouldRewarmAfterClose(reason, keepWarm) {
  if (!keepWarm) return false;
  const r = String(reason || '');
  if (r.startsWith('shutdown')) return false;
  if (r === 'admin_stop') return false;
  if (r === 'idle_shutdown') return false;
  return true;
}
