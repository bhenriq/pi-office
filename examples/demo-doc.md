---
title: The same notes, not paginated
author: you
date: today
---

# Testing pi-office

This is the same material as `examples/demo-deck.md`, written as a normal
document. The only difference is the frontmatter: it has no `marp: true`, no
`paginate: true`, so pi-office treats the whole file as one surface.

Press `p` here and you get a pager over the entire document. Press `p` in the
deck and you get one slide at a time. That is the whole distinction.

## What stays the same

- `v` then `r` `l` `m` `e` `x` works identically in both files
- `u` and `ctrl+r` undo and redo the file the same way
- annotations carry exact line numbers either way
- the header shows the revision, and the footer shows what the next key will do

## The three dashes below are just a rule

Nothing about this line makes the file a deck:

---

Without an opt-in in frontmatter, `---` is a horizontal rule, exactly as
Markdown intends. This is why pagination is explicit: plenty of real documents
use `---` between sections, and silently turning those into slides would be
wrong.

## It still parses as slides if you ask

Press `s` in this file. The `p` key switches from "pager" to "present", `]` and
`[` start working, and the footer changes to `slide n/N`. Press `s` again and it
is a plain document once more.

The parser was always able to find the boundaries — `---` at the start of a line,
ignoring fences — it just waits to be told that they mean pages.

## A fence is still a fence

```ts
const boundaries = parse(lines);

---
// a fake separator, inside a fence
render(boundaries);
```

## A table, for scroll testing

| View | `p` shows | `]` works |
| --- | --- | --- |
| this file | whole document | only after `s` |
| demo-deck.md | one slide | yes |

---

## End

That was the last rule. Everything below is ordinary Markdown again.
