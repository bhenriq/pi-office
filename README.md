# pi-office

Read and annotate a text artifact inside pi's own TUI. Select source lines, press
one key, and the agent applies the change to the file while you watch it update.
Paginated Markdown decks get slide navigation and a presentation mode, and "the
slide" is a valid annotation target.

No browser, no localhost server, no second process: the viewer is a pi TUI
component running in the session that owns the file, hosted as a full-screen
overlay so it owns every cell of the terminal while it is open.

```
/office notes.md
```

## Why line anchors

A terminal selects whole lines cheaply and unambiguously, and it knows their
numbers. So every annotation carries:

- the inclusive line range,
- the exact source text of that range,
- the file revision it was made against.

The agent gets that text as its `old_string`, byte for byte. No fuzzy re-matching
of a rendered DOM, no guessing which of three identical paragraphs the user meant.
If the file changed under the selection, the anchor is re-pointed (if the text
moved) or rejected (if it is gone) instead of silently editing the wrong place.

## Keys

| Key | Action |
| --- | --- |
| `j` / `k`, arrows | move one line |
| `ctrl+d` / `ctrl+u` | half page |
| `ctrl+f` / `ctrl+b` | page |
| `g` / `G` | first / last line |
| `v` | start or clear a visual selection |
| `r` | remove the selection (or the cursor line) |
| `l` / `m` | say it shorter / longer |
| `e` | replace the selection with text you type — applied directly, no agent |
| `o` / `enter` | other: describe the change in words and the agent applies it |
| `x` | explain — the agent replies without editing |
| `u` / `ctrl+r` | undo / redo the file, server-side |
| `p` | pretty mode, or presentation mode in a deck |
| `]` / `[` | jump to next / previous slide (decks only) |
| `s` | force slide mode on or off |
| `h` / `?` | keybinding help (any mode; `esc` or `q` closes it) |
| `q` / `esc` | close; `esc` first clears a selection, then leaves pretty or presentation, and only then quits |

Switching between source and a rendered view keeps your place: the cursor's
source line is mapped to its rendered row (and back), so `p` lands on the content
you were reading, and `p` again returns to that line — including after scrolling
in the rendered view. Lines with nothing to render (a blank line, a rule, a
comment) land on the nearest content in the same slide or paragraph.

`h` opens a scrollable keybinding reminder from any mode. While it is open it
swallows every other key, so a stray `r` while reading the help cannot edit the
file.

## Modes

- **source** — the file line for line with line numbers and light syntax
  dimming. One screen row is one source line, which is what makes anchors exact.
  This is the mode that produces intents.
- **presentation** — one slide at a time, rendered. `j`/`space` scroll a long
  slide and advance to the next once it has nothing left to show; `k` mirrors
  that; `]`/`[` always jump. A slide that fits therefore behaves like a
  slideshow. Only
  offered when the file is paginated. Because a slide is a line range, pressing a
  quick action with nothing selected acts on **the whole slide** — the footer says
  `r l m e o whole slide` so it is never ambiguous. `e` is the exception: a typed
  replacement stays on the cursor line rather than rewriting a whole slide.
- **pretty** — the same content rendered through pi's own `Markdown` component,
  using the active theme. Read-only, for looking at prose. There is no cursor
  there, so it behaves like a pager: `j`/`k`, `ctrl+d`/`ctrl+u`, `g`/`G` move the
  view, and the header shows the current rendered row (`PRETTY 12/82`).

## Decks

Any Markdown file that opts in through frontmatter paginates, using Marp's
conventions — no new syntax:

```markdown
---
marp: true          # or: paginate: true / slides: true / deck: true
theme: default
---

# Slide one

---

# Slide two
```

- A line containing only `---` separates slides. `---` inside a fenced code block
  does not.
- Frontmatter is not a slide, and horizontal rules in a deck stay `***` / `___`.
- Titles in the header and footer come from each slide's first heading.
- HTML comments (`<!-- _class: lead -->`, Marp directives, speaker notes) are
  hidden in presentation mode and shown in source mode.
- If a deck-ish file has no frontmatter, `s` forces slide mode for the session.

Navigating slides moves the cursor, so the anchor always lands on the slide you
are looking at, and the file keeps its exact line numbering.

Two fixtures, meant to be read side by side:

- `examples/demo-deck.md` — seven slides that opt in with `marp: true`. Exercises
  a fenced `---` that must not split a slide, a table, a slide that overflows the
  viewport, and directive/speaker-note comments that vanish in presentation.
- `examples/demo-doc.md` — the same material with frontmatter that does *not* opt
  in. It opens as one document (`p` pages the whole file, `]` does nothing) until
  you press `s`, which is the clearest way to see what pagination actually adds.

## How a change flows

All five actions are one keystroke on the selection: `r` remove, `l` less,
`m` more, `o` other (words to the agent), `x` explain. `e` is the exception and
never reaches the agent at all — it is a typed replacement applied to the file
directly, which line anchors make exact, and it lands on the undo stack like any
other write so `u` reverts it.

1. You press `l` on lines 12–18.
2. The extension checks the anchor against the current file and sends a follow-up
   user message containing the exact selected source.
3. The agent edits the file with its normal tools.
4. A file watcher notices the new revision, the viewer re-renders, and the status
   line says `file updated`.

The file on disk is the single source of truth at every step. The viewer holds a
snapshot and never buffers edits of its own, so there is exactly one writer.

## Install

Requires pi 1.5.2 or newer (it uses `ctx.ui.custom()` overlays and the
`agent_settled` / `session_start` events). There is no build step and no runtime
dependency: pi supplies `@earendil-works/pi-tui` and `pi-coding-agent`, so a
checkout is ready to load as-is.

**From git** — the same shape as the other extensions in this setup, and the only
route that gets updates:

```bash
pi install git:github.com/<you>/pi-office
pi update --extensions          # later, to pull changes
pi remove git:github.com/<you>/pi-office
```

**From a copy** — no repository needed, e.g. between two laptops:

```bash
rsync -a --exclude node_modules ./pi-office/ other-laptop:~/Documents/Dev/pi-office/
pi install ~/Documents/Dev/pi-office
```

A local path is loaded in place (never copied), so edits there take effect on
`/reload`. A `git:` install is a clone that `pi update --extensions` reconciles.

**From npm**, if you ever publish it (the name is free):

```bash
npm publish && pi install npm:pi-office
```

Either way, `/office` appears after a fresh start or `/reload`.

## Development

Only needed to hack on it, not to use it:

```bash
npm install --legacy-peer-deps   # typescript + @types/node
npm run link                   # symlinks pi's own packages for typechecking
npm test                       # alignment round trips + every preview mode
```

`scripts/link-pi.mjs` finds the running pi installation (managed
`~/.pi/agent/install/current-version`, or `PI_AGENT_DIR`) and links
`@earendil-works/*` into `node_modules`. That is why `package-lock.json` is
ignored: it would record absolute paths to one machine's pi install.

## Environment

| Variable | Effect |
| --- | --- |
| `PI_OFFICE_OPEN` | Path of an artifact to open when the session starts. Useful when a file is the whole point of the session, and how the viewer is smoke-tested without driving the editor: `PI_OFFICE_OPEN=notes.md pi -e ./index.ts` |
| `PI_OFFICE_INLINE=1` | Keep pi's chrome visible instead of taking the whole screen. The viewer then renders inside pi's layout, with the transcript above and the status line below still on screen |

## Development

```bash
node scripts/preview.ts             # source mode with a selection
node scripts/preview.ts pretty      # rendered Markdown
node scripts/preview.ts deck        # slide navigation in source mode
node scripts/preview.ts present     # one rendered slide
node scripts/preview.ts html 60 14  # custom width and height
```

The preview is a real layout test: it builds the component with a stub TUI, drives
it with keystrokes, and fails if any returned line is not exactly the requested
width. Layout bugs show up there instead of in a live session.

```bash
npm test        # alignment round trips + every preview mode
```

`scripts/align-check.ts` asserts the contract that makes the two views feel like
one: toggling to a rendered view and back must return the cursor to the same
content.

## Notes and limits

- **tmux users:** pi needs `set -g extended-keys on` and
  `set -g extended-keys-format csi-u` in `~/.tmux.conf` (tmux ≥ 3.5), otherwise
  tmux reports plain `Enter` as `ctrl+j` and it inserts a newline instead of
  submitting. This affects all of pi, not just this extension.
- The command is `/office`, not `/edit`, so it can coexist with pi-retouche.
- Typed instructions need the editor's submit key, and a one-key quick action
  (`r`/`l`/`m`/`x`) needs nothing, so the common cases never leave the viewer.
- `x` (explain) shows the reply on one status line. The full answer is in the
  transcript after you close the viewer.
- Undo/redo rewrite the file, so it is real file-level history — the same model
  as `pi-retouche`. The stack is per-session and starts when the file is opened.
