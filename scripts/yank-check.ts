/**
 * `y` must put *pasteable* text on the clipboard.
 *
 * The rendered views pad every row to the terminal width and colour it, so the
 * obvious implementation copies hundreds of trailing spaces and ANSI escapes.
 * These assertions exist because that is exactly what happened.
 *
 *   node scripts/yank-check.ts
 */

import { readFileSync } from "node:fs";
import { ArtifactViewer, type ViewerTheme } from "../lib/viewer.ts";
import { makeDoc } from "../lib/source.ts";

const DECORATING: ViewerTheme = {
  fg: (_token, text) => `\x1b[36m${text}\x1b[39m`,
  bg: (_token, text) => `\x1b[48;5;237m${text}\x1b[49m`,
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
  inverse: (text) => `\x1b[7m${text}\x1b[27m`,
};

const markdownTheme = Object.fromEntries(
  ["heading", "link", "linkUrl", "code", "codeBlock", "codeBlockBorder", "quote", "quoteBorder", "hr", "listBullet", "bold", "italic", "strikethrough", "underline"].map(
    (key) => [key, (text: string) => `\x1b[1m${text}\x1b[22m`],
  ),
) as never;

const WIDTH = 90;
const ROWS = 24;
let failures = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (!condition) failures++;
  console.log(`  ${condition ? "ok  " : "FAIL"} ${name}${!condition && detail ? `\n       ${detail}` : ""}`);
}

function session(path: string, keys: string[]) {
  const raw = readFileSync(path, "utf8");
  const copies: { label: string; text: string }[] = [];
  const viewer = new ArtifactViewer(makeDoc(path, raw), {
    tui: { terminal: { rows: ROWS, columns: WIDTH } as never, requestRender: () => {} },
    fullscreen: true,
    theme: DECORATING,
    markdownTheme,
    history: { versions: [raw], index: 0 },
    onSubmit: () => {},
    onUndo: () => {},
    onRedo: () => {},
    onClose: () => {},
    onCopy: (text, label) => copies.push({ label, text }),
  });
  viewer.render(WIDTH);
  for (const key of keys) {
    viewer.handleInput(key);
    viewer.render(WIDTH);
  }
  return { copies, raw, lines: raw.split("\n") };
}

console.log("line");
{
  const { copies, lines } = session("examples/demo-deck.md", ["j", "j", "y"]);
  check("copies the cursor line verbatim", copies[0]?.text === (lines[8] ?? ""), JSON.stringify(copies[0]?.text));
  check("labels it", copies[0]?.label === "line 9", copies[0]?.label);
}

console.log("selection");
{
  const { copies, lines } = session("examples/demo-deck.md", ["j", "j", "v", "j", "y"]);
  const expected = (lines.slice(8, 10) ?? []).join("\n");
  check("copies the exact source range", copies[0]?.text === expected, JSON.stringify(copies[0]?.text));
  check("labels the range", copies[0]?.label === "lines 9–10", copies[0]?.label);
}

console.log("slide");
{
  const { copies } = session("examples/demo-deck.md", ["p", "y"]);
  const text = copies[0]?.text ?? "";
  check("has no ANSI", !text.includes("\x1b"), text.slice(0, 40));
  check("has no trailing padding", !/[ \t]$/m.test(text), JSON.stringify(text.split("\n").find((l) => /[ \t]$/.test(l))));
  check("has no common left indent", !/^[ \t]/m.test(text), JSON.stringify(text.split("\n").find((l) => /^[ \t]/.test(l))));
  check("drops HTML comments", !text.includes("<!--"), text.slice(0, 80));
  check("keeps the slide text", text.startsWith("Testing pi-office"), text.slice(0, 40));
}

console.log("pretty");
{
  const { copies } = session("examples/demo-doc.md", [...Array(12).fill("j"), "p", "y"]);
  const text = copies[0]?.text ?? "";
  check("has no ANSI", !text.includes("\x1b"), text.slice(0, 40));
  check("has no trailing padding", !/[ \t]$/m.test(text));
  check("is not empty", text.trim().length > 0);
}

console.log(failures === 0 ? "\nall yank payloads are pasteable" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
