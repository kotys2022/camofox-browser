/**
 * Country -> primary locale, for proxy-coherent fingerprint generation
 * (FIXES.md #0 / SPEC-002 §5-6.1).
 *
 * A generated fingerprint's navigator.language is random (usually en-US) and does
 * NOT follow the proxy geo -- unlike timezone/locale/geolocation/webrtc, which
 * camoufox derives from the proxy exit-IP via geoip each launch. So a profile on
 * a DE proxy would report navigator.language=en-US with an Europe/Berlin timezone
 * -- an incoherent (soft) detection signal. Generating the fingerprint under the
 * proxy country's locale makes navigator.language / languages / Accept-Language
 * coherent from the start.
 *
 * Uses Node's built-in ICU (Intl.Locale likely-subtags) -- no network, no MaxMind
 * DB, deterministic. Country is the configured intent (PROXY_COUNTRY), which the
 * proxy exit-IP is expected to match (SPEC-002: proxy geo is drawn first).
 *
 * @param {string} country - ISO 3166-1 alpha-2 (e.g. "DE"); case-insensitive.
 * @returns {string|null} BCP-47 locale ("de-DE") or null when unresolvable.
 */
export function localeFromCountry(country) {
  if (typeof country !== 'string' || !/^[A-Za-z]{2}$/.test(country)) return null;
  try {
    const max = new Intl.Locale(`und-${country.toUpperCase()}`).maximize();
    if (!max.language || !max.region) return null;
    return `${max.language}-${max.region}`;
  } catch {
    return null;
  }
}
