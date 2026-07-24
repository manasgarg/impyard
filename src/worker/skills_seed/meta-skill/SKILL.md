---
name: meta-skill
description: How skills work and how to write a good one — the format, how the index reaches your prompt, and how to propose changes. Use this when you want to add a skill, improve one, or understand why a skill isn't loading.
---

# Skills

A skill is a how-to guide for one kind of work. Your skills live at
`$HOME/skills` — one directory per skill, with a `SKILL.md` inside.
An index of every skill (its name and one-line description) is loaded
into your prompt automatically at session start; the full text loads
only when you read it. The habit that makes this work: before
starting a piece of work, check the index and read the matching
skill.

## The format

`SKILL.md` starts with YAML frontmatter and continues in plain
English:

```
---
name: research-workflow
description: How to organize a knowledge base — raw sources, atomic notes, indexes. Use when researching or filing findings.
---

# ...the guide itself...
```

- `name` — short, kebab-case, matching the directory name.
- `description` — one sentence saying what it covers and *when to
  use it*. This line is all most runs ever see; the body is read only
  when it's relevant. Write it for the moment of choosing.
- A directory containing `SKILL.md` is one skill. Reference files can
  sit beside it and be pointed to from the guide.

## What makes a skill good

- It teaches a **procedure** — how to do a kind of work. What a place
  contains belongs in that place's README, not in a skill.
- It documents how things actually work **today**. A skill describing
  machinery that doesn't exist yet is fiction, and fiction here is
  expensive.
- It's short and plain. If it can't be read in a minute, cut it or
  split it.
- It doesn't restate what the system already enforces or what a
  tool's own description says — mounts, gates, and error messages
  teach those at the right moment. The practices worth writing down
  are the ones nothing will ever error about.

## Changing skills

`$HOME/skills` is a git checkout on a branch named for this run, and
it is yours to edit in any run kind. The cycle:

1. Edit or add `<skill>/SKILL.md`; `git add` and `git commit` in
   `$HOME/skills`.
2. Call `skill_push`. The host validates before anything lands —
   well-formed frontmatter (a broken `name:` or missing `description:`
   would silently drop the skill from your index, so it is refused
   instead), plain text files, size caps — then fast-forwards the
   shared history.
3. "stale: main moved" means another run landed first:
   `git fetch origin && git rebase origin/main`, then push again.

Push before the run ends — unpushed skill edits vanish with the run.
Every landing is journaled, and `git log` in the checkout is the
history.

## If a skill isn't loading

The index is rebuilt from `$HOME/skills` at each session start. A
skill missing from the index usually has malformed frontmatter —
check the `name` and `description` lines first.
