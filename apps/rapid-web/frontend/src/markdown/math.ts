import temml from 'temml';

/**
 * LaTeX to MathML, via Temml.
 *
 * WHY TEMML AND NOT KATEX. KaTeX's default HTML output needs roughly 1 MB of
 * woff2 across ~60 files; data-URI'd into a single-file bundle that is ~1.3 MB
 * of base64, several times the rest of the app, re-sent on every page load
 * over a tunnel. KaTeX with `output: 'mathml'` drops the fonts but keeps the
 * JS — measured at 271 KB, including an HTML builder and font-metrics tables
 * that would go unused. Temml is MathML-only by design: no HTML builder, no
 * metrics table, and no required font (its optional 15 KB Temml.woff2 is not
 * shipped). Measured at 212 KB — well over the 120 KB this was planned at, but
 * still the smaller of the two, and the browser's own math font does the
 * rendering.
 *
 * MathML Core has shipped in Safari since 14.1 and Chrome since 109, and the
 * audience here is overwhelmingly iOS Safari. `probeMathMLSupport` covers the
 * rest.
 *
 * THE ONE `dangerouslySetInnerHTML` IN THE APP. Everything else in the
 * markdown pipeline produces React elements from tokens, so this is the single
 * place markup is injected as a string, and the only XSS surface. It is
 * covered by dedicated fixtures, and any Temml version bump must re-run them.
 */

const OPTIONS = {
  /**
   * Disables `\href` and `\includegraphics`. With trust enabled a model could
   * emit a link inside a formula and Temml would render it as a real anchor,
   * bypassing the scheme allow-list that governs every other link on the page.
   */
  trust: false,
  /**
   * Render a bad command in red rather than throwing. A malformed formula
   * must not take out the block around it — the reader is never left with a
   * hole where an answer was.
   */
  throwOnError: false,
  strict: false,
} as const;

/**
 * A bounded memo.
 *
 * Switching branches remounts a settled transcript, which would otherwise re-run
 * Temml over every formula in it. Bounded because an unbounded cache over a
 * long session is a leak, and the working set here is one transcript.
 */
const CACHE_LIMIT = 200;
const cache = new Map<string, string>();

export function renderMath(latex: string, display: boolean): string {
  const key = `${display ? 'd' : 'i'}:${latex}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  let markup: string;
  try {
    markup = temml.renderToString(latex, { ...OPTIONS, displayMode: display });
  } catch {
    // `throwOnError: false` covers LaTeX errors; this covers Temml itself
    // failing. Falling back to the source is honest and still readable.
    markup = '';
  }

  if (cache.size >= CACHE_LIMIT) {
    // Evict the oldest. Map preserves insertion order, so the first key is it.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, markup);
  return markup;
}

/**
 * Does this browser actually render MathML?
 *
 * An old Android WebView parses MathML but lays it out as flattened text, so a
 * fraction renders as "12" rather than as one over two. That is not a crash,
 * it is worse: it is silently wrong output that looks like the model's fault.
 *
 * The probe renders a fraction off-screen and compares its height to a plain
 * identifier. Real MathML layout makes the fraction taller; a browser that
 * flattens it makes them equal.
 */
export function probeMathMLSupport(): boolean {
  if (typeof document === 'undefined') return false;

  const host = document.createElement('div');
  host.style.position = 'absolute';
  host.style.visibility = 'hidden';
  host.style.left = '-9999px';
  host.innerHTML = '<math><mfrac><mn>1</mn><mn>2</mn></mfrac></math><math><mn>1</mn></math>';

  document.body.appendChild(host);
  try {
    const [fraction, plain] = Array.from(host.querySelectorAll('math'));
    if (!fraction || !plain) return false;
    return fraction.getBoundingClientRect().height > plain.getBoundingClientRect().height;
  } finally {
    host.remove();
  }
}
