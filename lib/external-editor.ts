/**
 * Composing in a real editor: suspend pi, hand the terminal to `$VISUAL` /
 * `$EDITOR`, then read the buffer back.
 *
 * This is the same shape pi uses for its own "open in external editor": the TUI
 * stops (leaving the alternate screen), the child inherits stdio, and the TUI
 * restarts afterwards. The difference between this and pi's internal helper is
 * only that we run it on demand from the viewer instead of from a dialog.
 *
 * Spawning is async rather than `spawnSync` on purpose: synchronous child
 * processes on Windows keep Node's console read active and race the editor for
 * the terminal.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ExternalEditResult =
  | { status: "complete"; content: string }
  | { status: "cancelled"; message?: string }
  | { status: "failed"; message: string };

/** Order pi itself uses: `$VISUAL`, then `$EDITOR`, then a platform default. */
export function resolveEditorCommand(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.VISUAL?.trim() || env.EDITOR?.trim();
  if (configured) return configured;
  return process.platform === "win32" ? "notepad" : "nano";
}

export interface ExternalEditOptions {
  content: string;
  /** Stop the TUI so the child can own the terminal. */
  suspend(): void;
  /** Restart the TUI afterwards. Called even when the editor fails. */
  resume(): void;
  command?: string;
}

export async function editInExternalEditor(options: ExternalEditOptions): Promise<ExternalEditResult> {
  const command = options.command ?? resolveEditorCommand();
  const [editor, ...editorArgs] = command.split(" ");
  const directory = mkdtempSync(join(tmpdir(), "pi-office-"));
  const filePath = join(directory, "artifact.md");

  try {
    writeFileSync(filePath, options.content, "utf8");
    options.suspend();

    const exit = await new Promise<number | string | null>((resolve) => {
      const child = spawn(editor ?? "", [...editorArgs, filePath], {
        stdio: "inherit",
        shell: process.platform === "win32",
      });
      child.on("error", () => resolve(null));
      child.on("close", (code, signal) => resolve(code ?? signal));
    });

    if (exit === null) {
      return { status: "failed", message: `could not launch ${command}` };
    }
    if (exit !== 0) {
      return { status: "cancelled", message: `${command} exited with ${String(exit)}; nothing applied` };
    }

    const content = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "").replace(/\n$/, "");
    if (content === options.content) return { status: "cancelled" };
    return { status: "complete", content };
  } catch (error) {
    return { status: "failed", message: error instanceof Error ? error.message : String(error) };
  } finally {
    options.resume();
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}
