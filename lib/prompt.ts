/**
 * The agent-facing half of an annotation.
 *
 * A line-anchored selection lets us hand the agent the exact `old_string` it
 * will need, which is the single biggest reliability win over a rendered-DOM
 * selection: no fuzzy re-matching, no guessing which of three identical
 * paragraphs the user meant.
 */

import type { Anchor } from "./anchor.ts";
import { describeAnchor } from "./anchor.ts";
import type { SlideContext } from "./slides.ts";
import type { DocKind, SourceDoc } from "./source.ts";

export interface PromptOptions {
  kind: "edit" | "explain";
  instruction: string;
  slide?: SlideContext;
}

const FENCE_LANG: Record<DocKind, string> = {
  markdown: "markdown",
  html: "html",
  text: "text",
};

export function buildPrompt(doc: SourceDoc, anchor: Anchor, opts: PromptOptions): string {
  const where = describeAnchor(anchor);
  const lines: string[] = [];

  lines.push(
    `Edit request for ${doc.name} (${doc.path}) from the artifact viewer.`,
    `The user selected ${where} of that file (revision ${anchor.rev}); it currently has ${doc.lines.length} lines.`,
  );

  const slide = opts.slide;
  if (slide) {
    lines.push(
      "",
      `${slide.whole ? "The selection is" : "The selection is inside"} slide ${slide.number} of ${slide.total} — "${slide.title}".`,
      "The file is a Markdown slide deck: slides are separated by lines containing only `---`,",
      "and the deck's frontmatter is not a slide. Keep the change on this slide unless the",
      "instruction clearly applies to the whole deck, and do not remove or add `---` separators.",
    );
  }

  lines.push(
    "",
    `Selected source, ${where}, verbatim:`,
    "```" + FENCE_LANG[doc.kind],
    anchor.text,
    "```",
  );

  if (opts.kind === "explain") {
    lines.push(
      "",
      `Request: ${opts.instruction.trim() || "Explain this selection."}`,
      "",
      "Do not modify the file. Reply with a concise explanation; your reply is shown in the viewer.",
    );
    return lines.join("\n");
  }

  lines.push(
    "",
    `Instruction: ${opts.instruction.trim() || "(none given)"}`,
    "",
    "Apply the change now by editing the file directly with your edit tools.",
    "Use the selected source above as the exact `old_string` — it is copied byte-for-byte, including",
    "indentation and blank lines. Change only what the instruction asks for; leave surrounding lines,",
    "formatting, and line endings untouched so the selection stays anchored.",
    "Do not paste the revised document into chat: the file on disk is what the viewer shows.",
  );

  return lines.join("\n");
}
