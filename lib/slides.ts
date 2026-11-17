/**
 * Pagination for Markdown decks.
 *
 * The convention is Marp-compatible, because it is the one people already
 * write and it needs no new syntax:
 *
 *   ---
 *   marp: true          # or `paginate: true` / `slides: true`
 *   theme: default
 *   ---
 *
 *   # Slide one
 *   ---
 *   # Slide two
 *
 * `---` at the start of a line separates slides; `---` inside a fenced code
 * block does not. Horizontal rules in slide decks are `***` or `___`, which is
 * Marp's rule too.
 *
 * A slide is a source line range, so pagination and anchoring are the same
 * mechanism: navigating a deck moves the cursor, and "the slide" is a valid
 * anchor.
 */

import type { SourceDoc } from "./source.ts";

/** Slide metadata carried into an annotation, for the agent's benefit. */
export interface SlideContext {
  number: number;
  total: number;
  title: string;
  /** True when the whole slide was targeted rather than part of it. */
  whole: boolean;
}

export interface Slide {
  /** 1-based slide number, matching what the header shows. */
  number: number;
  /** 0-based inclusive source line range, blank padding trimmed off. */
  start: number;
  end: number;
  /** First heading, or the first non-empty line, for the header. */
  title: string;
}

export interface Deck {
  slides: Slide[];
  /** Frontmatter opted into pagination (`marp`, `paginate`, `slides`, `deck`). */
  enabled: boolean;
  marp: boolean;
  theme: string | null;
  frontmatter: { start: number; end: number } | null;
}

const FENCE_RE = /^\s*(```|~~~)/;
const HEADING_RE = /^\s{0,3}#{1,6}\s+(.*)$/;
const HR_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const COMMENT_RE = /<!--[\s\S]*?-->/g;

function frontmatterEnd(lines: string[]): number {
  if (lines.length === 0 || lines[0].trim() !== "---") return -1;
  for (let i = 1; i < lines.length; i++) if (lines[i].trim() === "---") return i;
  return -1;
}

function blank(line: string | undefined): boolean {
  return line === undefined || line.trim() === "";
}

function trimRange(lines: string[], from: number, to: number): [number, number] {
  let start = from;
  let end = to;
  while (start <= end && blank(lines[start])) start++;
  while (end >= start && blank(lines[end])) end--;
  return [start, end];
}

function titleOf(lines: string[], start: number, end: number): string {
  for (let i = start; i <= end; i++) {
    const heading = HEADING_RE.exec(lines[i] ?? "");
    if (heading) return clean(heading[1]);
  }
  for (let i = start; i <= end; i++) {
    const line = (lines[i] ?? "").trim();
    if (!line || line.startsWith("<!--")) continue;
    return clean(line.replace(/^([-*+>]|\d+[.)])\s+/, ""));
  }
  return "(empty slide)";
}

function clean(text: string): string {
  const flat = text
    .replace(/[*_`~]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim();
  return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat || "(untitled)";
}

export function parseDeck(doc: SourceDoc): Deck {
  const lines = doc.lines;
  const fmEnd = frontmatterEnd(lines);
  const frontmatter = fmEnd === -1 ? null : { start: 0, end: fmEnd };
  const fmText = fmEnd === -1 ? "" : lines.slice(1, fmEnd).join("\n");

  const marp = /^\s*marp\s*:\s*true\s*$/im.test(fmText);
  const enabled =
    marp || /^\s*(paginate|slides|deck|marpit)\s*:\s*true\s*$/im.test(fmText);
  const themeMatch = /^\s*theme\s*:\s*([^\s'"#]+|'[^']*'|"[^"]*")\s*$/im.exec(fmText);

  const separators: number[] = [];
  let inFence = false;
  for (let i = fmEnd === -1 ? 0 : fmEnd + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line.trim() === "---") separators.push(i);
  }

  const ranges: [number, number][] = [];
  let cursor = fmEnd === -1 ? 0 : fmEnd + 1;
  for (const separator of separators) {
    ranges.push([cursor, separator - 1]);
    cursor = separator + 1;
  }
  ranges.push([cursor, lines.length - 1]);

  const slides: Slide[] = [];
  for (const [from, to] of ranges) {
    const [start, end] = trimRange(lines, from, to);
    if (start > end) continue;
    slides.push({ number: slides.length + 1, start, end, title: titleOf(lines, start, end) });
  }

  return {
    slides,
    enabled,
    marp,
    theme: themeMatch ? themeMatch[1].replace(/^['"]|['"]$/g, "") : null,
    frontmatter,
  };
}

/** The slide containing `line`, or the nearest one before it. */
export function slideAt(deck: Deck, line: number): Slide | null {
  if (deck.slides.length === 0) return null;
  let candidate = deck.slides[0];
  for (const slide of deck.slides) {
    if (slide.start > line) break;
    candidate = slide;
  }
  return candidate;
}

export function slideSource(doc: SourceDoc, slide: Slide): string {
  return doc.lines
    .slice(slide.start, slide.end + 1)
    .join("\n")
    // Marp directives and speaker notes are comments: invisible when presented.
    .replace(COMMENT_RE, "")
    .trim();
}

export function isHorizontalRule(line: string): boolean {
  return HR_RE.test(line);
}
