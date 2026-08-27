/**
 * The transcript's reading measure.
 *
 * Shared rather than repeated: the composer and the lifecycle band sit
 * directly under the transcript, so if these three drift apart the column
 * edges visibly misalign. 720px is the figure `Sidebar.tsx` already assumes
 * when it decides the 900px breakpoint (260px rail + 720px column).
 *
 * The full-width element stays full-width in each case — only its CONTENT is
 * constrained — so the composer's border and the scrollbar still run to the
 * window edge.
 */
export const READING_COLUMN = 'mx-auto w-full max-w-[720px]';
