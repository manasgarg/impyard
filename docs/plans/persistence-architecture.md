# Plan: persistence architecture — protocols, access, meaning

Status: proposal (2026-07-24) — companion to
[prompt-architecture.md](prompt-architecture.md) and
[channel-scoped-memory.md](channel-scoped-memory.md); absorbs the
"store's primitives" section from the former.
Scope: one framework for every durable surface a worker touches. Three
layers with a hard boundary between them: the **host** guarantees data
integrity through a small catalog of mutation protocols; **access
rules** (host-enforced read/write by run kind) follow provenance and
must never contradict a surface's protocol; **meaning** — how a class
of data is interpreted and organized — belongs to the agent, documented
as skills.

## The three layers

**1. Integrity (host).** The host's entire role in persistence is three
concerns: **schema** (is the data well-formed), **concurrency** (do
simultaneous writers corrupt it), and **recoverability** (can a bad
state be walked back). The host offers a small set of protocols that
cover these in different combinations; a surface picks one. The host
never interprets content beyond what its protocol needs.

**2. Access (host).** Read/write rules per run kind, enforced by
mounts. They follow one rule — *a surface is writable where its truth's
author is present* — and one constraint: access must adhere to the
protocol (a surface whose only legitimate write path is an operation
mounts read-only everywhere; a landing-validated repo never mounts
writable where landing can't be validated).

**3. Meaning (agent).** What the bytes are *for*: how research is
organized, what a memory note should say, when to prune. The host is
meaning-blind by design. Every class of data gets its standard
operating procedure as a skill, and a skill never restates layer 1 or
2 — the protocol and mounts already enforce them; the skill teaches
what to do inside the space.

## The protocols, enumerated

Standing principle (decided 2026-07-24): wherever the host is involved
in a write, it validates **before** applying — nothing invalid ever
lands. (This upgrades `file_update`, which today writes, validates,
and reverts.)

There are exactly **three** protocols — one per answer to "who
guarantees integrity?": nobody but the worker (RAW), the host
(GOVERNED), an external platform (DELEGATED).

### RAW — the worker's own discipline

In-place writes to mounted storage. The host is meaning-blind;
it promises durability and snapshots, nothing else. Safety rests on
two *independent* mechanisms, and it matters which one covers what:

- **Exclusion among writers**: named advisory locks — `roster-lock
  <name> -- <command>` takes an flock(2) on `store/.locks/<name>`.
  The lock file's inode is shared through the bind mount, so one lock
  excludes every other instance of the worker; the kernel releases it
  if the holder dies. Names are flat, worker-chosen, voluntary.
- **Consistency for readers**: atomic replace (write a temp file,
  rename over the original). This — not the lock — is what protects
  any instant-in-time reader, including the host's snapshot pass,
  which does *not* honor named locks.

Who takes which lock, at which level: **boxes** take fine-grained
named locks around read-modify-write sequences; the **host** takes
exactly one lock inside the store — the whole-store lock
`.locks/store` — and only for snapshot/restore. A box may hold that
same name (`roster-lock store`) to exclude the backup pass across a
multi-file operation that a single rename can't make atomic; keeping
in-store git repos bare is the other half of that discipline. Locks
are coordination, not content: snapshots exclude `.locks/`. (The
host's own serialization — integration lanes, statefiles — lives in
host `state/`, never in the store.)

Worker-kept git history (bare project repos) is a *convention inside
RAW*, not a separate protocol: the host's guarantees don't change
because the worker versions its own files.

Surfaces: store working files, `store/prompt.md`, worker project
repos, channel-store files (whose session-plus-filed-tasks overlap is
covered by exactly this lock-and-rename discipline — the
single-live-session property alone is not the guarantee).

### GOVERNED — the host's engine

Design (2026-07-24): **every governed surface is a host-side git
repo.** State is the head of `main`; a version *is* a commit id;
history is the audit trail and the recovery mechanism; the engine is
the knowledge-repo machinery, generalized. No surface invents its own
storage or versioning again.

**Storage.** One bare repo per surface, on the host, `gc.auto` off:
worker-scoped surfaces under the worker's data dir (schedule, config,
identity, skills), channel-scoped surfaces under the channel store
(memory), org-record repos where they are today. The worker never
touches a canonical — it sees materialized checkouts.

**Two submission styles** — the only real fork in the engine:

- **rwf (the research workflow — land a branch).** The run gets a
  worktree checkout on a run-named branch; the worker commits with
  ordinary git; submit hands the branch to the host. Precondition:
  descends from current `main` ("stale: main moved" → fetch, rebase,
  resubmit). The host validates and fast-forwards. For tree-shaped,
  multi-file content: knowledge and org records, skills, memory.
- **cas (check-and-set — swap a document).** No working branch: the
  worker submits the complete replacement plus the base head id; the
  host validates, commits, advances `main`. A stale base fails with
  the current head and document. For single-document, machine-parsed
  state: schedule, config, identity, purpose.

**Validators** — a composable pipeline, identical slots for both
styles, always run *before* apply: structural schema (record shapes,
TOML/JSON parse), semantic (the whole config must validate; the task
partition's rules — host-owned entries untouchable), content scans
(participant scan), policy caps (sizes, bulk-delete thresholds), and
**human gate** — a validator outcome that parks the submission as a
pending gate and applies on approval. Gating is not a separate
protocol; identity is just a cas surface whose pipeline always ends
in a gate.

**Serialization.** One integration lane per surface — an flock in
host `state/` (the knowledge repo's lane locks, generalized).
Validate-and-apply is atomic per surface; run-branch isolation means
workers never contend on a checkout.

**Views.** What mounts into the box is always a checkout, never the
canonical: a run-branch worktree where the surface is writable in
this run kind, a read-only checkout of `main` where it isn't.
Single-document surfaces keep their familiar rendered paths
(`self/schedule.json`, `self/config/worker.toml`) as read-only views;
the repo is behind the curtain.

**Access composes independently — the key unlock.** The protocol says
*how* a write lands; the access layer says *from which run kinds the
engine accepts submissions* for that surface. Host-canonical git no
longer implies read-only-in-conversations — that was the org-record
access rule, not a property of the machinery:

| Surface | Style | Submissions accepted from | Pipeline (before apply) | View in the box |
|---|---|---|---|---|
| skills | rwf | **every run kind** (mine-truth) | size caps | worktree at `$HOME/skills` |
| org records (knowledge) | rwf | clean tasks only (org-truth) | participant scan, bulk-delete gate | worktree at `mnt/<name>` |
| memory (per channel) | rwf, per-note landings | that channel's interactive runs (room-truth) | record schema + log rules | worktree at `channel/store/memory`; read-only snapshot in origin tasks |
| schedule | cas | every run | partition schema + rules | `self/schedule.json`, read-only |
| config | cas | every run | TOML + whole-config validation | `self/config/worker.toml`, read-only |
| identity, purpose | cas | every run, always gated (lead-truth) | caps + human gate | `self/`, read-only |

Memory lands per note — small commits, auto-validated, cheap — so a
note is durable the moment it's accepted; a crash loses only the
uncommitted. Compaction is one more landing.

**Synthesized artifacts.** rwf carries one convention beyond raw
sources: *derived, bounded documents* — a synthesis produced from
source material and landed like any other change. Reports and
position papers synthesized from the knowledge base, blog posts from
research notes, and memory's bounded digest synthesized from the raw
note log are all the same mechanism. The synthesis itself is
meaning-layer work (the agent's, guided by the relevant skill); the
host's part is a validator enforcing the bound (memory's digest must
fit the recall budget) and an ordinary landing. For memory this
replaces compaction: raw notes are never rewritten — the digest
regenerates beside them, and recall compiles from the digest plus the
newest raw notes, so history stays whole.

**What this supersedes.** Three earlier decisions improve:

- **Skills leave the store** for a host-canonical governed repo,
  landable from every run kind. The in-store-checkout exception
  disappears; every skill edit is an attested landing (resolving
  "should skill edits surface to the lead" — the journal gets them
  for free); and seed upgrades become host commits on a branch of the
  canonical for the worker to merge — no read-only seed pack under
  `self/` needed. pi still reads `$HOME/skills`; it's a worktree now.
- **Memory's implementation** switches from raw jsonl plus a nested
  read-only bind to a per-channel governed repo
  (channel-scoped-memory.md updates accordingly); the access rules it
  defined are unchanged.
- **`set_tasks` and `file_update`** become cas submissions;
  `base_version`/`base_hash` unify into the head commit id, and
  `file_update` gets validate-first by construction.

**Build path.** Generalize the knowledge machinery into the engine
(descriptor table, lanes, validator pipeline); adopt surfaces
one at a time — skills first (new surface, no migration), then
schedule and config (cas over git), then memory (with the
channel-scoped-memory rollout); org records are already there.

### DELEGATED — an external platform's engine

The canonical lives outside the host (GitHub). Writes are ordinary
git through the gateway, credentials injected in transit; validation,
serialization, and history are the platform's (branch protection,
review, CI).

The host's contribution (decided 2026-07-24): a local read cache. Per
connected repo, the host maintains a **bare mirror**, refreshed on a
fetch policy (run start and/or interval), and provisions per-run
**worktrees** from it, mounted like `mnt/` checkouts. Reads — the
majority of operations — are local and instant, no remote clone per
run. A run's view may lag the remote and is labeled with its fetch
time. The write path is unchanged: push to the remote through the
gateway; the mirror catches up on the next fetch. This unifies the
checkout experience across GOVERNED-tree and DELEGATED — same
worktree UX, different landing (`repo_push` vs push/PR).

## Access rules

Writability follows provenance — who authors this truth, and are they
present in this run?

| Whose truth | Writable | Read-only | Absent |
|---|---|---|---|
| **Mine** (store, skills, prompt) | every run — I'm always present | — | — |
| **The room's** (channel store, memory) | that channel's interactive runs | tasks the room filed (memory: the read-only mount) | runs with no origin room |
| **The org's** (host repos) | clean rooms — tasks, via landing | conversations (people present) | — |
| **The world's** (GitHub) | via the gateway, under grants | — | — |
| **The platform's** (self/: config, schedule, journal, runs) | never in place — operations only | every run | — |

The consistency requirement in both directions: an operation-only
surface mounts read-only (the mounted file is a view); a
landing-validated repo mounts as a branch checkout, never as the
canonical; raw surfaces may mount read-write exactly because the host
promises nothing about their content.

## The surface map

Every current surface, classified once:

| Surface | Protocol | Access (whose truth) | Skill |
|---|---|---|---|
| `store/` working files | RAW | mine | dev-workflow |
| `store/prompt.md` | RAW (host copies verbatim, never interprets) | mine | — |
| worker's project repos | RAW + own git (bare, worktree out) | mine | dev-workflow |
| `channel/store/` files | RAW | the room's | — |
| skills (`$HOME/skills` worktree) | GOVERNED : rwf, landable from every run kind | mine | meta-skill |
| `channel/store/memory/` | GOVERNED : rwf, per-note landings | the room's | memory |
| `self/schedule.json` | GOVERNED : cas (`set_tasks`) | platform-held, worker-directed | schedule |
| `self/config/worker.toml` | GOVERNED : cas (`file_update`) | platform-held | — |
| identity, purpose | GOVERNED : cas, always gated | the lead's | — |
| `mnt/<org repo>` | GOVERNED : rwf (`repo_push`) | the org's | research-workflow, dev-workflow |
| GitHub repos | DELEGATED (host mirror + worktree) | the world's | dev-workflow |
| `self/journal`, `self/runs/` | host-append (host only; no worker write path) | the platform's | self-improvement-workflow |

Adding a surface = answering three questions (whose truth? does the
host interpret it? which protocol fits?) and taking one row. No new
permutations.

## The mnemonic

The teaching version, for prompts and docs — five places:

- **Your desk** (`store/`): yours, always with you, arrange it freely.
- **The room's whiteboard** (`channel/store/` + memory): stays in the
  room; leaving for a task, you carry a photo.
- **The org's library** (host repos): read anytime; filings go through
  the librarian, and not while people are talking in your ear.
- **The printing press** (GitHub): publishing to the world.
- **Your personnel file** (`self/`): about you, not by you; read it,
  submit forms to change it.

Plus one wrinkle: anything the platform reads back is a **form**
(memory records, the schedule, config) — fill it the form's way.
Everything else is freeform paper.

## Build order (agreed 2026-07-24: persistence before prompt rearch)

1. ✅ Skills as the first governed surface (rwf, landable everywhere).
2. Worker prompt + dobby's memory triage — step 0 of the memory
   migration: policy-like notes move to `store/prompt.md`, leaving
   memory as person-facts ready for the scope_id split.
3. cas-over-git for schedule and config — the second submission style;
   the descriptor engine is generalized HERE, with both styles in
   view. `file_update` becomes validate-first as part of it.
4. Channel-scoped memory on the engine: per-channel canonicals,
   per-note landings, mounts, recall via run provenance, scope_id
   migration; the memory skill ships with it.
5. DELEGATED mirrors (local GitHub worktrees) — independent; slot
   anywhere after 3.

Prompt rearch (manifest, prose diet, identity kernel) follows —
written once, against finished machinery.

## Decisions from review (2026-07-24)

- **Transport**: the familiar per-surface verbs stay (`set_tasks`,
  `file_update`, `repo_push`); no generic submit tool is exposed.
  They become thin fronts over the one engine internally.
- **Memory write UX**: the worker git-commits notes in its worktree;
  a landing is the rwf submit of those commits.
- **Synthesized artifacts** are a first-class rwf convention (see
  GOVERNED); memory's bounded recall digest is one instance,
  replacing compaction as a mechanism.
- **`file_update`** moves to validate-first.
- **Mirror fetch (DELEGATED)**: never block a run on freshness.
  Worktrees provision instantly from the mirror; the mirror refreshes
  in the background (kicked at run start, after the worker's own
  pushes, hourly sweep); the box's own `git fetch` reaches the live
  remote through the gateway when certainty matters. Stale writes
  fail loudly at push (non-fast-forward) and need nothing; stale
  reads are the silent side, so each mounted repo's
  `ROSTER_REPOS_JSON` entry carries the mirror's last-fetch
  timestamp.
- **Non-memory channel-store files stay RAW.** The
  single-live-session property alone is not the guarantee — a session
  and the tasks it filed can write concurrently — but RAW's ordinary
  lock-and-rename discipline covers that, identically to the global
  store, and there is no schema or audit case: the host never parses
  these files and their audience is the room itself.

## Open questions

- Seeding and migration order for governed surfaces beyond the build
  path sketch (skills → schedule/config → memory): anything forcing a
  different order?
- Per-surface quotas on landings (a runaway loop committing notes)?
