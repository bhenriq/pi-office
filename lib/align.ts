/**
 * Maps source lines to rendered rows, and back.
 *
 * Rendered Markdown loses the 1:1 relationship the source view relies on: one
 * source line can occupy three rows after wrapping, one row can hold two list
 * items, and syntax characters disappear entirely. So the two views cannot share
 * a cursor directly — they need a map.
 *
 * The map is built by walking both sides in document order and matching each
 * source line against the next rendered rows whose text still contains it. That
 * ordering assumption is what makes this cheap and reliable: rendered Markdown
 * never reorders content, so a forward scan cannot match the wrong paragraph.
 */

/** ANSI escape sequences (CSI, OSC, and the short two-byte forms). */
const ANSI_RE =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;

const LEADING_MARKER_RE = /^\s*(?:[-*+]|\d{1,3}[.)]|>+|#{1,6})\s+/;
/** Table borders and box drawing: structure the renderer redraws, not content. */
const BOX_RE = /[\u2500-\u257F|]/g;
const MAX_TOKEN = 28;
const SCAN_WINDOW = 400;

/**
 * Reduce a line to the text a reader would recognise: no ANSI, no list or
 * heading markers, no emphasis characters, single spaces, lower case.
 */
export function normalize(text: string): string {
  return text
    .replace(ANSI_RE, "")
    .replace(LEADING_MARKER_RE, "")
    .replace(/[*_`~]/g, "")
    .replace(BOX_RE, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export interface RowMap {
  /** Source line index → first rendered row that shows it. Non-decreasing. */
  toRow: number[];
  /** Rendered row index → source line that best accounts for it. Non-decreasing. */
  toLine: number[];
  rows: number;
}

/**
 * @param sourceLines  All source lines of the document.
 * @param from, to     0-based inclusive source range that `renderedRows` covers.
 * @param renderedRows Styled lines from the Markdown renderer.
 */
/** A token worth searching for: there is text in it, and enough of it. */
function tokenOf(line: string | undefined): string {
  const token = normalize(line ?? "").slice(0, MAX_TOKEN);
  return token.length >= 3 && /[a-z0-9]/.test(token) ? token : "";
}

function findRow(token: string, rows: string[], from: number): number {
  const limit = Math.min(rows.length, from + SCAN_WINDOW);
  for (let row = from; row < limit; row++) if (rows[row].includes(token)) return row;
  return -1;
}

/**
 * Reject a match when none of the following distinctive source lines also match
 * at or after it. Without this, a weak line (a rule, a directive) can latch onto
 * a similar-looking row far down the document and drag the whole map with it.
 *
 * Several candidates are tried, not just the next line: the following line is
 * often a comment or a directive that never renders anywhere.
 */
function consistent(
  sourceLines: string[],
  line: number,
  to: number,
  candidate: number,
  rows: string[],
): boolean {
  let checked = 0;
  for (let next = line + 1; next <= Math.min(to, line + 8) && checked < 3; next++) {
    const token = tokenOf(sourceLines[next]);
    if (!token) continue;
    checked++;
    if (findRow(token, rows, candidate) >= 0) return true;
  }
  return checked === 0;
}

export function buildRowMap(
  sourceLines: string[],
  from: number,
  to: number,
  renderedRows: string[],
): RowMap {
  const rows = renderedRows.map(normalize);
  const toRow = new Array<number>(sourceLines.length).fill(from);

  let scan = 0;
  let last = 0;
  /** Lines that actually matched a row, in order. Carried lines never invert. */
  const known: { row: number; line: number }[] = [];

  for (let line = from; line <= to && line < sourceLines.length; line++) {
    const token = tokenOf(sourceLines[line]);
    const candidate = token ? findRow(token, rows, scan) : -1;

    // Unmatched (a rule, a directive, an image, a table divider): keep the
    // previous row so the mapping stays monotonic instead of jumping backwards.
    if (candidate < 0 || !consistent(sourceLines, line, to, candidate, rows)) {
      toRow[line] = last;
      continue;
    }

    toRow[line] = candidate;
    known.push({ row: candidate, line });
    last = candidate;
    // Do not advance past the match: the next source line may live in the same
    // wrapped block and still match this row.
    scan = candidate;
  }

  // Only matched lines take part in the inverse. Carried lines point at a row
  // they do not own, so letting them win would drag the cursor far down the
  // document whenever a block spans several rows.
  const toLine = new Array<number>(renderedRows.length).fill(from);
  let current = from;
  let next = 0;
  for (let row = 0; row < renderedRows.length; row++) {
    while (next < known.length && known[next].row <= row) current = known[next++].line;
    toLine[row] = current;
  }

  return { toRow, toLine, rows: renderedRows.length };
}
