/**
 * Headless render preview.
 *
 * Builds the viewer with a stub TUI and a minimal ANSI theme, drives it with
 * keystrokes, and prints the result. Doubles as a layout test: every line the
 * component returns must be exactly the requested width.
 *
 *   node scripts/preview.ts            source mode with a selection
 *   node scripts/preview.ts pretty     pretty mode
 *   node scripts/preview.ts html       HTML file
 */

import { makeDoc } from "../lib/source.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ArtifactViewer, type ViewerTheme } from "../lib/viewer.ts";

const SGR: Record<string, string> = {
  accent: "\x1b[36m",
  dim: "\x1b[2m",
  muted: "\x1b[90m",
  borderMuted: "\x1b[90m",
  text: "\x1b[39m",
  success: "\x1b[32m",
  error: "\x1b[31m",
};
const SGR_BG: Record<string, string> = {
  selectedBg: "\x1b[48;5;237m",
};

const escape = (value: string | undefined) => value ?? "\x1b[39m";

const theme: ViewerTheme = {
  fg: (token, text) => `${escape(SGR[token])}${text}\x1b[39m`,
  bg: (token, text) => `${SGR_BG[token] ?? ""}${text}\x1b[49m`,
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
  inverse: (text) => `\x1b[7m${text}\x1b[27m`,
};

/** Identity markdown theme: readable enough to check layout, no colors needed. */
const markdownTheme = {
  heading: (t: string) => `\x1b[1m${t}\x1b[22m`,
  link: (t: string) => t,
  linkUrl: (t: string) => t,
  code: (t: string) => t,
  codeBlock: (t: string) => t,
  codeBlockBorder: (t: string) => `\x1b[2m${t}\x1b[22m`,
  quote: (t: string) => t,
  quoteBorder: (t: string) => `\x1b[2m${t}\x1b[22m`,
  hr: (t: string) => `\x1b[2m${t}\x1b[22m`,
  listBullet: (t: string) => t,
  bold: (t: string) => `\x1b[1m${t}\x1b[22m`,
  italic: (t: string) => t,
  strikethrough: (t: string) => t,
  underline: (t: string) => t,
};

const MARKDOWN = [
  "# Quarterly review",
  "",
  "Revenue grew 12% quarter over quarter, driven mostly by the",
  "self-serve tier. Enterprise renewals were flat.",
  "",
  "## What went well",
  "",
  "- Self-serve conversion doubled",
  "- Support response time dropped to 3h",
  "",
  "## What did not",
  "",
  "The onboarding rewrite slipped by two weeks. We should decide",
  "whether to cut the guided tour or push the date again.",
  "",
  "```ts",
  "const revenue = await fetchQuarter(q3);",
  "```",
  "",
  "> Note: numbers are unaudited.",
  "",
  "Closing thoughts go here, and this paragraph is long enough to be truncated at a narrow width so the ellipsis path gets exercised properly.",
].join("\n");

const DECK = [
  "---",
  "marp: true",
  "paginate: true",
  "---",
  "",
  "# Q3 review",
  "",
  "Revenue grew 12% quarter over quarter.",
  "",
  "---",
  "",
  "## What went well",
  "",
  "- Self-serve conversion doubled",
  "- Support response time dropped to 3h",
  "",
  "<!-- _class: lead -->",
  "",
  "---",
  "",
  "## What did not",
  "",
  "The onboarding rewrite slipped by two weeks.",
  "",
  "```ts",
  "const revenue = await fetchQuarter(q3);",
  "---",
  "```",
  "",
  "---",
  "",
  "## Next steps",
  "",
  "Decide whether to cut the guided tour.",
].join("\n");

const HTML = [
  "<!doctype html>",
  "<html>",
  "  <head><title>Report</title></head>",
  "  <body>",
  "    <h1>Report</h1>",
  "    <p>Line one.</p>",
  "  </body>",
  "</html>",
].join("\n");

function build(kind: "md" | "html" | "deck", rows: number, width: number) {
  const raw = kind === "html" ? HTML : kind === "deck" ? DECK : MARKDOWN;
  const name = kind === "html" ? "report.html" : kind === "deck" ? "deck.md" : "notes.md";
  const doc = makeDoc(`/tmp/${name}`, raw);

  const viewer = new ArtifactViewer(doc, {
    tui: { terminal: { rows, columns: width } as never, requestRender: () => {} },
    fullscreen: true,
    theme,
    markdownTheme,
    history: { versions: [raw, raw], index: 1 },
    onSubmit: () => {},
    onUndo: () => {},
    onRedo: () => {},
    onClose: () => {},
  });
  return { viewer, doc };
}

function assertWidth(lines: string[], width: number, label: string) {
  lines.forEach((line, index) => {
    const actual = visibleWidth(line);
    if (actual !== width) {
      throw new Error(`${label}: line ${index + 1} is ${actual} wide, expected ${width}\n${JSON.stringify(line)}`);
    }
  });
}

function show(lines: string[], width: number) {
  const edge = "│";
  console.log(`┌${"─".repeat(width)}┐`);
  for (const line of lines) console.log(`${edge}${line}\x1b[0m${edge}`);
  console.log(`└${"─".repeat(width)}┘`);
}

const mode = process.argv[2] ?? "source";
const width = Number(process.argv[3] ?? 76);
const rows = Number(process.argv[4] ?? 20);

if (mode === "html") {
  const { viewer } = build("html", rows, width);
  const lines = viewer.render(width);
  assertWidth(lines, width, "html");
  show(lines, width);
} else if (mode === "help") {
  const { viewer } = build("deck", rows, width);
  viewer.handleInput("h");
  const lines = viewer.render(width);
  assertWidth(lines, width, "help");
  show(lines, width);
} else if (mode === "deck" || mode === "present") {
  const { viewer } = build("deck", rows, width);
  viewer.handleInput("]"); // slide 2
  if (mode === "present") viewer.handleInput("p");
  const lines = viewer.render(width);
  assertWidth(lines, width, mode);
  show(lines, width);
} else if (mode === "pretty") {
  const { viewer } = build("md", rows, width);
  viewer.handleInput("p");
  const lines = viewer.render(width);
  assertWidth(lines, width, "pretty");
  show(lines, width);
} else {
  const { viewer } = build("md", rows, width);
  viewer.handleInput("j");
  viewer.handleInput("j");
  viewer.handleInput("j");
  viewer.handleInput("j");
  viewer.handleInput("v"); // start selection
  viewer.handleInput("j");
  viewer.handleInput("j");
  const lines = viewer.render(width);
  assertWidth(lines, width, "source");
  show(lines, width);
}

console.log(`\nok: every line is exactly ${width} columns`);
