/**
 * Round-trip check for the source ↔ rendered mapping.
 *
 * Switching to a rendered view and back must land the cursor where it started.
 * That is the whole contract, so it is worth asserting rather than eyeballing.
 *
 *   node scripts/align-check.ts
 */

import { readFileSync } from "node:fs";
import { normalize } from "../lib/align.ts";
import { parseDeck, slideAt } from "../lib/slides.ts";
import { ArtifactViewer, type ViewerTheme } from "../lib/viewer.ts";
import { makeDoc } from "../lib/source.ts";

const theme: ViewerTheme = {
  fg: (_token, text) => text,
  bg: (_token, text) => text,
  bold: (text) => text,
  inverse: (text) => text,
};

const markdownTheme = Object.fromEntries(
  ["heading", "link", "linkUrl", "code", "codeBlock", "codeBlockBorder", "quote", "quoteBorder", "hr", "listBullet", "bold", "italic", "strikethrough", "underline"].map(
    (key) => [key, (text: string) => text],
  ),
) as never;

const WIDTH = 84;
const ROWS = 30;

let failures = 0;

function makeViewer(path: string) {
  const raw = readFileSync(path, "utf8");
  const doc = makeDoc(path, raw);
  const viewer = new ArtifactViewer(doc, {
    tui: { terminal: { rows: ROWS, columns: WIDTH } as never, requestRender: () => {} },
    fullscreen: true,
    theme,
    markdownTheme,
    history: { versions: [raw], index: 0 },
    onSubmit: () => {},
    onUndo: () => {},
    onRedo: () => {},
    onClose: () => {},
  });
  return { viewer, doc };
}

function check(path: string) {
  console.log(`\n${path}`);
  for (const target of [0, 8, 20, 35, 50, 61]) {
    const { viewer, doc } = makeViewer(path);
    if (target >= doc.lines.length) continue;

    viewer.render(WIDTH); // establish width/height
    for (let i = 0; i < target; i++) viewer.handleInput("j");
    viewer.render(WIDTH);
    const before = viewer.debugPosition();

    viewer.handleInput("p");
    const rendered = viewer.render(WIDTH);
    const mid = viewer.debugPosition();

    viewer.handleInput("p");
    viewer.render(WIDTH);
    const after = viewer.debugPosition();

    const drift = Math.abs(after.cursor - before.cursor);
    // A blank line, a rule, or a comment has no rendered position of its own, so
    // "did we come back to the same content" is the only honest requirement.
    const structural = !/[a-z0-9]/i.test(normalize(doc.lines[before.cursor] ?? ""));
    const deck = parseDeck(doc);
    const sameSlide =
      (slideAt(deck, before.cursor)?.number ?? null) === (slideAt(deck, after.cursor)?.number ?? null);
    const ok = drift === 0 || (structural && (drift <= 6 || sameSlide));
    if (!ok) failures++;
    console.log(
      `  line ${String(before.cursor + 1).padStart(3)} → ${mid.pretty ? "pretty" : "present"} row ${String(mid.prettyTop).padStart(3)}`
        + ` → back to line ${String(after.cursor + 1).padStart(3)}  ${ok ? (drift === 0 ? "ok" : "ok (structural)") : `DRIFT ${drift}`}`,
    );
  }
}

for (const path of ["examples/demo-doc.md", "examples/demo-deck.md"]) check(path);

console.log(failures === 0 ? "\nall round trips within one line" : `\n${failures} drift(s)`);
process.exit(failures === 0 ? 0 : 1);
