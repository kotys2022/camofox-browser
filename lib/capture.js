/**
 * URL matcher for the capture-response tool (FIXES.md #3).
 *
 * Agents otherwise hand-write `fetch(url).then(r => r.json())` inside evaluate to
 * read a page's data XHR, which is brittle (anonymous endpoints throw CORS/500,
 * the response may already have fired, cookies/headers differ). Capturing the
 * real in-page response instead is more reliable; this builds the URL predicate.
 *
 * Pattern forms:
 *   "/exclusive"        substring match (default) -- matches any URL containing it
 *   "/\\/api\\/v0\\//"  a /regex/ -- compiled as a RegExp against the full URL
 */
export function buildUrlMatcher(pattern) {
  if (typeof pattern !== 'string' || pattern === '') {
    throw new Error('urlPattern must be a non-empty string');
  }
  if (pattern.length >= 2 && pattern.startsWith('/') && pattern.endsWith('/')) {
    const re = new RegExp(pattern.slice(1, -1));
    return (url) => typeof url === 'string' && re.test(url);
  }
  return (url) => typeof url === 'string' && url.includes(pattern);
}
