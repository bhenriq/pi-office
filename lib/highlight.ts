/**
 * Cheap, width-preserving syntax styling.
 *
 * Only ever replaces visible characters with styled visible characters — no
 * character is added, removed, or moved — so line numbers, selection widths,
 * and column math stay correct. Anything fancier belongs to pretty mode.
 */

import type { SourceDoc } from "./source.ts";

export interface StyleTheme {
  fg(token: string, text: string): string;
  bg(token: string, text: string): string;
  bold(text: string): string;
}

const HEADING_RE = /^(\s{0,3})(#{1,6})(\s+)(.*)$/;
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)/;
const QUOTE_RE = /^(\s*)(>+)(\s?)/;
const FENCE_RE = /^\s*(```|~~~)/;
const RULE_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TAG_RE = /<[/!?]?[a-zA-Z][^>]*>/g;

const DECORATIONS: Record<SourceDoc["kind"], (line: string, theme: StyleTheme) => string> = {
  markdown(line, theme) {
    // `---` is a slide break in a deck and a rule otherwise; dim either way.
    if (FENCE_RE.test(line) || RULE_RE.test(line)) return theme.fg("dim", line);

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const [, indent, hashes, space, rest] = heading;
      return theme.fg("dim", indent + hashes) + space + theme.bold(theme.fg("accent", rest));
    }

    const quote = QUOTE_RE.exec(line);
    if (quote) {
      const [, indent, marks, space] = quote;
      return theme.fg("borderMuted", indent + marks) + space + theme.fg("muted", line.slice(indent.length + marks.length + space.length));
    }

    const list = LIST_RE.exec(line);
    if (list) {
      const [, indent, marker, space] = list;
      return theme.fg("accent", indent + marker) + space + line.slice(indent.length + marker.length + space.length);
    }

    return line;
  },

  html(line, theme) {
    return line.replace(TAG_RE, (tag) => theme.fg("dim", tag));
  },

  text(line) {
    return line;
  },
};

export function styleSourceLine(line: string, kind: SourceDoc["kind"], theme: StyleTheme): string {
  return DECORATIONS[kind](line, theme);
}
