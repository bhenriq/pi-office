/**
 * pi-office — read and annotate a text artifact inside pi's own TUI.
 *
 * Usage: /edit [path]
 *
 * Opens the file as a full-screen component with two modes: `source` (line for
 * line, line numbers, the mode that produces annotations) and `pretty` (Markdown
 * rendered read-only). Selecting lines and pressing one key sends a line-anchored
 * edit request to the agent; the file on disk stays the single source of truth,
 * and the viewer re-renders whenever the agent writes to it.
 *
 * There is no second process, no local server, and no socket: the viewer is a
 * component running in the session that owns the file.
 */

import { watchFile, unwatchFile } from "node:fs";
import { readdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Editor } from "@earendil-works/pi-tui";
import { checkAnchor, describeAnchor } from "./lib/anchor.ts";
import { copyText } from "./lib/clipboard.ts";
import { buildPrompt } from "./lib/prompt.ts";
import { makeDoc, rawRange, readDoc, type SourceDoc } from "./lib/source.ts";
import { ArtifactViewer, type ViewerHistory, type ViewerIntent, type ViewerTheme } from "./lib/viewer.ts";

const ARTIFACT_EXTS = new Set([
  ".md", ".markdown", ".mdown", ".mkd",
  ".html", ".htm",
  ".txt", ".json", ".yaml", ".yml", ".toml",
  ".ts", ".tsx", ".js", ".jsx", ".css", ".py", ".sh", ".sql",
]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".cache", "vendor", "target"]);
const WATCH_DEBOUNCE_MS = 200;

/** Use every cell: the component renders exactly `terminal.rows` lines to fill it. */
const FULLSCREEN_OVERLAY = { width: "100%", maxHeight: "100%", anchor: "center", margin: 0 } as const;

interface OpenSession {
  path: string;
  doc: SourceDoc;
  history: ViewerHistory;
  viewer: ArtifactViewer | null;
  stopWatching(): void;
}

interface PendingJob {
  session: OpenSession;
  /** Revision the selection was made against, to tell edits from explanations. */
  rev: string;
  kind: "edit" | "explain";
}

let pi: ExtensionAPI | null = null;
let active: OpenSession | null = null;
let pending: PendingJob | null = null;
let lastAssistantText = "";

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

async function listArtifacts(root: string, maxDepth = 4): Promise<{ path: string; mtime: number }[]> {
  const found: { path: string; mtime: number }[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth && !SKIP_DIRS.has(entry.name)) await walk(full, depth + 1);
      } else if (entry.isFile() && ARTIFACT_EXTS.has(extname(entry.name).toLowerCase())) {
        try {
          found.push({ path: full, mtime: (await stat(full)).mtimeMs });
        } catch {
          /* unreadable; skip */
        }
      }
    }
  }

  await walk(root, 1);
  found.sort((a, b) => b.mtime - a.mtime);
  return found.slice(0, 50);
}

function timeAgo(ms: number): string {
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function lastLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

async function resolveTarget(target: string, ctx: ExtensionContext): Promise<string | null> {
  const requested = resolve(ctx.cwd, target);
  const full = await realpath(requested).catch(() => requested);
  const info = await stat(full).catch(() => null);
  if (!info || !info.isFile()) {
    ctx.ui.notify(`pi-office: not a file: ${full}`, "error");
    return null;
  }
  return full;
}

async function pickArtifact(ctx: ExtensionContext): Promise<string | null> {
  const files = await listArtifacts(ctx.cwd).catch(() => []);
  if (files.length === 0) {
    ctx.ui.notify(`pi-office: no editable artifacts under ${ctx.cwd}`, "warning");
    return null;
  }

  const labels = files.map((f) => `${relative(ctx.cwd, f.path) || basename(f.path)}  ·  ${timeAgo(f.mtime)}`);
  const choice = await ctx.ui.select("Open an artifact", labels);
  if (!choice) return null;

  const index = labels.indexOf(choice);
  return index === -1 ? null : files[index].path;
}

function adoptDoc(session: OpenSession, doc: SourceDoc): void {
  session.doc = doc;
  if (doc.raw !== session.history.versions[session.history.index]) {
    session.history.versions = session.history.versions.slice(0, session.history.index + 1);
    session.history.versions.push(doc.raw);
    session.history.index = session.history.versions.length - 1;
  }
  session.viewer?.setDoc(doc);
}

async function openArtifact(filePath: string, ctx: ExtensionContext): Promise<void> {
  if (active) {
    ctx.ui.notify(`pi-office: close ${basename(active.path)} first (esc)`, "warning");
    return;
  }

  let doc: SourceDoc;
  try {
    doc = await readDoc(filePath);
  } catch (error) {
    ctx.ui.notify(`pi-office: ${error instanceof Error ? error.message : String(error)}`, "error");
    return;
  }

  const session: OpenSession = {
    path: filePath,
    doc,
    history: { versions: [doc.raw], index: 0 },
    viewer: null,
    stopWatching: () => {},
  };
  active = session;

  let debounce: NodeJS.Timeout | null = null;
  watchFile(filePath, { interval: 400 }, () => {
    if (debounce) return;
    debounce = setTimeout(() => {
      debounce = null;
      void refreshFromDisk(session);
    }, WATCH_DEBOUNCE_MS);
  });
  session.stopWatching = () => {
    if (debounce) clearTimeout(debounce);
    unwatchFile(filePath);
  };

  // A full-screen overlay covers pi's footer and transcript, so the viewer owns
  // the whole terminal. `PI_OFFICE_INLINE=1` keeps the old in-layout behaviour,
  // where pi's chrome stays visible above and below.
  const fullscreen = process.env.PI_OFFICE_INLINE !== "1";

  await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      session.stopWatching();
      session.viewer = null;
      if (active === session) active = null;
      done();
    };

    session.viewer = new ArtifactViewer(session.doc, {
      tui,
      theme: theme as unknown as ViewerTheme,
      markdownTheme: getMarkdownTheme(),
      history: session.history,
      fullscreen,
      onSubmit: (intent) => submit(session, intent),
      onUndo: () => stepHistory(session, "undo"),
      onRedo: () => stepHistory(session, "redo"),
      // pi-vim when installed, pi's own editor otherwise. Built fresh per press
      // so the composer never inherits a half-finished draft.
      createEditor: () => {
        const editorTheme = {
          borderColor: (text: string) => theme.fg("border", text),
          selectList: getSelectListTheme(),
        };
        try {
          const factory = ctx.ui.getEditorComponent();
          return factory ? factory(tui, editorTheme, keybindings) : new Editor(tui, editorTheme);
        } catch {
          return null;
        }
      },
      onCopy: (text, label) => {
        void copyText(text).then((result) => {
          if (!result.ok) {
            session.viewer?.setStatus(`clipboard unavailable (${result.error ?? "no tool"})`, "error");
          } else if (result.via !== "clipboard") {
            session.viewer?.setStatus(`${label} copied via ${result.via}`, "info");
          }
        });
      },
      onClose: finish,
    });

    return session.viewer;
  }, fullscreen ? { overlay: true, overlayOptions: FULLSCREEN_OVERLAY } : undefined);
}

async function refreshFromDisk(session: OpenSession): Promise<void> {
  if (!session.viewer) return;
  const doc = await readDoc(session.path).catch(() => null);
  if (!doc || doc.rev === session.doc.rev) return;
  adoptDoc(session, doc);
}

// ---------------------------------------------------------------------------
// Intents
// ---------------------------------------------------------------------------

function submit(session: OpenSession, intent: ViewerIntent): void {
  const viewer = session.viewer;
  if (!viewer) return;

  // `e` is a direct edit: the user already typed the replacement, so there is
  // nothing to ask the agent. Line anchors make this exact, unlike the browser
  // build's fuzzy search for the selection in the source.
  if (intent.kind === "replace") {
    applyDirectEdit(session, intent);
    return;
  }

  const check = checkAnchor(session.doc, intent.anchor);
  if (check.state === "gone") {
    viewer.setStatus("that selection changed on disk — select it again", "error");
    return;
  }

  // A shifted anchor keeps its text but moved: re-point it at the same lines.
  const anchor =
    check.state === "shifted" && check.start !== undefined
      ? { ...intent.anchor, start: check.start, end: check.start + (intent.anchor.end - intent.anchor.start) }
      : intent.anchor;

  const prompt = buildPrompt(session.doc, anchor, {
    kind: intent.kind,
    instruction: intent.instruction,
    slide: intent.slide,
  });
  pending = { session, rev: session.doc.rev, kind: intent.kind };

  try {
    pi?.sendUserMessage(prompt, { deliverAs: "followUp" });
  } catch (error) {
    pending = null;
    viewer.setStatus(error instanceof Error ? error.message : String(error), "error");
  }
}

function applyDirectEdit(session: OpenSession, intent: ViewerIntent): void {
  const viewer = session.viewer;
  if (!viewer || intent.replacement === undefined) return;

  const check = checkAnchor(session.doc, intent.anchor);
  if (check.state === "gone") {
    viewer.setStatus("that selection changed on disk — select it again", "error");
    return;
  }

  const anchor =
    check.state === "shifted" && check.start !== undefined
      ? { ...intent.anchor, start: check.start, end: check.start + (intent.anchor.end - intent.anchor.start) }
      : intent.anchor;

  const from = session.doc.lineStarts[anchor.start];
  const current = rawRange(session.doc, anchor.start, anchor.end);
  if (from === undefined || session.doc.raw.slice(from, from + current.length) !== current) {
    viewer.setStatus("that selection changed on disk — select it again", "error");
    return;
  }

  const updated =
    session.doc.raw.slice(0, from) + intent.replacement + session.doc.raw.slice(from + current.length);

  writeFile(session.path, updated, "utf8")
    .then(() => {
      // Adopt immediately so the watcher sees the same revision and the undo
      // stack gets exactly one entry for this edit.
      adoptDoc(session, makeDoc(session.path, updated));
      viewer.setStatus(`replaced ${describeAnchor(anchor)}`);
      pi?.sendMessage({
        customType: "pi-office",
        content: `User replaced ${describeAnchor(anchor)} of ${basename(session.path)} directly in the viewer, without the agent.`,
        display: true,
      });
    })
    .catch((error) => {
      viewer.setStatus(error instanceof Error ? error.message : String(error), "error");
    });
}

async function stepHistory(session: OpenSession, direction: "undo" | "redo"): Promise<void> {
  const viewer = session.viewer;
  if (!viewer) return;

  const step = direction === "undo" ? -1 : 1;
  const next = session.history.index + step;
  if (next < 0 || next >= session.history.versions.length) {
    viewer.setStatus(direction === "undo" ? "nothing to undo" : "nothing to redo", "error");
    return;
  }

  const content = session.history.versions[next];
  try {
    await writeFile(session.path, content, "utf8");
  } catch (error) {
    viewer.setStatus(error instanceof Error ? error.message : String(error), "error");
    return;
  }

  session.history.index = next;
  // Adopt the written content before the watcher sees it, so the write is not
  // mistaken for an external edit and does not truncate the redo stack.
  const doc = makeDoc(session.path, content);
  session.doc = doc;
  viewer.setDoc(doc);
  viewer.setStatus(direction === "undo" ? "undone" : "redone");

  pi?.sendMessage({
    customType: "pi-office",
    content: `User ${direction === "undo" ? "undid" : "redid"} a change to ${basename(session.path)} in the artifact viewer.`,
    display: true,
  });
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function piOffice(api: ExtensionAPI) {
  pi = api;

  api.on("agent_start", () => {
    lastAssistantText = "";
    active?.viewer?.setAgentState(true);
  });

  api.on("message_update", (event) => {
    if (event.assistantMessageEvent?.type !== "text_delta") return;
    if (lastAssistantText.length > 6000) return;
    lastAssistantText += event.assistantMessageEvent.delta || "";
    active?.viewer?.setAgentState(true, lastLine(lastAssistantText));
  });

  api.on("agent_settled", async () => {
    const job = pending;
    pending = null;
    if (!job) return;

    const session = job.session;
    const viewer = session.viewer;
    if (!viewer) return;

    viewer.setAgentState(false);

    const doc = await readDoc(session.path).catch(() => null);
    const edited = doc !== null && doc.rev !== job.rev;
    if (doc && edited) adoptDoc(session, doc);

    if (job.kind === "explain") {
      viewer.setStatus(edited ? "explained (file also changed)" : lastLine(lastAssistantText) || "no explanation", "info");
    } else {
      viewer.setStatus(edited ? "file updated" : "agent finished without changing the file", edited ? "info" : "error");
    }
  });

  // Open an artifact as soon as the session starts. Handy when the file is
  // always the subject of the session, and the way the viewer is smoke-tested
  // without driving the editor:  PI_OFFICE_OPEN=notes.md pi
  api.on("session_start", (_event, ctx) => {
    const preset = process.env.PI_OFFICE_OPEN?.trim();
    if (!preset || ctx.mode !== "tui") return;
    void (async () => {
      const path = await resolveTarget(preset, ctx);
      if (path) await openArtifact(path, ctx);
    })();
  });

  api.on("session_shutdown", () => {
    active?.stopWatching();
    active = null;
    pending = null;
  });

  const openCommand = {
    description: "Open a text artifact in the terminal viewer and annotate it for the agent",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("pi-office: the viewer needs interactive mode", "error");
        return;
      }

      const target = args.trim();
      const picked = target ? await resolveTarget(target, ctx) : await pickArtifact(ctx);
      if (!picked) return;
      await openArtifact(picked, ctx);
    },
  };

  // Deliberately not named `/edit`: pi-retouche already claims it, and the
  // point of a distinct name is that both can be installed at once.
  api.registerCommand("office", openCommand);
}
