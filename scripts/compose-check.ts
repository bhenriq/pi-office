/**
 * `ctrl+e` chooses how `e` and `o` compose: the viewer's one-line prompt, or the
 * host's editor (pi-vim when installed). The editor is injected, so the toggle,
 * the prefill and the submit path are testable without a terminal.
 *
 *   node scripts/compose-check.ts
 */

import { readFileSync } from "node:fs";
import type { EditorComponent } from "@earendil-works/pi-tui";
import { ArtifactViewer, type ViewerTheme, type ViewerIntent } from "../lib/viewer.ts";
import { makeDoc } from "../lib/source.ts";

const theme: ViewerTheme = { fg: (_t, s) => s, bg: (_t, s) => s, bold: (s) => s, inverse: (s) => s };
const markdownTheme = Object.fromEntries(
  ["heading", "link", "linkUrl", "code", "codeBlock", "codeBlockBorder", "quote", "quoteBorder", "hr", "listBullet", "bold", "italic", "strikethrough", "underline"].map(
    (key) => [key, [key, (text: string) => text]],
  ).map(([, pair]) => pair as [string, (text: string) => string]),
) as never;

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? `\n       ${detail}` : ""}`);
}

interface FakeEditor {
  text: string;
  keys: string[];
  setText(value: string): void;
  handleInput(data: string): void;
  render(): string[];
  invalidate(): void;
  onSubmit?: (text: string) => void;
}

function makeFake(created: FakeEditor[]): EditorComponent {
  const editor: FakeEditor = {
    text: "",
    keys: [],
    setText: (value) => {
      editor.text = value;
    },
    handleInput: (data) => {
      editor.keys.push(data);
      editor.text += data;
    },
    render: () => [`[editor] ${editor.text.replace(/\n/g, "\\n") || "(empty)"}`],
    invalidate: () => {},
    onSubmit: undefined,
  };
  created.push(editor);
  return {
    getText: () => editor.text,
    setText: (value: string) => editor.setText(value),
    handleInput: (data: string) => editor.handleInput(data),
    render: () => editor.render(),
    invalidate: () => {},
    get onSubmit() {
      return editor.onSubmit;
    },
    set onSubmit(handler: ((text: string) => void) | undefined) {
      editor.onSubmit = handler;
    },
  } as EditorComponent;
}

function session(path: string, keys: string[], mode?: "prompt" | "editor") {
  const raw = readFileSync(path, "utf8");
  const intents: ViewerIntent[] = [];
  const editors: FakeEditor[] = [];
  const viewer = new ArtifactViewer(makeDoc(path, raw), {
    tui: { terminal: { rows: 24, columns: 90 } as never, requestRender: () => {} },
    fullscreen: true,
    theme,
    markdownTheme,
    history: { versions: [raw], index: 0 },
    onSubmit: (intent) => intents.push(intent),
    onUndo: () => {},
    onRedo: () => {},
    onClose: () => {},
    createEditor: () => makeFake(editors),
  });
  viewer.render(90);

  // The compose mode is remembered for the process, so set it explicitly rather
  // than assuming what a previous test left behind.
  if (mode && viewer.debugPosition().composeMode !== mode) {
    viewer.handleInput("\x05");
    viewer.render(90);
  }

  for (const key of keys) {
    viewer.handleInput(key);
    viewer.render(90);
  }
  return { viewer, intents, editors, lines: raw.split("\n") };
}

console.log("prompt mode");
{
  const { viewer } = session("examples/demo-deck.md", ["j", "j", "e"], "prompt");
  check("e opens the one-line prompt", viewer.render(90).join("\n").includes("→"));
}

console.log("ctrl+e switches the composer");
{
  const { viewer, editors, lines } = session("examples/demo-deck.md", [], "prompt");
  viewer.handleInput("\x05");
  viewer.render(90);
  check("mode is now editor", viewer.debugPosition().composeMode === "editor");

  viewer.handleInput("j");
  viewer.handleInput("j");
  viewer.handleInput("e");
  viewer.render(90);
  check("e asks the host for an editor", editors.length === 1, String(editors.length));
  check("prefilled with the cursor line", editors[0]?.text === lines[8], JSON.stringify(editors[0]?.text));
  check("the editor owns the body", viewer.render(90).join("\n").includes("[editor]"));

  viewer.handleInput("\x05"); // back to the prompt
  viewer.render(90);
  check("mode is prompt again", viewer.debugPosition().composeMode === "prompt");
  viewer.handleInput("e");
  viewer.render(90);
  check("e opens the prompt now", viewer.render(90).join("\n").includes("→"));
}

console.log("submitting a replacement");
{
  const { viewer, editors, intents, lines } = session("examples/demo-deck.md", ["j", "j", "v", "j", "e"], "editor");
  check("prefilled with the whole selected range", editors[0]?.text === lines.slice(8, 10).join("\n"), JSON.stringify(editors[0]?.text));

  editors[0]!.text = "## Rewritten\n\nBy hand.";
  editors[0]!.onSubmit?.("## Rewritten\n\nBy hand.");
  viewer.render(90);

  check("intent is a replace", intents[0]?.kind === "replace", String(intents[0]?.kind));
  check("carries the composed text", intents[0]?.replacement === "## Rewritten\n\nBy hand.", JSON.stringify(intents[0]?.replacement));
  check("carries the original anchor", intents[0]?.anchor.start === 8 && intents[0]?.anchor.end === 9, JSON.stringify(intents[0]?.anchor));
  check("composer closed", !viewer.render(90).join("\n").includes("[editor]"));
}

console.log("composing an instruction");
{
  const { viewer, editors, intents } = session("examples/demo-deck.md", ["o"], "editor");
  check("starts empty", editors[0]?.text === "", JSON.stringify(editors[0]?.text));
  editors[0]!.onSubmit?.("tighten this slide");
  viewer.render(90);
  check("intent is an edit", intents[0]?.kind === "edit", String(intents[0]?.kind));
  check("carries the instruction", intents[0]?.instruction === "tighten this slide", intents[0]?.instruction);
  check("whole slide when nothing is selected", intents[0]?.slide?.whole === true, JSON.stringify(intents[0]?.slide));
}

console.log("cancelling");
{
  const { viewer, intents } = session("examples/demo-deck.md", ["j", "e"], "editor");
  check("composing", viewer.debugPosition().composing);
  viewer.handleInput("\x03"); // ctrl+c
  viewer.render(90);
  check("nothing submitted", intents.length === 0, String(intents.length));
  check("back to source", !viewer.render(90).join("\n").includes("[editor]"));
}

console.log(failures === 0 ? "\nall compose modes behave" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
