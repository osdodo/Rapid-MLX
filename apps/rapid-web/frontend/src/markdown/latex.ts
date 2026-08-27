/**
 * Split assistant text into alternating markdown and LaTeX runs.
 *
 * A port of apps/rapid-mac/Sources/Rapid/UI/Markdown/LaTeXSegmenter.swift.
 *
 * DELIMITERS — matched against the KaTeX/MathJax defaults every model in the
 * wild emits:
 *
 *   $$ … $$   display math, may span lines
 *   $  …  $   inline math, SINGLE LINE ONLY, so a stray dollar in prose
 *             cannot swallow the rest of the reply into "math"
 *   \[ … \]   display math, bracket form
 *   \( … \)   inline math, bracket form
 *
 * The bracket forms are NOT optional extras. A dogfood run recorded in the
 * Swift original (LaTeXSegmenter.swift:26-39) had an instruction-tuned model
 * emit ONLY bracket delimiters for a plain word problem — no `$` anywhere.
 * Missing them is not cosmetic, because CommonMark's escape rule then eats
 * them: `\(`, `\)`, `\[` and `\]` all wrap ASCII punctuation, so they collapse
 * to bare parens and brackets, while `\frac` and `\times` (backslash + letter,
 * not a valid escape) survive verbatim. The reader is left looking at
 * `( P = \frac{47}{0.85} \approx 55.29 )` — delimiters silently stripped,
 * LaTeX left as source.
 *
 * Delimiter STYLE is not preserved: `\(x\)` and `$x$` both produce
 * `{ latex: 'x', display: false }`. The round-trip property holds up to that
 * normalisation.
 *
 * ANTI-CASES. Three of the Swift version's hardest ones are free here and
 * that is worth stating, because it is a real architectural win: this runs
 * AFTER `marked.lexer()`, on the inline content of text-bearing tokens only.
 * So math inside a fenced code block, inside a 4-space indented code block,
 * or inside inline backticks is STRUCTURALLY unreachable — those are `code`
 * and `codespan` tokens and the segmenter never sees them. The remaining
 * anti-cases are implemented and individually tested here:
 *
 *   \$          an escaped dollar stays literal and never opens a run
 *   \\( and \\[ an escaped backslash followed by a literal bracket does NOT
 *               open math
 *   unclosed    `Use \( to group` has no `\)`, so the opener stays literal
 *               rather than swallowing the rest of the reply. This is also
 *               the streaming case, mid-answer, on every single formula.
 *   bare $      `it costs $20 today` — one dollar, no closer
 *   currency    `$20 to $30` has TWO dollars on one line, so the bare-dollar
 *               guard misses it. Any `$` immediately followed by a DIGIT is
 *               rejected, mirroring the MathJax convention: a real opener
 *               starts with a control sequence, a variable letter or a
 *               bracket, never a bare digit.
 */

export type LaTeXSegment =
  { kind: 'markdown'; text: string } | { kind: 'math'; latex: string; display: boolean };

interface Opener {
  /** The literal that opens the run. */
  open: string;
  /** The literal that closes it. */
  close: string;
  display: boolean;
  /** Inline runs die at a newline; display runs may span lines. */
  singleLine: boolean;
}

/**
 * Order matters: `$$` must be tested before `$`, or every display opener is
 * mis-read as an empty inline run.
 */
const OPENERS: Opener[] = [
  { open: '$$', close: '$$', display: true, singleLine: false },
  { open: '\\[', close: '\\]', display: true, singleLine: false },
  { open: '\\(', close: '\\)', display: false, singleLine: true },
  { open: '$', close: '$', display: false, singleLine: true },
];

/**
 * Is the character at `index` escaped by an odd number of backslashes?
 *
 * Counting the run rather than checking one character is what distinguishes
 * `\$` (escaped, literal) from `\\$` (an escaped backslash, then a real
 * opener). Getting this wrong in either direction is visible: one way a
 * literal dollar opens math, the other way real math renders as source.
 */
function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

/**
 * Would a bare `$` here be currency rather than a math opener?
 *
 * `$20 to $30` is the case the single-dollar guard cannot catch, because
 * there genuinely are two dollars on the line.
 */
function looksLikeCurrency(text: string, index: number): boolean {
  const next = text[index + 1];
  return next !== undefined && next >= '0' && next <= '9';
}

/**
 * Skip a backtick-delimited inline code run starting at `index`.
 *
 * Returns the index just past the closing run, or -1 if this is not a code
 * span. Per CommonMark a run of N backticks closes on the next run of exactly
 * N, so the length has to be counted rather than assumed to be one.
 *
 * This anti-case was originally expected to be structural — segmentation runs
 * per block, so surely `codespan` tokens would already be separated out. They
 * are not: segmentation has to happen on the block's RAW source, because
 * marked's inline lexer shreds `\[` and `\,` into `escape` tokens and destroys
 * the formula before it can be recognised. Running before inline lexing means
 * inline code is back in scope and must be skipped explicitly. Fenced and
 * indented code remain structural — those are `code` tokens and never reach
 * this function.
 */
function skipCodeSpan(text: string, index: number): number {
  let openLength = 0;
  while (text[index + openLength] === '`') openLength += 1;
  if (openLength === 0) return -1;

  let cursor = index + openLength;
  while (cursor < text.length) {
    if (text[cursor] !== '`') {
      cursor += 1;
      continue;
    }
    let closeLength = 0;
    while (text[cursor + closeLength] === '`') closeLength += 1;
    if (closeLength === openLength) return cursor + closeLength;
    cursor += closeLength;
  }

  // Unclosed. Not a code span at all, so scanning resumes normally.
  return -1;
}

function findOpener(text: string, from: number): { at: number; opener: Opener } | null {
  let cursor = from;
  while (cursor < text.length) {
    const char = text[cursor];

    if (char === '`') {
      const past = skipCodeSpan(text, cursor);
      if (past !== -1) {
        cursor = past;
        continue;
      }
    }

    if (char !== '$' && char !== '\\') {
      cursor += 1;
      continue;
    }

    for (const opener of OPENERS) {
      if (!text.startsWith(opener.open, cursor)) continue;
      // `\[` and `\(` ARE backslash sequences, so "escaped" for them means a
      // preceding backslash — `\\[` is an escaped backslash plus a literal
      // bracket. `isEscaped` counts the run before the opener's first
      // character and answers both cases correctly.
      if (isEscaped(text, cursor)) continue;
      if (opener.open === '$' && looksLikeCurrency(text, cursor)) continue;
      return { at: cursor, opener };
    }

    cursor += 1;
  }
  return null;
}

/** The index of the closing delimiter, or -1 if the run never closes. */
function findClose(text: string, from: number, opener: Opener): number {
  for (let cursor = from; cursor < text.length; cursor += 1) {
    const char = text[cursor];

    // An inline run dies at a newline. Without this a single stray dollar
    // turns everything after it into one enormous formula.
    if (opener.singleLine && char === '\n') return -1;

    if (char !== '$' && char !== '\\') continue;
    if (!text.startsWith(opener.close, cursor)) continue;
    if (isEscaped(text, cursor)) continue;
    return cursor;
  }
  return -1;
}

/**
 * Split `input` into alternating segments.
 *
 * Concatenating the markdown bodies and re-wrapping the math bodies in their
 * delimiters reconstructs the input, up to the bracket-to-dollar
 * normalisation. That round-trip is the single most valuable property in this
 * module and is tested directly.
 */
export function segmentLaTeX(input: string): LaTeXSegment[] {
  if (input === '') return [];

  const segments: LaTeXSegment[] = [];
  let plainStart = 0;
  let cursor = 0;

  while (cursor < input.length) {
    const found = findOpener(input, cursor);
    if (!found) break;

    const bodyStart = found.at + found.opener.open.length;
    const closeAt = findClose(input, bodyStart, found.opener);

    if (closeAt === -1) {
      // Unclosed. The opener stays literal — this is the streaming case, on
      // every formula, for as long as the closer has not arrived. Resume
      // scanning after it so a later, complete run in the same text is still
      // found.
      cursor = bodyStart;
      continue;
    }

    const latex = input.slice(bodyStart, closeAt).trim();
    if (latex === '') {
      // `$$` with nothing between it is not math. Skip past the whole thing
      // rather than treating the closer as a fresh opener.
      cursor = closeAt + found.opener.close.length;
      continue;
    }

    if (found.at > plainStart) {
      segments.push({
        kind: 'markdown',
        text: input.slice(plainStart, found.at),
      });
    }
    segments.push({ kind: 'math', latex, display: found.opener.display });

    cursor = closeAt + found.opener.close.length;
    plainStart = cursor;
  }

  if (plainStart < input.length) {
    segments.push({ kind: 'markdown', text: input.slice(plainStart) });
  }

  return segments;
}

/** True when `input` contains no math at all — the common case, worth a
 *  cheap answer so the caller can skip building segments entirely. */
export function hasMath(input: string): boolean {
  return segmentLaTeX(input).some((segment) => segment.kind === 'math');
}
