/**
 * Anchors address source lines, never screen rows.
 *
 * A terminal lets the user select whole lines cheaply and unambiguously, which
 * is the one thing a browser canvas cannot express. Every anchor therefore
 * carries the exact source text it was made from, so staleness is a byte
 * comparison instead of a fuzzy search.
 */

import { rawRange, type SourceDoc } from "./source.ts";

export interface Anchor {
  /** 0-based, inclusive. */
  start: number;
  /** 0-based, inclusive. */
  end: number;
  /** Exact source text of `start..end`, as shown to the user when selected. */
  text: string;
  /** Revision the selection was made against. */
  rev: string;
}

export function makeAnchor(doc: SourceDoc, a: number, b: number): Anchor {
  const start = Math.max(0, Math.min(a, b));
  const end = Math.min(doc.lines.length - 1, Math.max(a, b));
  return { start, end, text: rawRange(doc, start, end), rev: doc.rev };
}

/** "lines 12–18" or "line 12" */
export function describeAnchor(anchor: Anchor): string {
  return anchor.start === anchor.end ? `line ${anchor.start + 1}` : `lines ${anchor.start + 1}–${anchor.end + 1}`;
}

export type AnchorState = "valid" | "shifted" | "gone";

/**
 * Check an anchor against the current document.
 *
 * - `valid`:    the same lines still hold the same text.
 * - `shifted`:  the text is intact but at a different offset (the agent edited
 *               above it); the caller can safely re-anchor to `start`.
 * - `gone`:     the selected text no longer exists verbatim; ask the user.
 */
export function checkAnchor(doc: SourceDoc, anchor: Anchor): { state: AnchorState; start?: number } {
  if (rawRange(doc, anchor.start, anchor.end) === anchor.text) return { state: "valid" };

  const first = anchor.text.split("\n")[0] ?? "";
  if (first) {
    for (let i = 0; i < doc.lines.length; i++) {
      if (doc.lines[i] !== first) continue;
      const end = i + (anchor.end - anchor.start);
      if (end < doc.lines.length && rawRange(doc, i, end) === anchor.text) return { state: "shifted", start: i };
    }
  }
  return { state: "gone" };
}
