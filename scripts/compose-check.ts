/**
 * `e` and `o` hand composition to pi's editor. These assertions pin what the
 * hand-off asks for, because the dialog itself is pi's and cannot be driven here.
 *
 *   node scripts/compose-check.ts
 */

import { readFileSync } from "node:fs";
import { ArtifactViewer, type ComposeRequest, type ViewerTheme } from "../lib/viewer.ts";
import { makeDoc } from "../lib/source.ts";

const theme: ViewerTheme = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, inverse: (s) => s };
const markdownTheme = Object.fromEntries(
  ["heading", "link", "linkUrl", "code", "codeBlock", "codeBlockBorder", "quote", "quoteBorder", "hr", "listBullet", "bold", "italic", "strikethrough", "underline"].map(
    (key) => [key, (text: string) => text],
  ),
) as never;

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? `\n       ${detail}` : ""}`);
}

function session(path: string, keys: string[]) {
  const raw = readFileSync(path, "utf8");
  const requests: ComposeRequest[] = [];
  const viewer = new ArtifactViewer(makeDoc(path, raw), {
    tui: { terminal: { rows: 24, columns: 90 } as never, requestRender: () => {} },
    fullscreen: true,
    theme,
    markdownTheme,
    history: { versions: [raw], index: 0 },
    onSubmit: () => {},
    onUndo: () => {},
    onRedo: () => {},
    onClose: () => {},
    onCompose: (request) => requests.push(request),
  });
  viewer.render(90);
  for (const key of keys) {
    viewer.handleInput(key);
    viewer.render(90);
  }
  return { requests, lines: raw.split("\n") };
}

console.log("e with a selection (expected: the whole range, prefilled)");
{
  const { requests, lines } = session("examples/demo-deck.md", ["j", "j", "v", "j", "j", "e"]);
  const request = requests[0];
  check("mode is replace", request?.mode === "replace", request?.mode);
  check("titles the range", request?.title === "Replace lines 9–11", request?.title);
  check("prefills the full source range", request?.prefill === lines.slice(8, 11).join("\n"), JSON.stringify(request?.prefill));
  check("prefill is multi-line", (request?.prefill ?? "").includes("\n"), JSON.stringify(request?.prefill));
  check("anchor matches", request?.anchor.start === 8 && request?.anchor.end === 10, `${request?.anchor.start}-${request?.anchor.end}`);
}

console.log("e with no selection in a deck (cursor line, never the slide)");
{
  const { requests, lines } = session("examples/demo-deck.md", ["j", "j", "e"]);
  const request = requests[0];
  check("prefills the cursor line", request?.prefill === lines[8], JSON.stringify(request?.prefill));
  check("does not widen to the whole slide", request?.slide?.whole === false, JSON.stringify(request?.slide));
}

console.log("o with no selection in a deck (the whole slide goes to the agent)");
{
  const { requests } = session("examples/demo-deck.md", ["o"]);
  const request = requests[0];
  check("mode is instruction", request?.mode === "instruction", request?.mode);
  check("has no prefill", request?.prefill === "", JSON.stringify(request?.prefill));
  check("names the slide", request?.slide?.whole === true && request?.slide.number === 1, JSON.stringify(request?.slide));
  check("titles the slide range", request?.title === "Instruction for lines 7–13", request?.title);
}

console.log("o in plain source mode");
{
  const { requests } = session("examples/demo-doc.md", ["j", "j", "j", "v", "j", "o"]);
  const request = requests[0];
  check("mode is instruction", request?.mode === "instruction");
  check("titles the selection", request?.title === "Instruction for lines 4–5", request?.title);
  check("no slide context", request?.slide === undefined, JSON.stringify(request?.slide));
}

console.log(failures === 0 ? "\nall compose hand-offs request the right thing" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
