/**
 * Link scheme allow-list.
 *
 * A port of apps/rapid-mac/Sources/Rapid/UI/Markdown/ChatLinkSafetyFilter.swift
 * (security finding #304): default-deny, with exactly `http`, `https` and
 * `mailto` permitted. Everything else — `file:`, `javascript:`, `data:`,
 * `vscode:`, `raycast:` — renders as text with a dead click.
 *
 * `javascript:` is the case worth naming, because the old page's comment
 * called it out directly (index.html:1229-1232): HTML escaping does not touch
 * a URL scheme, so `javascript:` survives escaping intact and lands in an
 * `href` unchanged. In this design it cannot reach an `href` at all — React
 * only sets what we compute, and for a rejected scheme we compute null.
 */

const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/**
 * The href to use, or null if the link must be rendered inert.
 *
 * Parsing through `URL` rather than pattern-matching the string is what makes
 * this robust: the constructor normalises first, so whitespace- and
 * control-character-obfuscated schemes (`java\tscript:`), case variants
 * (`JaVaScRiPt:`) and protocol-relative URLs (`//evil.example`) all resolve to
 * their real protocol before the comparison happens.
 */
export function safeHref(raw: string, base: string = window.location.origin): string | null {
  // An empty target — `[text]()` — resolves to the page's own URL, which
  // would render as a live link that silently reloads the app and loses the
  // draft. It is not a link the model meant to make.
  if (raw.trim() === '') return null;

  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }
  return ALLOWED_SCHEMES.has(url.protocol) ? url.href : null;
}

/**
 * Images are narrower still: the CSP is `img-src 'self' data:`, so a remote
 * host would be blocked by the browser anyway and would render as a broken
 * image rather than as the alt text. Only same-origin and inline data URLs
 * can actually load, and a `data:` URL must be an image — `data:text/html`
 * is a document, not a picture.
 */
export function safeImageSrc(raw: string, base: string = window.location.origin): string | null {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }

  if (url.protocol === 'data:') {
    return url.href.startsWith('data:image/') ? url.href : null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  // Same-origin only, per the CSP. A remote URL that the browser will refuse
  // is worse than no image: it renders as a broken-image glyph instead of the
  // alt text that describes what the model meant.
  return url.origin === base ? url.href : null;
}
