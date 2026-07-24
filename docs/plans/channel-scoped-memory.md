# Plan: channel-scoped memory

Status: proposal (2026-07-21) — extends
[prompt-architecture.md](prompt-architecture.md); picks up the item
[channel-semantics.md](channel-semantics.md) deferred: memory moves
into channel stores.
Scope: memory becomes a record of the conversation, not of the worker —
stored in the channel's store, written only from that channel's
interactive runs, mounted read-only into tasks the channel filed,
absent elsewhere. Includes recall changes, the clean-room decision,
migration, and the seeded memory skill.

## Motivation

Today memory is worker-global (`store/memory/memory.jsonl`): every
run recalls from one file, and the rule that one room's confidences
don't surface in another is conduct, not structure. Making memory
channel-scoped turns that discretion into a mount: a room's memory
physically stays with the room. It also completes a symmetry the
system already half-has — conversations write person-space and read
world-space; tasks write world-space and read person-space.

## The model

Memory is a **record** (in prompt-architecture's terms): host-parsed
format, host-compiled recall, edited only through its operations. What
changes is ownership and reach:

| Run kind | Memory access |
|---|---|
| Conversation (interactive) | read-write — the only place memory is written |
| Task filed from a channel | that channel's memory, mounted read-only |
| Run with no origin conversation (heartbeat, self-filed task) | none — by design |

The file lives in the channel store:
`channel/store/memory/memory.jsonl`, per (worker × logical channel) —
linked surfaces share one memory once channel-semantics' linking
lands. The record format is unchanged (id, ts, kind, note,
scope/scope_id, pinned; supersede by id; `op: "forget"`).

What memory holds narrows to the conversation: its people, their
preferences, what was decided. Person-free learnings about how to
work belong in the worker prompt, skills, or store notes, which
travel everywhere. Memory does not travel.

## Decisions proposed

1. **Memory is a channel-store record** at
   `channel/store/memory/memory.jsonl`. The worker-global
   `store/memory/` stops being host-read.
2. **Writes only from interactive runs** of the owning channel. Tasks
   get a read-only mount; a task that learns something worth keeping
   reports it to the room, where the next interactive run records it.
3. **Recalled or mounted memory does not taint a task.** The
   clean-room rule for gated repos keys on raw conversation content;
   memory is the worker's own distillation, and the participant scan
   still checks every push and task prompt. (This is strictly *less*
   person-content in pushing runs than today, where global memory —
   all channels' facts — rides into every run.) Raw channel messages
   still taint.
4. **Recall compiles only from the run's channel.** No channel, no
   memory block.
5. **Curation is conversation work** — quiet turns or session
   wind-down — since tasks can't write. Whether wind-down gets a
   closing turn is an open question below.
6. **Migration splits the global file by `scope_id`.** Notes carrying
   a channel-shaped scope move to that channel's store; unscoped
   residue parks in `store/memory/legacy.jsonl` for the worker to
   triage (most of it is how-to-work preference that belongs in the
   worker prompt anyway).

## Implementation changes

- **Mounts** (`src/run/boxed.rs`): channel stores already mount
  read-write inside the read-only channel mount. For task runs with an
  origin channel, add a nested read-only bind of
  `channel/store/memory/` inside the read-write channel store — same
  nesting trick the store-inside-channel mount already uses. Tasks
  filed "clean" from a channel, which today mount nothing
  conversational, now mount exactly the memory directory, read-only.
- **Recall** (`src/worker/memory.rs` `recall_notes`,
  `src/worker/context.rs` `memory_block`): source moves from the
  worker store to the run's channel store, resolved through the run's
  provenance (`RunContext` already records provider/channel/user; the
  task path already plumbs it via `save_run_context`). The block's
  self-description changes to name
  `$HOME/channel/store/memory/memory.jsonl`. No channel context → no
  block.
- **Briefing text** (`src/worker/context.rs` per-surface strings): the
  channel and task briefings say the conversation's memory is mounted
  and where; the "clean task" variants say a read-only memory of the
  origin conversation is included.
- **Policy** (`[memory]` in org.toml): unchanged — per-worker recall
  bounds apply to whichever channel file the run recalls from.
- **Snapshots**: nothing to do — the channel-store subtree already
  rides the store snapshot rotation.
- **Docs** (post-implementation, per product-docs practice):
  memory.md, store.md, channels.md describe the new home and access
  rules.
- **Seeds** (prompt-architecture): the memory skill below ships in
  `store/skills/memory/`; the worker prompt seed's "one conversation's
  confidences" line stays as the judgment that remains.

## Migration

One pass per worker at upgrade: read `store/memory/memory.jsonl`,
route each note by its `scope_id` (`discord:<id>`, `term:<name>`, …)
to the matching channel store's memory file, preserving order and
records verbatim; leave unrouteable notes in
`store/memory/legacy.jsonl` and note the split in the worker's
journal. The old file stays as a backup alongside; recall simply stops
reading it.

## The seeded skill

`store/skills/memory/SKILL.md`, as shipped:

```markdown
---
name: memory
description: How to read, write, and maintain a conversation's memory — the durable notes about its people, preferences, and decisions. Use this when recording something worth keeping, when updating or forgetting a fact, or when tidying memory as a conversation winds down.
---

# Memory

Memory belongs to a conversation, not to you. Each conversation you
serve has its own memory in that conversation's durable space:
`channel/store/memory/memory.jsonl` — one JSON record per line. A
bounded window of it (pinned notes first, then newest) is compiled
into your runs there automatically; when the window isn't enough,
read the file.

Access follows the kind of run you're in:

- **In a conversation**: read-write. This is the only place memory is
  ever written.
- **In a task filed from a conversation**: mounted read-only. Use it;
  don't try to write it. If the task teaches you something worth
  keeping, put it in your report to the room — you can record it next
  time you're there.
- **In a run with no origin conversation** (a heartbeat, a self-filed
  task): there is no memory. That's by design, not an error.

Memory holds the conversation: its people, their preferences, what
was decided. What you learn about *how to work* — tools, formats,
workflows, nothing about people — doesn't belong here; it goes in
your notes (`store/prompt.md`) or your skills, which travel
everywhere. Memory does not travel: a room's memory stays with the
room.

## When to write a note

Write a note when you learn something a future run in this
conversation should know: a preference, a fact about a person, a
decision that was made. One fact per note, in plain words,
self-contained — a note that needs the conversation around it to make
sense is not done.

## The record

{"id":"lead-digest-day","ts":"2026-07-17T17:46:00Z","kind":"preference","note":"The lead prefers weekly digests on Friday mornings.","scope":"user","scope_id":"discord:1234"}

- `id` — a short stable slug you choose. This is the note's handle:
  without it, the note can never be updated or forgotten. Always set
  one.
- `ts` — when you learned it (RFC3339 UTC).
- `kind` — `fact`, `preference`, or another word you use
  consistently.
- `note` — the fact itself.
- `scope` / `scope_id` — who the note concerns, when it concerns one
  person in the room. With `ts`, this is the note's lineage; a note
  without lineage can't be trusted or cleaned up later.
- `pinned` — `true` keeps a note at the front of the recall window.
  Pin sparingly: a pin is a claim that every future run here needs
  this.

## Updating and forgetting

The file records changes; it doesn't rewrite history.

- **A fact changed?** Append a new record with the **same `id`**. The
  newer record wins; the old line stays as history.
- **Something should be forgotten?** Append `{"id":"...","op":"forget"}`.
  The note drops out of recall. Never silently delete a line — an
  explicit forget record is how future-you knows it was deliberate.

Only one of your sessions serves a conversation at a time, so
contention is rare. Still: append whole lines, and if you compact the
file (rewriting it without long superseded chains — do this rarely),
hold the lock: `roster-lock memory -- <command>`.

## The boundary

You physically cannot read one room's memory from another — that
boundary is the platform's, not yours to manage. Your remaining
judgment is at the edges: nothing about people goes into your global
store, your skills, repo files, or task prompts. The host scans the
last two and refuses them; the first two are on you.

## Tidying

Tasks can't write memory, so tending it is conversation work: in a
quiet moment or as a session winds down, supersede what changed,
forget what stopped being true, unpin what no longer earns the front
of the window. Memory is useful in proportion to how much you can
trust it.
```

## Open questions

- Per [persistence-architecture.md](persistence-architecture.md)
  (GOVERNED), memory's implementation becomes a per-channel governed
  git repo: notes land as small host-validated commits (record schema
  checked before apply), the interactive run's mount is a run-branch
  worktree, and the task-run mount is a read-only checkout — replacing
  this plan's raw-jsonl-plus-nested-bind mechanics. The access rules
  and skill semantics here are unchanged; fold the mechanics in when
  the engine lands.

- Person-facts that span conversations (the lead in the terminal and
  in a Discord DM): duplicated per channel until identity linking
  (channel-semantics) merges those surfaces into one channel, or
  simply not carried across?
- Memory curation can only happen in interactive runs — is the session
  wind-down the hook, and does that need a closing turn?
- Should recall bounds ever become per-channel (a busy room may earn a
  bigger window than the org default)?
