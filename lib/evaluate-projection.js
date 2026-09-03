/**
 * Result shaping for POST /tabs/:tabId/evaluate (fork change #2).
 *
 * Agents routinely pull a huge JSON blob (e.g. a page's masked pageProps) via
 * evaluate, then re-send the whole thing into the model's context on every
 * subsequent turn -- inflating cost and latency. Two opt-in knobs cut this at
 * the source:
 *
 *   projection  jq-like path into the result ("a.b[0].c") -- return only that
 *               subtree instead of the whole object.
 *   maxBytes    hard cap on the serialized result; over the cap it's truncated
 *               to a preview string with a marker reporting the original size.
 *
 * Both are optional and composable (projection is applied first, then the cap).
 * With neither, the result is returned unchanged (backward compatible).
 */

/**
 * Walk a jq-like path into a value. Supports dot segments and [n] array indices
 * ("data.items[0].name" === "data.items.0.name").
 * @returns {{ matched: boolean, value: any }}
 */
export function projectResult(value, pathStr) {
  const segments = String(pathStr)
    .replace(/\[(\d+)\]/g, '.$1') // items[0] -> items.0
    .split('.')
    .filter((s) => s.length > 0);
  let cur = value;
  for (const seg of segments) {
    if (cur == null || typeof cur !== 'object' || !(seg in cur)) {
      return { matched: false, value: undefined };
    }
    cur = cur[seg];
  }
  return { matched: true, value: cur };
}

function serialize(v) {
  if (typeof v === 'string') return v;
  if (v === undefined) return 'undefined';
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Cap a value's serialized size. Strings are truncated as-is; other values are
 * JSON-serialized first. Truncation happens on a UTF-8 byte boundary (trailing
 * partial multibyte char is dropped) and appends a marker with the true size.
 * @returns {{ value: any, truncated: boolean, totalBytes: number, returnedBytes: number }}
 */
export function capResultBytes(value, maxBytes) {
  const serialized = serialize(value);
  const totalBytes = Buffer.byteLength(serialized, 'utf8');
  if (totalBytes <= maxBytes) {
    return { value, truncated: false, totalBytes, returnedBytes: totalBytes };
  }
  const slice = Buffer.from(serialized, 'utf8')
    .subarray(0, maxBytes)
    .toString('utf8')
    .replace(/�+$/, '');
  const returnedBytes = Buffer.byteLength(slice, 'utf8');
  const marker = `…[truncated ${totalBytes - returnedBytes} of ${totalBytes} bytes]`;
  return { value: slice + marker, truncated: true, totalBytes, returnedBytes };
}

/**
 * Apply projection then byte-cap to an evaluate result.
 * @param {any} result
 * @param {{ projection?: string, maxBytes?: number }} opts
 * @returns {{ result: any, meta: object }} meta carries {projection?, truncated?, bytes?}
 */
export function shapeEvaluateResult(result, { projection, maxBytes } = {}) {
  const meta = {};
  let value = result;

  if (projection != null && projection !== '') {
    const p = projectResult(value, projection);
    meta.projection = { path: String(projection), matched: p.matched };
    value = p.matched ? p.value : null;
  }

  if (Number.isFinite(maxBytes) && maxBytes > 0) {
    const capped = capResultBytes(value, maxBytes);
    if (capped.truncated) {
      value = capped.value;
      meta.truncated = true;
      meta.bytes = { returned: capped.returnedBytes, total: capped.totalBytes };
    }
  }

  return { result: value, meta };
}
