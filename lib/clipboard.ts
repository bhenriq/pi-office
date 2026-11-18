/**
 * Putting text on the clipboard from inside pi.
 *
 * pi ships a native clipboard helper, which is the happy path. It is optional
 * (undefined on unsupported platforms, `setText` missing elsewhere), so there is
 * a fallback chain: `pbcopy` on macOS, then the Wayland/X11 tools on Linux. The
 * terminal itself is never written to — pi owns stdout, and injecting OSC 52
 * there would corrupt its differential rendering.
 */

import { execFile } from "node:child_process";
import { getNativeClipboard } from "@earendil-works/pi-tui";

export interface CopyResult {
  ok: boolean;
  /** Where the text went, for the status line. */
  via: string;
  error?: string;
}

const LINUX_TOOLS: { command: string; args: string[] }[] = [
  { command: "wl-copy", args: [] },
  { command: "xclip", args: ["-selection", "clipboard"] },
  { command: "xsel", args: ["--clipboard", "--input"] },
];

function pipeToCommand(command: string, args: string[], text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { timeout: 4000 }, (error) => {
      if (error) reject(error);
      else resolve();
    });
    child.on("error", reject);
    child.stdin?.on("error", () => {
      /* the tool may exit before reading; the callback above reports it */
    });
    child.stdin?.end(text, "utf8");
  });
}

export async function copyText(text: string): Promise<CopyResult> {
  const native = getNativeClipboard();
  if (native?.setText) {
    try {
      await native.setText(text);
      return { ok: true, via: "clipboard" };
    } catch {
      /* fall through to the command-line tools */
    }
  }

  const candidates = process.platform === "darwin" ? [{ command: "pbcopy", args: [] }] : LINUX_TOOLS;

  let lastError = "no clipboard available";
  for (const candidate of candidates) {
    try {
      await pipeToCommand(candidate.command, candidate.args, text);
      return { ok: true, via: candidate.command };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return { ok: false, via: "none", error: lastError };
}
