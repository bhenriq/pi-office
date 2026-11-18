/**
 * The artifact viewer: a pi TUI component, not a renderer of its own.
 *
 * Three modes share one document and one cursor:
 *
 *   source       - the file line for line, with line numbers. 1:1 with the
 *                  source, so a selection is an exact line range the agent can
 *                  be handed as an `old_string`. This is the mode that produces
 *                  intents.
 *   pretty       - the same content rendered as Markdown, read-only, scrolled
 *                  like a pager. For reading prose, not for annotating.
 *   presentation - one Markdown *slide* at a time. Only offered when the file is
 *                  paginated (see `lib/slides.ts`). `]`/`[` change slides and,
 *                  because a slide is a line range, "the slide" works as an
 *                  anchor when nothing is selected.
 *
 * The component owns no file state beyond a snapshot: pi hands it a new
 * `SourceDoc` whenever the file changes on disk, and the viewer re-renders.
 */

import type { Component, EditorComponent, MarkdownTheme, TUI } from "@earendil-works/pi-tui";
import {
  Markdown,
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { buildRowMap, type RowMap } from "./align.ts";
import { describeAnchor, makeAnchor, type Anchor } from "./anchor.ts";
import { styleSourceLine, type StyleTheme } from "./highlight.ts";
import { parseDeck, slideAt, slideSource, type Deck, type Slide, type SlideContext } from "./slides.ts";
import type { SourceDoc } from "./source.ts";

export type { SlideContext };

export interface ViewerIntent {
  kind: "edit" | "explain" | "replace";
  instruction: string;
  anchor: Anchor;
  slide?: SlideContext;
  /** Text the selection should become, for kind === "replace". */
  replacement?: string;
}

export interface ViewerHistory {
  versions: string[];
  index: number;
}

export interface ViewerTheme extends StyleTheme {
  inverse(text: string): string;
}

export interface ViewerDeps {
  tui: Pick<TUI, "terminal" | "requestRender">;
  /** True when hosted as a full-screen overlay: use every row the terminal has. */
  fullscreen?: boolean;
  theme: ViewerTheme;
  markdownTheme: MarkdownTheme;
  history: ViewerHistory;
  onSubmit(intent: ViewerIntent): void;
  /** `y`: hand the text to the host, which owns the clipboard. */
  onCopy?(text: string, label: string): void;
  /**
   * Build the host's configured editor (pi-vim when installed, pi's own editor
   * otherwise) for composing `e`/`o`. Absent means the viewer can only offer its
   * single-line prompt.
   */
  createEditor?(): EditorComponent | null;
  onUndo(): void;
  onRedo(): void;
  onClose(): void;
}

/** One-key actions, applied to the selection, the slide, or the cursor line. */
const QUICK_ACTIONS: Record<string, { instruction: string; kind: "edit" | "explain" }> = {
  r: { instruction: "Remove this content, keeping the surrounding structure intact.", kind: "edit" },
  l: { instruction: "Say this more briefly, keeping the meaning.", kind: "edit" },
  m: { instruction: "Expand this with more detail, matching the surrounding voice.", kind: "edit" },
  x: { instruction: "Explain what this content says and why it is here.", kind: "explain" },
};

/** Shown by `h` / `?`. Grouped the way the work is, not the way the keys are. */
const HELP: { section: string; rows: [keys: string, description: string][] }[] = [
  {
    section: "read",
    rows: [
      ["j k ↓ ↑", "one line in source, one row when rendered"],
      ["ctrl+d ctrl+u", "half page"],
      ["ctrl+f ctrl+b", "page"],
      ["g G", "start / end"],
      ["w", "soft wrap long lines (on or off)"],
      ["p", "rendered form: whole file, or one slide in a deck"],
      ["h  ?", "this help"],
    ],
  },
  {
    section: "select and annotate",
    rows: [
      ["v", "start or clear a selection"],
      ["r l m", "remove / shorter / longer"],
      ["e", "rewrite the selection: replace it with text you compose"],
      ["o  enter", "other: describe the change in words"],
      ["ctrl+e", "switch e/o between the one-line prompt and pi's editor"],
      ["", "with a modal editor, esc first: enter submits from normal mode"],
      ["x", "explain, without changing the file"],
      ["y", "yank: copy the selection, line, slide, or visible rows"],
      ["u  ctrl+r", "undo / redo the file"],
      ["", ""],
      ["nothing selected", "r l m o x act on the whole slide; e edits the cursor line"],
    ],
  },
  {
    section: "slides",
    rows: [
      ["]  [", "jump to next / previous slide"],
      ["s", "force slide mode on or off"],
      ["in presentation:", "j k scroll, then advance"],
      ["esc", "presentation back to source"],
    ],
  },
];

/** How `e`/`o` compose. Remembered for the process, so it survives reopening. */
type ComposeMode = "prompt" | "editor";
let defaultComposeMode: ComposeMode = "prompt";

interface ActiveComposer {
  editor: EditorComponent;
  mode: "instruction" | "replace";
  anchor: Anchor;
  slide?: SlideContext;
  title: string;
}

const MIN_HEIGHT = 9;
const MAX_HEIGHT = 200;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** One screen row of the source view. A wrapped line spans several of them. */
interface DisplayRow {
  /** Source line this row belongs to. */
  line: number;
  /** Styled text of this row's segment. */
  text: string;
  /** True for the row that carries the line number and marker. */
  first: boolean;
}

function blankLine(width: number): string {
  return " ".repeat(Math.max(0, width));
}

export class ArtifactViewer implements Component {
  private deps: ViewerDeps;
  private theme: ViewerTheme;
  private doc: SourceDoc;

  private cursor = 0;
  private scrollTop = 0;
  /** Soft-wrap long source lines instead of truncating them. */
  private wrapped = false;
  /** Screen row the cursor occupied at the last source render. */
  private cursorScreenRow = 0;
  private displayCache: { key: string; rows: DisplayRow[]; firstRow: number[] } | null = null;
  private anchorLine: number | null = null;
  private pretty = false;
  private presenting = false;
  /** Pretty and presentation are pagers: they track an offset in rendered rows. */
  private prettyTop = 0;
  private prettyRows = 0;
  private prettyViewport = 1;
  private help = false;
  private helpTop = 0;
  private composeMode: ComposeMode = defaultComposeMode;
  private composer: ActiveComposer | null = null;
  private prompt: { text: string; pos: number; mode: "instruction" | "replace" } | null = null;
  private status: { text: string; tone: "info" | "error" } | null = null;
  private agentBusy = false;
  private agentLine = "";

  /**
   * Rows between the cursor's rendered row and the top of the pager view. Stored
   * after clamping, so the return trip lands on the exact row we came from even
   * when the entry point was clamped to the top.
   */
  private pagerOffset = 0;
  private lastWidth = 80;
  private lastBodyHeight = 10;
  private rowMapCache: { key: string; map: RowMap } | null = null;

  private deck: Deck;
  /** `s` forces slide mode for a deck-ish file without frontmatter. */
  private forcedDeck = false;
  private prettyRenderer: Markdown | null = null;
  private slideRenderer: Markdown | null = null;
  private slideRenderKey = "";

  private version = 0;
  private cache: string[] | null = null;
  private cacheWidth = -1;
  private cacheHeight = -1;
  private cacheVersion = -1;

  constructor(doc: SourceDoc, deps: ViewerDeps) {
    this.doc = doc;
    this.deps = deps;
    this.theme = deps.theme;
    this.deck = parseDeck(doc);
    // A deck opens on its first slide, not on the frontmatter.
    const first = this.isDeck ? this.deck.slides[0] : undefined;
    if (first) {
      this.cursor = first.start;
      this.scrollTop = first.start;
    }
  }

  // ---------------------------------------------------------------- state

  /** Replace the document snapshot after an external (agent or undo) write. */
  setDoc(doc: SourceDoc): void {
    const lastLine = doc.lines.length - 1;
    this.doc = doc;
    this.deck = parseDeck(doc);
    this.cursor = clamp(this.cursor, 0, lastLine);
    if (this.anchorLine !== null) this.anchorLine = clamp(this.anchorLine, 0, lastLine);
    this.prettyRenderer?.setText(doc.raw);
    this.rowMapCache = null;
    // A new revision can move slide boundaries; rebuild lazily.
    this.slideRenderer = null;
    this.slideRenderKey = "";
    this.touch();
  }

  setAgentState(busy: boolean, line = ""): void {
    this.agentBusy = busy;
    this.agentLine = line;
    this.touch();
  }

  setStatus(text: string | null, tone: "info" | "error" = "info"): void {
    this.status = text === null ? null : { text, tone };
    this.touch();
  }

  get docPath(): string {
    return this.doc.path;
  }

  /** Test hook: where the two views currently sit, for the alignment checks. */
  debugPosition(): {
    cursor: number;
    scrollTop: number;
    prettyTop: number;
    prettyRows: number;
    pretty: boolean;
    presenting: boolean;
    slide: number | null;
    composeMode: ComposeMode;
    composing: boolean;
  } {
    return {
      cursor: this.cursor,
      scrollTop: this.scrollTop,
      prettyTop: this.prettyTop,
      prettyRows: this.prettyRows,
      pretty: this.pretty,
      presenting: this.presenting,
      slide: this.activeSlide()?.number ?? null,
      composeMode: this.composeMode,
      composing: this.composer !== null,
    };
  }

  private get isDeck(): boolean {
    return (this.deck.enabled || this.forcedDeck) && this.deck.slides.length > 1;
  }

  private activeSlide(): Slide | null {
    return this.isDeck ? slideAt(this.deck, this.cursor) : null;
  }

  // -------------------------------------------------------------- render

  invalidate(): void {
    this.cache = null;
    this.cacheWidth = -1;
    this.cacheVersion = -1;
    this.displayCache = null;
    this.composer?.editor.invalidate();
    this.prettyRenderer?.invalidate();
    this.slideRenderer?.invalidate();
  }

  private touch(): void {
    this.version++;
    this.invalidate();
    this.deps.tui.requestRender();
  }

  render(width: number): string[] {
    const rows = this.deps.tui.terminal.rows || 24;
    // Inline, pi keeps five rows for its own chrome; as an overlay we own them.
    const height = this.deps.fullscreen ? clamp(rows, MIN_HEIGHT, MAX_HEIGHT) : clamp(rows - 5, MIN_HEIGHT, MAX_HEIGHT);

    if (this.cache && this.cacheWidth === width && this.cacheHeight === height && this.cacheVersion === this.version) {
      return this.cache;
    }

    const bodyHeight = height - 5;
    this.lastWidth = width;
    this.lastBodyHeight = bodyHeight;
    const body = this.composer
      ? this.renderComposer(width, bodyHeight)
      : this.help
      ? this.renderHelp(width, bodyHeight)
      : this.presenting
        ? this.renderSlide(width, bodyHeight)
        : this.pretty
          ? this.renderPretty(width, bodyHeight)
          : this.renderSource(width, bodyHeight);

    const lines = [
      this.renderHeader(width),
      this.renderRule(width),
      ...body,
      this.renderRule(width),
      this.renderFooter(width),
      this.renderStatusLine(width),
    ];

    this.cache = lines;
    this.cacheWidth = width;
    this.cacheHeight = height;
    this.cacheVersion = this.version;
    return lines;
  }

  private fit(text: string, width: number): string {
    return truncateToWidth(text, width, "…", true);
  }

  private renderRule(width: number): string {
    return this.theme.fg("borderMuted", "─".repeat(Math.max(0, width)));
  }

  private renderHeader(width: number): string {
    const th = this.theme;
    const name = th.bold(this.doc.name);
    const slide = this.activeSlide();
    const slideChip = slide ? th.fg("accent", ` · slide ${slide.number}/${this.deck.slides.length}`) : "";
    const meta = th.fg("dim", ` · ${this.doc.rev} · ${this.doc.lines.length} lines`);

    // Show the row offset only where it means something: always in pretty mode
    // (it is the only position feedback), in presentation only if the slide
    // actually scrolls.
    const scrolls = this.prettyRows > this.prettyViewport;
    const showRows = this.pretty || (this.presenting && scrolls);
    const position = showRows ? ` ${Math.min(this.prettyTop + 1, Math.max(1, this.prettyRows))}/${this.prettyRows}` : "";
    const sourceLabel = this.wrapped ? "SOURCE·WRAP" : "SOURCE";
    const label = this.composer
      ? this.composer.mode === "replace" ? "COMPOSE·REPLACE" : "COMPOSE·OTHER"
      : this.help ? "HELP"
      : this.presenting ? "SLIDE"
      : this.pretty ? "PRETTY"
      : sourceLabel;
    const mode = th.fg(this.help || this.presenting || this.pretty ? "accent" : "muted", `${label}${position}`);
    const undo = `${this.deps.history.index + 1}/${this.deps.history.versions.length}`;
    const right = th.fg("dim", `${mode}${th.fg("dim", " · ")}${undo} `);

    const left = ` ${name}${meta}${slideChip}`;
    const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
    return this.fit(left + " ".repeat(gap) + right, width);
  }

  private renderFooter(width: number): string {
    const th = this.theme;
    const selection = this.selectionRange();
    const slide = this.activeSlide();

    if (this.composer) {
      const where = th.fg("accent", this.composer.title);
      // A modal editor submits from normal mode, so "enter" alone would mislead.
      const modal = /vim|modal/i.test(this.composer.editor.constructor?.name ?? "");
      const keys = modal
        ? "esc then enter submit · ctrl+c cancel · ctrl+e prompt"
        : "enter submit · ctrl+c cancel · ctrl+e prompt";
      return this.fit(` ${where}  ${th.fg("dim", keys)}`, width);
    }

    if (this.help) {
      return this.fit(th.fg("dim", " h ? esc · close help · j/k scroll"), width);
    }

    if (this.prompt) {
      const hint = this.prompt.mode === "replace" ? "enter apply · esc cancel · ctrl+u clear" : "enter send · esc cancel · ctrl+u clear";
      return this.fit(th.fg("dim", ` ${hint}`), width);
    }

    if (this.presenting && slide) {
      const where = th.fg("accent", `${slide.number}/${this.deck.slides.length} ${slide.title}`);
      const keys = "j/k scroll·next · ] [ jump · r l m e o slide · y yank · p source";
      return this.fit(` ${where}  ${th.fg("dim", keys)}`, width);
    }

    if (this.pretty) {
      return this.fit(th.fg("dim", " p source · j/k scroll · g/G ends · y yank · esc close"), width);
    }

    if (selection) {
      const [lo, hi] = selection;
      const where = describeAnchor(makeAnchor(this.doc, lo, hi));
      const inside = slide ? ` ${th.fg("dim", `(slide ${slide.number})`)}` : "";
      const keys = "r remove · l less · m more · e edit · o other · x explain · y yank · w wrap";
      return this.fit(` ${th.fg("accent", where)}${inside}  ${th.fg("dim", keys)}`, width);
    }

    if (slide) {
      const where = th.fg("accent", `slide ${slide.number}/${this.deck.slides.length}`);
      const keys = "r l m e o whole slide · v select · ] [ slide · p present · q close";
      return this.fit(` ${where}  ${th.fg("dim", keys)}`, width);
    }

    const keys = "v select · r l m e o x · y yank · w wrap · p pretty · h help · q close";
    return this.fit(` ${th.fg("dim", keys)}`, width);
  }

  private renderStatusLine(width: number): string {
    const th = this.theme;

    if (this.prompt) {
      const { text, pos } = this.prompt;
      let before = text.slice(0, pos);
      const cursorChar = text[pos] ?? " ";
      const after = text.slice(pos + 1);
      // Keep the cursor on screen for long instructions.
      const budget = Math.max(4, width - 6);
      while (visibleWidth(before) > budget) before = before.slice(1);
      const label = this.prompt.mode === "replace" ? "→" : "›";
      const line = ` ${th.fg("accent", label)} ${before}${th.inverse(cursorChar)}${after}`;
      return this.fit(line, width);
    }

    if (this.status) {
      const color = this.status.tone === "error" ? "error" : "success";
      return this.fit(` ${th.fg(color, this.status.text)}`, width);
    }

    if (this.agentBusy) {
      const detail = this.agentLine ? ` ${truncateToWidth(this.agentLine, Math.max(0, width - 20), "…")}` : "…";
      return this.fit(` ${th.fg("accent", "✦")} ${th.fg("dim", "agent working")}${th.fg("muted", detail)}`, width);
    }

    return this.fit("", width);
  }

  // --------------------------------------------------------- body modes

  private gutterWidth(): number {
    return Math.max(3, String(this.doc.lines.length).length);
  }

  private contentWidthFor(width: number): number {
    return Math.max(4, width - this.gutterWidth() - 2);
  }

  /**
   * Source lines laid out as screen rows. Unwrapped, one line is one row with
   * its overflow truncated at render time; wrapped, a line becomes as many rows
   * as it needs and the numbering only appears on the first.
   */
  private sourceRows(contentWidth: number): { rows: DisplayRow[]; firstRow: number[] } {
    const key = `${this.doc.rev}:${contentWidth}:${this.wrapped}`;
    if (this.displayCache?.key === key) return this.displayCache;

    const rows: DisplayRow[] = [];
    const firstRow = new Array<number>(this.doc.lines.length).fill(0);

    this.doc.lines.forEach((line, index) => {
      firstRow[index] = rows.length;
      const styled = styleSourceLine(line, this.doc.kind, this.theme);

      if (!this.wrapped) {
        rows.push({ line: index, text: styled, first: true });
        return;
      }

      const segments = wrapTextWithAnsi(styled, contentWidth);
      for (let i = 0; i < segments.length; i++) {
        rows.push({ line: index, text: segments[i], first: i === 0 });
      }
    });

    this.displayCache = { key, rows, firstRow };
    return this.displayCache;
  }

  private rowOfLine(line: number, contentWidth: number): number {
    const { firstRow } = this.sourceRows(contentWidth);
    return firstRow[clamp(line, 0, Math.max(0, firstRow.length - 1))] ?? 0;
  }

  private renderSource(width: number, bodyHeight: number): string[] {
    const th = this.theme;
    const gutter = this.gutterWidth();
    const contentWidth = this.contentWidthFor(width);

    this.cursor = clamp(this.cursor, 0, Math.max(0, this.doc.lines.length - 1));
    const { rows, firstRow } = this.sourceRows(contentWidth);

    const maxScroll = Math.max(0, rows.length - bodyHeight);
    const cursorRow = firstRow[this.cursor] ?? 0;
    if (cursorRow < this.scrollTop) this.scrollTop = cursorRow;
    if (cursorRow >= this.scrollTop + bodyHeight) this.scrollTop = cursorRow - bodyHeight + 1;
    this.scrollTop = clamp(this.scrollTop, 0, maxScroll);
    this.cursorScreenRow = clamp(cursorRow - this.scrollTop, 0, Math.max(0, bodyHeight - 1));

    const selection = this.selectionRange();
    const out: string[] = [];

    for (let offset = 0; offset < bodyHeight; offset++) {
      const display = rows[this.scrollTop + offset];
      if (!display) {
        out.push(blankLine(width));
        continue;
      }

      const isCursor = display.line === this.cursor;
      const selected = selection !== null && display.line >= selection[0] && display.line <= selection[1];

      const marker = isCursor && display.first ? th.fg("accent", "▸") : " ";
      const number = display.first ? String(display.line + 1).padStart(gutter) : " ".repeat(gutter);
      const gutterText = display.first
        ? th.fg(selected || isCursor ? "accent" : "dim", number)
        : number;

      // Selected rows drop syntax colors: the selection bar reads better as
      // plain text, and it keeps the background unbroken across the line.
      const text = selected ? stripTerminalSequences(display.text) : display.text;
      // Unwrapped rows still need truncating; wrapped ones already fit.
      const fitted = this.wrapped ? text : truncateToWidth(text, contentWidth, "…");
      const padded = fitted + " ".repeat(Math.max(0, contentWidth - visibleWidth(fitted)));

      let line = `${marker}${gutterText} ${padded}`;
      if (selected) line = th.bg("selectedBg", truncateToWidth(line, width, "…", true));
      out.push(truncateToWidth(line, width, "…", true));
    }

    return out;
  }

  private renderPretty(width: number, bodyHeight: number): string[] {
    const rendered = this.markdown().render(width);
    return this.renderPagedRows(rendered, width, bodyHeight);
  }

  /** While composing, the editor owns the body: it needs the room, vi especially. */
  private renderComposer(width: number, bodyHeight: number): string[] {
    const lines = this.composer?.editor.render(width) ?? [];
    // Long drafts scroll from the bottom: the cursor is where you are typing.
    const start = Math.max(0, lines.length - bodyHeight);
    const out: string[] = [];

    for (let row = 0; row < bodyHeight; row++) {
      const line = lines[start + row];
      out.push(line === undefined ? blankLine(width) : truncateToWidth(line, width, "…", true));
    }
    return out;
  }

  private renderHelp(width: number, bodyHeight: number): string[] {
    const th = this.theme;
    const keyWidth = Math.min(18, Math.max(...HELP.flatMap((g) => g.rows.map(([keys]) => keys.length)), 0));
    const rows: string[] = [];

    for (const group of HELP) {
      if (rows.length > 0) rows.push("");
      rows.push(th.bold(th.fg("accent", group.section)));
      for (const [keys, description] of group.rows) {
        if (!keys && !description) {
          rows.push("");
        } else if (!keys) {
          rows.push(`  ${th.fg("muted", description)}`);
        } else {
          rows.push(`  ${th.fg("text", keys.padEnd(keyWidth))}  ${th.fg("muted", description)}`);
        }
      }
    }

    const maxTop = Math.max(0, rows.length - bodyHeight);
    this.helpTop = clamp(this.helpTop, 0, maxTop);

    const out: string[] = [];
    for (let row = 0; row < bodyHeight; row++) {
      const line = rows[this.helpTop + row];
      out.push(line === undefined ? blankLine(width) : truncateToWidth(line, width, "…", true));
    }
    return out;
  }

  private renderSlide(width: number, bodyHeight: number): string[] {
    const slide = this.activeSlide();
    if (!slide) return Array.from({ length: bodyHeight }, () => blankLine(width));

    const key = `${this.doc.rev}:${slide.number}:${slide.start}:${slide.end}`;
    if (this.slideRenderKey !== key) {
      this.slideRenderKey = key;
      this.slideRenderer = null;
    }

    const renderer = this.slideMarkdown(slide);
    const rendered = renderer.render(width);
    return this.renderPagedRows(rendered, width, bodyHeight);
  }

  private renderPagedRows(rendered: string[], width: number, bodyHeight: number): string[] {
    this.prettyRows = rendered.length;
    this.prettyViewport = bodyHeight;
    this.prettyTop = clamp(this.prettyTop, 0, this.maxPrettyTop());

    const out: string[] = [];
    for (let row = 0; row < bodyHeight; row++) {
      const line = rendered[this.prettyTop + row];
      out.push(line === undefined ? blankLine(width) : truncateToWidth(line, width, "…", true));
    }
    return out;
  }

  private maxPrettyTop(): number {
    return Math.max(0, this.prettyRows - this.prettyViewport);
  }

  private scrollPretty(delta: number): void {
    this.prettyTop = clamp(this.prettyTop + delta, 0, this.maxPrettyTop());
    this.touch();
  }

  // ------------------------------------------------- mode transitions

  private rowMap(rows: string[], from: number, to: number): RowMap {
    const key = `${this.doc.rev}:${from}:${to}:${this.lastWidth}:${rows.length}`;
    if (this.rowMapCache?.key === key) return this.rowMapCache.map;
    const map = buildRowMap(this.doc.lines, from, to, rows);
    this.rowMapCache = { key, map };
    return map;
  }

  /** Where on screen the cursor sits now, so the other view can preserve it. */
  private captureAnchor(): number {
    return clamp(this.cursorScreenRow, 0, Math.max(0, this.lastBodyHeight - 1));
  }

  /** Scroll so that `line` sits `offset` rows below the top of the view. */
  private scrollToLine(line: number, offset: number): void {
    const row = this.rowOfLine(line, this.contentWidthFor(this.lastWidth));
    this.scrollTop = Math.max(0, row - offset);
  }

  private enterPretty(): void {
    this.pretty = true;
    this.presenting = false;

    const rows = this.markdown().render(this.lastWidth);
    if (rows.length === 0) {
      this.prettyTop = 0;
      this.pagerOffset = 0;
      return;
    }
    const row = this.rowMap(rows, 0, this.doc.lines.length - 1).toRow[this.cursor] ?? 0;
    this.prettyTop = clamp(row - this.captureAnchor(), 0, Math.max(0, rows.length - this.lastBodyHeight));
    this.pagerOffset = row - this.prettyTop;
  }

  private exitPretty(): void {
    this.pretty = false;
    const rows = this.markdown().render(this.lastWidth);
    if (rows.length === 0) return;

    const map = this.rowMap(rows, 0, this.doc.lines.length - 1);
    const row = clamp(this.prettyTop + this.pagerOffset, 0, rows.length - 1);
    const line = clamp(map.toLine[row] ?? this.cursor, 0, this.doc.lines.length - 1);
    this.cursor = line;
    this.scrollToLine(line, this.pagerOffset);
  }

  private enterPresentation(): void {
    const slide = this.activeSlide();
    if (!slide) return;
    this.presenting = true;
    this.pretty = false;

    const rows = this.slideMarkdown(slide).render(this.lastWidth);
    if (rows.length === 0) {
      this.prettyTop = 0;
      this.pagerOffset = 0;
      return;
    }
    // The cursor can sit on a separator outside the slide; clamp it in, or the
    // lookup reads a row the slide map never filled.
    const anchorLine = clamp(this.cursor, slide.start, slide.end);
    const row = this.rowMap(rows, slide.start, slide.end).toRow[anchorLine] ?? 0;
    this.prettyTop = clamp(row - this.captureAnchor(), 0, Math.max(0, rows.length - this.lastBodyHeight));
    this.pagerOffset = row - this.prettyTop;
  }

  private exitPresentation(): void {
    const slide = this.activeSlide();
    const rows = slide ? this.slideMarkdown(slide).render(this.lastWidth) : [];
    this.presenting = false;
    if (!slide || rows.length === 0) return;

    const map = this.rowMap(rows, slide.start, slide.end);
    // Land on the slide's first line when the view sits at its top, not just
    // wherever the previous cursor happened to be.
    const row = clamp(this.prettyTop + this.pagerOffset, 0, rows.length - 1);
    const line = clamp(map.toLine[row] ?? this.cursor, slide.start, slide.end);
    this.cursor = line;
    this.scrollToLine(line, this.pagerOffset);
  }

  private markdown(): Markdown {
    if (!this.prettyRenderer) {
      this.prettyRenderer = new Markdown(this.doc.raw, 1, 0, this.deps.markdownTheme);
    }
    return this.prettyRenderer;
  }

  private slideMarkdown(slide: Slide): Markdown {
    if (!this.slideRenderer) {
      this.slideRenderer = new Markdown(slideSource(this.doc, slide), 1, 1, this.deps.markdownTheme);
    }
    return this.slideRenderer;
  }

  // --------------------------------------------------------------- input

  handleInput(data: string): void {
    if (this.composer) {
      this.handleComposerKey(data);
      return;
    }

    if (this.prompt) {
      this.handlePromptKey(data);
      return;
    }

    if (matchesKey(data, "ctrl+e")) {
      this.closeComposer(this.composeMode === "editor" ? "prompt" : "editor");
      return;
    }

    // Help swallows everything: a stray key while reading must not edit a file.
    if (this.help) {
      this.handleHelpKey(data);
      return;
    }

    if (data === "h" || data === "?") {
      this.help = true;
      this.helpTop = 0;
      this.touch();
      return;
    }

    if (matchesKey(data, "escape")) {
      if (this.anchorLine !== null) {
        this.anchorLine = null;
        this.touch();
        return;
      }
      // Escape leaves a rendered view first; it only quits from source mode.
      if (this.presenting) {
        this.exitPresentation();
        this.touch();
        return;
      }
      if (this.pretty) {
        this.exitPretty();
        this.touch();
        return;
      }
      this.deps.onClose();
      return;
    }

    if (data === "q") {
      this.deps.onClose();
      return;
    }

    // `p` presents a deck and paginates plain Markdown — same key, because both
    // mean "show me the rendered form of what I am looking at".
    if (data === "p") {
      if (this.presenting) this.exitPresentation();
      else if (this.pretty) this.exitPretty();
      else if (this.isDeck) this.enterPresentation();
      else this.enterPretty();
      this.prompt = null;
      this.status = null;
      this.touch();
      return;
    }

    if (this.isDeck && (data === "]" || data === "[")) {
      this.stepSlide(data === "]" ? 1 : -1);
      return;
    }

    if (data === "s") {
      this.forcedDeck = !this.forcedDeck;
      if (!this.isDeck) this.presenting = false;
      // Turning slide mode on from the frontmatter would otherwise report
      // "slide 1" while showing the YAML, so snap to the first real slide.
      const first = this.isDeck ? this.deck.slides[0] : undefined;
      if (first && this.cursor < first.start) {
        this.cursor = first.start;
        this.scrollTop = first.start;
      }
      this.status = {
        text: this.isDeck ? `slide mode on (${this.deck.slides.length} slides)` : "slide mode off",
        tone: "info",
      };
      this.touch();
      return;
    }

    if (data === "y") {
      this.yank();
      return;
    }

    if (this.presenting) {
      this.handlePresentingKey(data);
      return;
    }

    if (this.pretty) {
      this.handlePrettyKey(data);
      return;
    }

    if (data === "w") {
      this.wrapped = !this.wrapped;
      this.status = { text: this.wrapped ? "soft wrap on" : "soft wrap off", tone: "info" };
      this.touch();
      return;
    }

    if (data === "v") {
      this.anchorLine = this.anchorLine === null ? this.cursor : null;
      this.status = null;
      this.touch();
      return;
    }

    const pages = Math.max(1, Math.floor((this.deps.tui.terminal.rows || 24) / 2));

    if (matchesKey(data, "down") || data === "j") this.moveCursor(1);
    else if (matchesKey(data, "up") || data === "k") this.moveCursor(-1);
    else if (matchesKey(data, "ctrl+d")) this.moveCursor(pages);
    else if (matchesKey(data, "ctrl+u")) this.moveCursor(-pages);
    else if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+f")) this.moveCursor(pages * 2);
    else if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+b")) this.moveCursor(-pages * 2);
    else if (data === "g") this.jumpTo(0);
    else if (data === "G") this.jumpTo(Number.MAX_SAFE_INTEGER);
    else if (data === "u") this.deps.onUndo();
    else if (matchesKey(data, "ctrl+r")) this.deps.onRedo();
    else if (data === "e") this.compose("replace");
    else if (data === "o" || matchesKey(data, "return")) this.compose("instruction");
    else if (QUICK_ACTIONS[data]) this.submit(QUICK_ACTIONS[data].kind, QUICK_ACTIONS[data].instruction);
  }

  private handleHelpKey(data: string): void {
    if (matchesKey(data, "escape") || data === "q" || data === "h" || data === "?") {
      this.help = false;
      this.touch();
      return;
    }

    const pages = Math.max(1, Math.floor((this.deps.tui.terminal.rows || 24) / 2));
    const step =
      matchesKey(data, "down") || data === "j" ? 1
      : matchesKey(data, "up") || data === "k" ? -1
      : matchesKey(data, "ctrl+d") ? pages
      : matchesKey(data, "ctrl+u") ? -pages
      : matchesKey(data, "pageDown") || matchesKey(data, "ctrl+f") ? pages * 2
      : matchesKey(data, "pageUp") || matchesKey(data, "ctrl+b") ? -pages * 2
      : data === "G" ? Number.MAX_SAFE_INTEGER
      : data === "g" ? Number.MIN_SAFE_INTEGER
      : 0;

    if (step === 0) return;
    this.helpTop = Math.max(0, this.helpTop + step);
    this.touch();
  }

  private handlePrettyKey(data: string): void {
    const pages = Math.max(1, Math.floor((this.deps.tui.terminal.rows || 24) / 2));

    if (matchesKey(data, "down") || data === "j") this.scrollPretty(1);
    else if (matchesKey(data, "up") || data === "k") this.scrollPretty(-1);
    else if (matchesKey(data, "ctrl+d")) this.scrollPretty(pages);
    else if (matchesKey(data, "ctrl+u")) this.scrollPretty(-pages);
    else if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+f")) this.scrollPretty(this.prettyViewport);
    else if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+b")) this.scrollPretty(-this.prettyViewport);
    else if (data === "g") this.scrollPretty(Number.MIN_SAFE_INTEGER);
    else if (data === "G") this.scrollPretty(Number.MAX_SAFE_INTEGER);
  }

  /**
   * Presentation: scroll within the slide, act on the whole slide, undo, leave.
   *
   * `j`/`space`/`down` scroll when the slide has more to show and advance once
   * it does not; `k`/`up` mirror that. A slide that fits therefore behaves like
   * a slideshow, and a long one still reads top to bottom before moving on.
   */
  private handlePresentingKey(data: string): void {
    const pages = Math.max(1, Math.floor((this.deps.tui.terminal.rows || 24) / 2));

    if (matchesKey(data, "down") || data === "j" || matchesKey(data, "space")) {
      if (this.prettyTop < this.maxPrettyTop()) this.scrollPretty(1);
      else this.stepSlide(1);
      return;
    }

    if (matchesKey(data, "up") || data === "k") {
      if (this.prettyTop > 0) this.scrollPretty(-1);
      else this.stepSlide(-1);
      return;
    }

    if (matchesKey(data, "ctrl+d")) this.scrollPretty(pages);
    else if (matchesKey(data, "ctrl+u")) this.scrollPretty(-pages);
    else if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+f")) this.scrollPretty(this.prettyViewport);
    else if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+b")) this.scrollPretty(-this.prettyViewport);
    else if (data === "g") this.scrollPretty(Number.MIN_SAFE_INTEGER);
    else if (data === "G") this.scrollPretty(Number.MAX_SAFE_INTEGER);
    else if (data === "u") this.deps.onUndo();
    else if (matchesKey(data, "ctrl+r")) this.deps.onRedo();
    else if (data === "e") this.compose("replace");
    else if (data === "o" || matchesKey(data, "return")) this.compose("instruction");
    else if (QUICK_ACTIONS[data]) this.submit(QUICK_ACTIONS[data].kind, QUICK_ACTIONS[data].instruction);
  }

  private stepSlide(delta: number): void {
    const current = this.activeSlide();
    const index = current ? current.number - 1 : 0;
    const next = clamp(index + delta, 0, this.deck.slides.length - 1);
    if (next === index) return;

    const slide = this.deck.slides[next];
    if (!slide) return;
    this.cursor = slide.start;
    this.scrollTop = slide.start;
    this.anchorLine = null;
    this.prettyTop = 0;
    this.pagerOffset = 0;
    this.status = null;
    this.touch();
  }

  private handlePromptKey(data: string): void {
    const prompt = this.prompt;
    if (!prompt) return;

    if (matchesKey(data, "escape")) {
      this.prompt = null;
      this.touch();
      return;
    }

    if (matchesKey(data, "return")) {
      const text = prompt.text;
      const mode = prompt.mode;
      this.prompt = null;
      if (!text.trim()) {
        this.touch();
      } else if (mode === "replace") {
        this.submitReplace(text);
      } else {
        this.submit("edit", text.trim());
      }
      return;
    }

    if (matchesKey(data, "ctrl+u")) {
      prompt.text = "";
      prompt.pos = 0;
      this.touch();
      return;
    }

    if (matchesKey(data, "backspace")) {
      if (prompt.pos > 0) {
        prompt.text = prompt.text.slice(0, prompt.pos - 1) + prompt.text.slice(prompt.pos);
        prompt.pos--;
        this.touch();
      }
      return;
    }

    if (matchesKey(data, "left")) {
      prompt.pos = Math.max(0, prompt.pos - 1);
      this.touch();
      return;
    }

    if (matchesKey(data, "right")) {
      prompt.pos = Math.min(prompt.text.length, prompt.pos + 1);
      this.touch();
      return;
    }

    if (data.length === 1 && data >= " ") {
      prompt.text = prompt.text.slice(0, prompt.pos) + data + prompt.text.slice(prompt.pos);
      prompt.pos++;
      this.touch();
    }
  }

  /**
   * `e` / `o` compose either in the built-in one-line prompt or in the host's
   * editor (pi-vim when installed). `ctrl+e` chooses, and the choice is
   * remembered for the process.
   */
  private compose(mode: "instruction" | "replace"): void {
    if (this.composeMode === "prompt" || !this.deps.createEditor) {
      if (mode === "replace") this.openReplacePrompt();
      else this.openPrompt();
      return;
    }

    const editor = this.deps.createEditor();
    if (!editor) {
      if (mode === "replace") this.openReplacePrompt();
      else this.openPrompt();
      return;
    }

    const target = this.target();
    const range = mode === "replace" ? this.replaceTarget() : { start: target.start, end: target.end };
    const wholeSlide = mode === "replace" ? false : target.wholeSlide;
    const anchor = makeAnchor(this.doc, range.start, range.end);
    const text = this.doc.lines.slice(range.start, range.end + 1).join("\n");

    editor.setText(mode === "replace" ? text : "");
    editor.onSubmit = (value: string) => this.finishComposer(value);
    (editor as { focused?: boolean }).focused = true;

    this.composer = {
      editor,
      mode,
      anchor,
      slide: this.slideContext(wholeSlide),
      title: `${mode === "replace" ? "Replace" : "Instruction for"} ${describeAnchor(anchor)}`,
    };
    this.anchorLine = null;
    this.status = null;
    this.touch();
  }

  private finishComposer(text: string): void {
    const composer = this.composer;
    if (!composer) return;
    this.composer = null;

    if (!text.trim()) {
      this.touch();
      return;
    }

    if (composer.mode === "replace") {
      this.status = { text: `replacing ${describeAnchor(composer.anchor)}`, tone: "info" };
      this.deps.onSubmit({
        kind: "replace",
        instruction: "",
        anchor: composer.anchor,
        replacement: text,
        slide: composer.slide,
      });
    } else {
      this.status = { text: `sent ${describeAnchor(composer.anchor)} to the agent`, tone: "info" };
      this.deps.onSubmit({
        kind: "edit",
        instruction: text.trim(),
        anchor: composer.anchor,
        slide: composer.slide,
      });
    }
    this.touch();
  }

  private closeComposer(next?: ComposeMode): void {
    this.composer = null;
    if (next) {
      this.composeMode = next;
      defaultComposeMode = next;
      this.status = {
        text: next === "editor" ? "composing in the editor" : "composing in the prompt",
        tone: "info",
      };
    }
    this.touch();
  }

  private handleComposerKey(data: string): void {
    const composer = this.composer;
    if (!composer) return;

    if (matchesKey(data, "ctrl+e")) {
      this.closeComposer("prompt");
      return;
    }
    if (matchesKey(data, "ctrl+c")) {
      this.closeComposer();
      return;
    }

    composer.editor.handleInput?.(data);
    this.touch();
  }

  private openPrompt(): void {
    this.prompt = { text: "", pos: 0, mode: "instruction" };
    this.status = null;
    this.touch();
  }

  /**
   * `e` edits the selection in place, so it starts from the current text when
   * the selection is a single line — otherwise there is nothing sensible to
   * prefill and the user types the replacement from scratch.
   */
  private openReplacePrompt(): void {
    const { start, end } = this.replaceTarget();
    const single = start === end ? (this.doc.lines[start] ?? "") : "";
    const prefill = single.trim().length > 0 ? single : "";
    this.prompt = { text: prefill, pos: prefill.length, mode: "replace" };
    this.status = null;
    this.touch();
  }

  private moveCursor(delta: number): void {
    this.cursor = clamp(this.cursor + delta, 0, Math.max(0, this.doc.lines.length - 1));
    // Keep the selection anchored where it started; the cursor end follows.
    this.status = null;
    this.touch();
  }

  private jumpTo(line: number): void {
    this.cursor = clamp(line, 0, Math.max(0, this.doc.lines.length - 1));
    this.touch();
  }

  // ------------------------------------------------------------- intents

  /** Inclusive [first, last] line range of the visual selection, if any. */
  private selectionRange(): [number, number] | null {
    if (this.anchorLine === null) return null;
    return [Math.min(this.anchorLine, this.cursor), Math.max(this.anchorLine, this.cursor)];
  }

  /** Target range for an action: the selection, else the slide, else the cursor line. */
  private target(): { start: number; end: number; wholeSlide: boolean; slide: Slide | null } {
    const range = this.selectionRange();
    const slide = this.activeSlide();
    if (range) return { start: range[0], end: range[1], wholeSlide: false, slide };
    if (slide) return { start: slide.start, end: slide.end, wholeSlide: true, slide };
    return { start: this.cursor, end: this.cursor, wholeSlide: false, slide };
  }

  private slideContext(whole: boolean): SlideContext | undefined {
    const slide = this.activeSlide();
    return slide ? { number: slide.number, total: this.deck.slides.length, title: slide.title, whole } : undefined;
  }

  /**
   * Typed replacement is textual surgery, so it never widens to a whole slide:
   * silently replacing a slide with one line of text would be a nasty surprise.
   * Selection first, then the cursor line.
   */
  private replaceTarget(): { start: number; end: number } {
    const range = this.selectionRange();
    return range ? { start: range[0], end: range[1] } : { start: this.cursor, end: this.cursor };
  }

  /**
   * Rendered rows flattened to pasteable text: no ANSI, no right padding, and no
   * common left indent (the Markdown component pads every row by one column).
   */
  private renderedText(rows: string[]): string {
    const lines = rows.map((row) => stripTerminalSequences(row).replace(/\s+$/, ""));
    const indents = lines.filter((line) => line.trim()).map((line) => line.length - line.trimStart().length);
    const indent = indents.length > 0 ? Math.min(...indents) : 0;
    return lines
      .map((line) => line.slice(indent))
      .join("\n")
      .replace(/^\n+/, "")
      .replace(/\s+$/, "");
  }

  /** The text `y` puts on the clipboard, and how to describe it. */
  private yankPayload(): { text: string; label: string } {
    if (this.presenting) {
      const slide = this.activeSlide();
      if (!slide) return { text: "", label: "" };
      const text = this.renderedText(this.slideMarkdown(slide).render(this.lastWidth));
      return { text, label: `slide ${slide.number}` };
    }

    if (this.pretty) {
      const rows = this.markdown().render(this.lastWidth);
      const start = this.prettyTop;
      const end = Math.min(rows.length, start + this.lastBodyHeight);
      const text = this.renderedText(rows.slice(start, end));
      return { text, label: `${Math.max(0, end - start)} visible rows` };
    }

    const range = this.selectionRange();
    if (range) {
      const [lo, hi] = range;
      return {
        text: this.doc.lines.slice(lo, hi + 1).join("\n"),
        label: describeAnchor(makeAnchor(this.doc, lo, hi)),
      };
    }

    return { text: this.doc.lines[this.cursor] ?? "", label: `line ${this.cursor + 1}` };
  }

  private yank(): void {
    const { text, label } = this.yankPayload();
    if (!text.trim()) {
      this.status = { text: "nothing to copy here", tone: "error" };
      this.touch();
      return;
    }

    // Report success optimistically: the copy is asynchronous and a failed
    // clipboard must not look like a no-op.
    this.status = { text: `copied ${label}`, tone: "info" };
    this.deps.onCopy?.(text, label);
    this.touch();
  }

  private submitReplace(text: string): void {
    const { start, end } = this.replaceTarget();
    const wholeSlide = false;
    const anchor = makeAnchor(this.doc, start, end);

    this.anchorLine = null;
    this.status = { text: `replacing ${describeAnchor(anchor)}`, tone: "info" };
    this.deps.onSubmit({
      kind: "replace",
      instruction: "",
      anchor,
      replacement: text,
      slide: this.slideContext(wholeSlide),
    });
    this.touch();
  }

  private submit(kind: "edit" | "explain", instruction: string): void {
    const range = this.selectionRange();
    const slide = this.activeSlide();

    let lo: number;
    let hi: number;
    let wholeSlide = false;

    if (range) {
      [lo, hi] = range;
    } else if (slide) {
      // In a deck, "nothing selected" means "this slide".
      lo = slide.start;
      hi = slide.end;
      wholeSlide = true;
    } else {
      lo = this.cursor;
      hi = this.cursor;
    }

    const anchor = makeAnchor(this.doc, lo, hi);
    const slideContext: SlideContext | undefined = slide
      ? { number: slide.number, total: this.deck.slides.length, title: slide.title, whole: wholeSlide }
      : undefined;

    this.anchorLine = null;
    this.status = {
      text: wholeSlide
        ? `sent slide ${slide?.number} to the agent`
        : `sent ${describeAnchor(anchor)} to the agent`,
      tone: "info",
    };
    this.deps.onSubmit({ kind, instruction, anchor, slide: slideContext });
    this.touch();
  }
}
