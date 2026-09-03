/**
 * Default virtual-display resolution parsing (fork change #5).
 *
 * camoufox-js's base Xvfb is 1x1; the server already overrides it to a real
 * 1280x720 so viewport-dependent rendering/screenshots aren't degenerate. But
 * that was hardcoded, so a headless run (1280x720) and a VNC-watched run
 * (1920x1080) were different environments -- you couldn't cleanly compare their
 * screenshots. Making the default configurable lets an operator align the two.
 *
 * Accepts "WxH" or "WxHxDepth" (depth defaults to 24). Returns a normalized
 * "WxHxDepth" string, or null when the input is missing/malformed (caller falls
 * back to the built-in default).
 */
export function normalizeDisplayResolution(value) {
  if (value == null) return null;
  const s = String(value).trim().toLowerCase();
  const m = s.match(/^(\d{2,5})x(\d{2,5})(?:x(\d{1,2}))?$/);
  if (!m) return null;
  const width = parseInt(m[1], 10);
  const height = parseInt(m[2], 10);
  const depth = m[3] ? parseInt(m[3], 10) : 24;
  if (width < 1 || height < 1 || depth < 1) return null;
  return `${width}x${height}x${depth}`;
}

export const DEFAULT_DISPLAY_RESOLUTION = '1280x720x24';
