/**
 * Loading and addressing a text artifact.
 *
 * The file on disk is the single source of truth. Everything the viewer shows,
 * every anchor it produces, and every revision it compares is derived from the
 * raw bytes read here — never from a copy kept elsewhere.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

export type DocKind = "markdown" | "html" | "text";

export interface SourceDoc {
  path: string;
  name: string;
  /** Full file contents, byte-for-byte as read. */
  raw: string;
  /** Raw split on "\n" (a trailing newline yields a final empty entry). */
  lines: string[];
  /** Byte offset at which each line starts. `lineStarts.length === lines.length`. */
  lineStarts: number[];
  /** Short content hash; changes whenever the file changes. */
  rev: string;
  kind: DocKind;
}

const MARKDOWN_RE = /\.(md|markdown|mdown|mkd|mdx)$/i;
const HTML_RE = /\.(html?|xhtml)$/i;

export function docKind(path: string): DocKind {
  if (MARKDOWN_RE.test(path)) return "markdown";
  if (HTML_RE.test(path)) return "html";
  return "text";
}

export function revOf(raw: string): string {
  return createHash("sha1").update(raw, "utf8").digest("hex").slice(0, 8);
}

export function makeDoc(path: string, raw: string): SourceDoc {
  const lines: string[] = [];
  const lineStarts: number[] = [0];
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw.charCodeAt(i) === 10) {
      // Strip a preceding CR so CRLF files display without stray control chars,
      // while lineStarts still point at the untransformed source.
      const end = i > start && raw.charCodeAt(i - 1) === 13 ? i - 1 : i;
      lines.push(raw.slice(start, end));
      start = i + 1;
      lineStarts.push(start);
    }
  }
  lines.push(raw.slice(start));

  return { path, name: basename(path), raw, lines, lineStarts, rev: revOf(raw), kind: docKind(path) };
}

export async function readDoc(path: string): Promise<SourceDoc> {
  return makeDoc(path, await readFile(path, "utf8"));
}

/**
 * Exact source text of an inclusive line range, including its original line
 * endings. Used both for the anchor text and for what we show the agent, so a
 * CRLF file produces a CRLF `old_string`.
 */
export function rawRange(doc: SourceDoc, start: number, end: number): string {
  const from = doc.lineStarts[start];
  const to = end + 1 < doc.lineStarts.length ? doc.lineStarts[end + 1] : doc.raw.length;
  if (from === undefined || to === undefined) return "";
  return doc.raw.slice(from, to).replace(/\r?\n$/, "");
}
