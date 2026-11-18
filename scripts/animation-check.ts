/**
 * The status line is the animation surface: a spinner and an elapsed clock while
 * a request is in flight, and a brief inverted flash when one is sent.
 *
 *   node scripts/animation-check.ts
 */

import { readFileSync } from "node:fs";
import { ArtifactViewer, type ViewerTheme } from "../lib/viewer.ts";
import { makeDoc } from "../lib/source.ts";

const INVERSE = "\x1b[7m";
const theme: ViewerTheme = {
  fg: (_t, s) => `\x1b[36m${s}\x1b[39m`,
  bg: (_t, s) => s,
  bold: (s) => `\x1b[1m${s}\x1b[22m`,
  inverse: (s) => `${INVERSE}${s}\x1b[27m`,
};
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

const path = "examples/demo-doc.md";
const raw = readFileSync(path, "utf8");
const viewer = new ArtifactViewer(makeDoc(path, raw), {
  tui: { terminal: { rows: 14, columns: 90 } as never, requestRender: () => {} },
  fullscreen: true,
  theme,
  markdownTheme,
  history: { versions: [raw], index: 0 },
  onSubmit: () => {},
  onUndo: () => {},
  onRedo: () => {},
  onClose: () => {},
});

const statusLine = () => viewer.render(90).at(-1) ?? "";
const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");

viewer.render(90);
viewer.handleInput("j");
viewer.handleInput("v");
viewer.handleInput("j");
viewer.render(90);
viewer.handleInput("l"); // quick action → a request goes to the agent

console.log("on submit");
const first = statusLine();
check("says what was sent", plain(first).includes("sent lines 2–3"), plain(first));
check("flashes immediately", first.includes(INVERSE), "no inverse video");
check("shows a spinner", /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(plain(first)), plain(first));

console.log("while waiting");
const frames = new Set<string>();
for (let i = 0; i < 5; i++) {
  frames.add(plain(statusLine()));
  await new Promise((resolve) => setTimeout(resolve, 120));
}
check("frames are distinct", frames.size >= 3, `${frames.size} distinct`);
await new Promise((resolve) => setTimeout(resolve, 250)); // past the flash window
check("flash has expired", !statusLine().includes(INVERSE), "still inverted");
check("elapsed clock appears", /\ds/.test(plain(statusLine())), plain(statusLine()));

console.log("agent output and settling");
viewer.setAgentState(true, "Reading the selection…");
const busy = plain(statusLine());
check("shows the agent's latest line", busy.includes("Reading the selection…"), busy);

viewer.setAgentState(false);
viewer.setStatus("file updated");
const idle = plain(statusLine());
check("returns to the plain status", idle.includes("file updated"), idle);
check("no spinner when idle", !/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(idle), idle);

viewer.dispose();
console.log(failures === 0 ? "\nanimation behaves" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
