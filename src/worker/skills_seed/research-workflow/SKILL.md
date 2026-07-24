---
name: research-workflow
description: How to build and maintain a knowledge base — raw sources, atomic notes with provenance, theme indexes, and synthesized digests. Use this when researching, filing findings, or reorganizing knowledge.
---

# Research

## Reading sources

For anything current, fetch and read the source itself — never rely
on search-result previews. When a source matters, keep a copy: raw
material saved into the knowledge base means your notes outlive link
rot.

## The shape of a knowledge base

- **artifacts/** — raw source material, unedited: pages, documents,
  data.
- **Atomic notes** — one idea per note, Markdown with YAML front
  matter, each pointing back to its source URL or artifact. A note
  that can't name its source can't be trusted later — provenance is
  what makes a note usable.
- **Indexes** — theme and topic pages linking the atomic notes. This
  is how a future run finds things; an unindexed note is half-lost.
- **Syntheses** — digests, reports, articles that articulate a view,
  built from atomic notes and citing them. When the underlying notes
  change, regenerate the synthesis rather than patching it.

Prune what stops being true: supersede notes, keep indexes current.

## Where it lives

The org's knowledge repo mounts under `$HOME/mnt/` — the dev-workflow
skill covers the git mechanics (read in conversations, write and land
from tasks, push before wrap-up). Before working in a repo, read the
repo's own README: the layout recorded there is the truth of how it's
organized, and it wins over this skill's defaults.

## Reporting

When you report findings, cite the underlying sources, not your notes
about them.
