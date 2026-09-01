/**
 * Tool-argument logging redaction/truncation (FIXES.md #7).
 *
 * Debugging an agent is blind when the logs show `evaluate` + resultType but not
 * the expression it ran. Logging the expression is opt-in (CAMOFOX_LOG_TOOL_ARGS)
 * because it can embed secrets; this masks obvious secret-ish key/value pairs and
 * caps the length before the value ever reaches a log line.
 */

// Quoted secret values: password: "hunter2" -> password: "***"
const SECRET_KEYS =
  'pass(?:word|wd)?|secret|token|api[_-]?key|apikey|authorization|bearer|cookie|session[_-]?key|access[_-]?key|private[_-]?key';
const QUOTED_SECRET = new RegExp(
  `((?:${SECRET_KEYS})["']?\\s*[:=]\\s*)(["'\`])(?:\\\\.|[^"'\`\\\\]){3,}?\\2`,
  'gi',
);
// Unquoted secret values: api_key=sk_live_123 -> api_key=***
const UNQUOTED_SECRET = new RegExp(
  `((?:${SECRET_KEYS})\\s*[:=]\\s*)[^\\s"'\`,;)}{]{4,}`,
  'gi',
);

export function redactSecrets(input) {
  return String(input)
    .replace(QUOTED_SECRET, (_m, prefix, quote) => `${prefix}${quote}***${quote}`)
    .replace(UNQUOTED_SECRET, (_m, prefix) => `${prefix}***`);
}

/**
 * Redact secrets, then cap the string to maxBytes (UTF-8 safe) with a marker.
 * @param {string} value
 * @param {number} maxBytes
 */
export function redactToolArg(value, maxBytes = 512) {
  const redacted = redactSecrets(value);
  const total = Buffer.byteLength(redacted, 'utf8');
  if (total <= maxBytes) return redacted;
  const head = Buffer.from(redacted, 'utf8')
    .subarray(0, maxBytes)
    .toString('utf8')
    .replace(/�+$/, '');
  return `${head}…[+${total - Buffer.byteLength(head, 'utf8')}B]`;
}
