---
marp: true
paginate: true
theme: default
---

<!-- _class: lead -->

# Testing pi-office

One deck covering every code path — break it on purpose.

<!-- speaker notes: this line must not appear in presentation mode -->

---

## What to press

- `]` and `[` move between slides, in source and presentation
- `p` presents the current slide; `esc` goes back to source
- `v` starts a visual selection, then `r` `l` `m` `e` `x` act on it
- With nothing selected, the quick actions act on the **whole slide**
- `u` undoes the agent's last write to this file

---

## A code block with a fake separator

The `---` below is inside a fence. It must not split this slide.

```ts
const boundaries = parse(lines);

---
// three dashes at the start of a line, but inside a fence
render(boundaries);
```

> Rule of thumb: `***` and `___` are horizontal rules in a deck. `---` is a page break.

---

## A table

| Feature | Key | Works on |
| --- | --- | --- |
| Navigate | `]` `[` | source, presentation |
| Present | `p` | paginated files only |
| Force slides | `s` | any Markdown with `---` |
| Annotate | `r` `l` `m` `e` `x` | selection, slide, or line |

---

## A slide that overflows

This one is longer than a terminal window, so it exercises scrolling. Press `j`
a few times, then `ctrl+d`, then `G`. The header should show your progress
through the rendered rows.

- Row one of the long body
- Row two of the long body
- Row three of the long body
- Row four of the long body
- Row five of the long body
- Row six of the long body
- Row seven of the long body
- Row eight of the long body
- Row nine of the long body
- Row ten of the long body
- Row eleven of the long body
- Row twelve of the long body
- Row thirteen of the long body
- Row fourteen of the long body
- End of the long body — if you got here with `j`, scrolling works.

---

## Notes stay hidden

Everything you can read here is real slide content.

The comment below is a speaker note. In presentation mode it should disappear;
in source mode you should see it as a line starting with `<!--`.

<!-- notes: delete this line with the agent to prove the anchor is exact -->

---

## Done

- [x] Pagination works without a single new Markdown dialect
- [x] Presentation hides directives and notes
- [x] A slide is a line range, so it is also an anchor
- [ ] Rewrite this slide with `l` and watch the revision change
