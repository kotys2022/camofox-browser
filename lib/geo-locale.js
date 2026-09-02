/**
 * Country -> primary locale, for proxy-coherent fingerprint generation
 * (FIXES.md #0).
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
 * proxy exit-IP is expected to match (draw the proxy geo first, then the fingerprint).
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

/**
 * Overwrite ONLY the locale fields (`navigator.language` / `navigator.languages`)
 * of a Browserforge fingerprint, in place, leaving every identifying field
 * untouched. Lets a *persisted* identity keep its language coherent with the
 * current proxy country when a profile is re-homed to a new geo, without
 * regenerating (and thus losing) the fingerprint. Locale is geo-context, like
 * timezone -- not part of the stable identity.
 *
 * geoip already makes timezone/geolocation/webrtc follow the exit IP each launch;
 * this covers `navigator.language`, the one field geoip does not touch.
 *
 * @param {object} fingerprint - Browserforge fingerprint (mutated in place).
 * @param {string|null} locale - BCP-47 locale ("de-DE"); no-op when falsy.
 * @returns {{changed: boolean, from?: string, to?: string}}
 */
export function applyLocaleToFingerprint(fingerprint, locale) {
  const nav = fingerprint?.navigator;
  if (!locale || !nav || typeof nav !== 'object') return { changed: false };
  if (nav.language === locale) return { changed: false, from: nav.language, to: locale };
  const from = nav.language;
  nav.language = locale;
  nav.languages = [locale];
  return { changed: true, from, to: locale };
}
