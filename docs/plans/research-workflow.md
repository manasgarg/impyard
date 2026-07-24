# Design Document: Research Workflow

## 1. Overview

This document specifies a command-line interface for a shared research journal used by multiple AI agents.

The system is designed for agents that operate on a shared filesystem and collaboratively append notes and immutable artifacts. Any entry may carry reconciliation metadata that supersedes, deletes, or restores another entry. Derived views expose only currently active entries, and generated indexes provide human-readable navigation.

The system deliberately avoids a database, Git dependency, search index, synthesis layer, background daemon, and distributed coordination service in the initial implementation.

The CLI is the only supported mutation interface. Agents should not directly create or modify journal, derived-view, or index files.

The implementation lives in the `@manasgarg/research-workflow` npm workspace.
Its command-line executable is `rwf`.

## 2. Goals

The MVP should provide:

* Safe concurrent note and artifact creation by multiple agents.
* Append-only journal and artifact storage.
* Reconciliation expressed as ordinary note additions with specific metadata.
* Logical supersession, deletion, and restoration.
* A generated active-entry view based on symbolic links.
* Lexical search over active entries through ripgrep.
* Generated Markdown indexes and a schema-backed machine-readable manifest.
* Atomic filesystem operations.
* Deterministic reconciliation replay.
* Machine-readable command output.
* A stable interface suitable for AI agents and shell scripts.
* A filesystem structure that can later be published as a static site.

## 3. Non-Goals

The MVP will not include:

* Semantic or vector search.
* A persistent search index.
* Embeddings.
* Synthesis or summarization.
* Git integration.
* A database.
* Real-time collaboration.
* CRDTs.
* Editing existing journal entries.
* Physical deletion of journal entries.
* A graph database.
* A background daemon.
* Remote networking.
* A new task-management system.
* Fine-grained application authorization.
* Multiple publication formats.
* Arbitrary plugins.

## 4. Core Principles

### 4.1 Append-only entries

All journal notes and artifact records are immutable after creation.

Corrections are expressed by appending notes with reconciliation metadata rather than editing or deleting existing files.

### 4.2 Derived state is disposable

The following directories are generated and may be rebuilt at any time:

* `current/`
* `indexes/`
* Future static-site build output

No canonical information should exist only in a derived directory.

### 4.3 Agents express intent

Agents should invoke semantic commands such as:

```bash
rwf note add
rwf artifact add FILE
```

Reconciliation does not have a separate command or record type. An agent uses `rwf note add` and supplies `action`, `targets`, and the other metadata required by that action.

Agents should not decide final filenames, manage locks, or update symbolic links manually. They may supply note metadata and body content; the CLI validates the metadata and serializes the final note.

### 4.4 Shared filesystem coordination

Concurrent append operations should not require a global lock.

Each writer:

1. Generates a unique identifier.
2. Writes a complete temporary file.
3. Flushes it.
4. Atomically renames it into its final location.

Derived-state builders use exclusive locks because they replace shared generated directories.

### 4.5 Deterministic replay

Given the same canonical entries, the system must produce the same active state and indexes.

## 5. High-Level Architecture

```text
Research agents
    |
    | rwf note add / rwf artifact add
    v
Append-only notes and artifacts
    |
    | read by reconcilers
    v
Reconciliation agents
    |
    | rwf note add with action metadata
    v
Append-only entries
    |
    | rwf build view
    v
Symlink-based active view
    |
    | rwf build index-all
    v
Markdown indexes and JSON manifest
    |
    v
Static-site publisher
    |
    v
Human-readable website
```

The existing external task-management system coordinates when research and reconciliation jobs run.

## 6. Workspace Layout

A workspace should use the following structure:

```text
workspace/
├── .rwf/
│   ├── locks/
│   ├── tmp/
│   └── state/
├── journal/
│   └── YYYY/
│       └── MM/
│           └── DD/
├── artifacts/
│   └── YYYY/
│       └── MM/
│           └── DD/
├── current/
│   ├── notes/
│   └── artifacts/
├── indexes/
└── site/
```

Directory semantics:

* `.rwf/` marks the workspace root and contains operational state.
* `journal/` contains all immutable notes, whether or not they include reconciliation metadata.
* `artifacts/` contains immutable artifact metadata and payloads.
* `current/` contains generated symbolic links to active notes and artifact payloads.
* `indexes/` contains generated navigation files.
* `site/` is reserved for generated static-site output.

Agents must not directly modify `current/`, `indexes/`, or `site/`.

## 7. Workspace Discovery

The CLI should select a workspace root in this order:

1. The path passed through `--root`.
2. The `RWF_ROOT` environment variable.
3. The nearest ancestor of the current directory, including the current directory, that contains `.rwf/`.

An explicit `--root` or `RWF_ROOT` selects that exact directory even when it is not initialized. The selected root must already exist and be a directory; the CLI must not create a missing root path.

`rwf init`, `rwf note add`, `rwf artifact add`, and `rwf import` may initialize the selected root. If neither an explicit root nor an existing workspace is found, those commands use the current directory. Other commands fail with exit code `8` when the selected root is not initialized or no workspace can be discovered.

## 8. Fixed Workspace Conventions

The MVP has no configuration file. It uses fixed paths and formats:

```text
.rwf/   workspace marker and operational state
journal/  immutable Markdown notes
artifacts/ immutable artifact records and payloads
current/  generated active-entry symlinks
indexes/  generated indexes and manifest
site/     reserved generated publication output
```

Notes use Markdown with YAML frontmatter, IDs use ULIDs, and the active view uses symbolic links. A configuration file should be introduced only when there is a concrete user-configurable behavior. Its absence must not be an error.

## 9. Identifier Strategy

Use ULIDs.

Requirements:

* Globally unique without central coordination.
* Sortable by approximate creation time.
* Safe for filenames.
* Generated by the CLI.
* Never reused.
* Canonically encoded as 26 uppercase Crockford Base32 characters.
* Lexicographically sortable by their embedded millisecond timestamp.

Examples:

```text
01K0ABC7JKM4Y2D8Q9P1STVWXY
```

The identifier is the canonical identity of a note or artifact and is globally unique across both types. Titles and filesystem paths are not canonical identities. ULID ordering reflects generator timestamps, so replay must still use `created_at` explicitly and treat the ULID as a deterministic tie-breaker rather than proof of causal order.

## 10. Journal Note Format

Each note is stored as a Markdown file with YAML frontmatter.

Example:

```markdown
---
id: 01K0ABC7JKM4Y2D8Q9P1STVWXY
created_at: 2026-07-21T20:42:10Z
author: researcher-3
task_id: task-123
title: Letta archival memory
topics:
  - agent-memory
sources:
  - https://example.com
---

Research content goes here.
```

### 10.1 Required fields

```text
id
created_at
title
```

### 10.2 Recognized optional fields

```text
author
task_id
collection
topics
sources
artifacts
action
targets
```

These are the optional fields that affect CLI behavior or generated output. Notes may contain any additional YAML frontmatter. The CLI must preserve unrecognized metadata without interpreting it.

### 10.3 Field behavior

`id`

* Generated by the CLI.
* Immutable.
* Must match the identifier in the filename.

`created_at`

* Generated by the CLI.
* Stored as an RFC 3339 UTC timestamp.

`author`

* Supplied by the caller.
* Identifies an agent or human actor.
* Used by author filters and displayed in generated metadata when present.

`title`

* Supplied by the caller.
* Used for display and filename slug generation.

`task_id`

* Optional external task-system identifier.

`collection`

* Optional stable grouping such as `technology-monitor`.
* Used by collection filters and generated collection indexes.

`topics`

* Optional list of strings.
* Used for topic-based indexes.

`sources`

* Optional list of source URLs or source identifiers.
* The CLI does not need to validate source contents.

`artifacts`

* Optional list of artifact IDs referenced by the note.
* A referenced ID must resolve to an artifact entry.

`action`

* Optional reconciliation action: `supersede`, `delete`, or `restore`.
* Its presence instructs reconciliation replay but does not otherwise change how the note is stored or displayed.
* The action determines which other reconciliation fields are required.

`targets`

* A list of note or artifact IDs affected by an action.

### 10.4 Filename format

```text
<ID>-<slug>.md
```

Example:

```text
01K0ABC7JKM4Y2D8Q9P1STVWXY-letta-archival-memory.md
```

The slug is for readability only. Identity resolution must use the ID.

### 10.5 Artifact format

Artifacts are first-class immutable entries and do not require an accompanying
note. Each artifact has a metadata record and one payload:

```text
artifacts/YYYY/MM/DD/<ID>-<slug>/
├── metadata.json
└── payload/
    └── <original-filename>
```

Required generated metadata includes:

```text
id
created_at
title
filename
media_type
size
sha256
```

Artifacts support the same optional author, task, collection, topics, sources,
action, targets, and arbitrary metadata as notes. The ULID is the artifact's
identity; SHA-256 verifies payload integrity and may support deduplication
later. A note may reference any number of artifacts, while standalone datasets,
source captures, images, archives, and other files remain fully discoverable
without synthetic prose notes.

## 11. Reconciliation Metadata

Reconciliation is expressed by adding an ordinary note or artifact whose metadata contains `action`. There is no separate reconciliation record type or command. Every entry is initially active, including an entry with `action`. The action changes the state of the entries listed in `targets`; it does not give the new entry a special display or storage status.

Example supersession note:

```markdown
---
id: 01K0XYZ4Q2ABCDEFGHJKMNPQRS
created_at: 2026-07-21T21:03:00Z
author: reconciler-2
title: Updated Letta archival memory findings
action: supersede
targets:
  - 01K0ABC7JKM4Y2D8Q9P1STVWXY
---

The archival memory mechanism stores durable information outside the active
conversation context. Newer primary-source evidence clarifies that...
```

### 11.1 Supported MVP actions

```text
supersede
delete
restore
```

### 11.2 Supersede

Supersession marks one or more target entries inactive. The newly added entry is itself the active replacement.

Required fields:

```text
action: supersede
targets
```

### 11.3 Delete

Deletion marks one or more entries inactive without physically deleting canonical data.

Required fields:

```text
action: delete
targets
```

### 11.4 Restore

Restoration returns one or more logically deleted or superseded entries to active state.

Required fields:

```text
action: restore
targets
```

Like every other note, an action-bearing note requires only `id`, `created_at`, and `title`. Its Markdown body contains its content: reconciled findings for `supersede`, or an explanation for `delete` and `restore`. It may also use recognized or arbitrary optional metadata.

## 12. Reconciliation Semantics

Entries containing `action` are replayed in deterministic order.

Recommended ordering:

1. Sort by `created_at`.
2. Use note ID as a deterministic tie-breaker.

Every entry starts active. For each action-bearing entry, apply its action to the entries in `targets`. The action-bearing entry remains active unless another entry targets it.

An action is replayed even if the entry containing it is later superseded or deleted. Targeting an action-bearing entry changes that entry's visibility; it does not undo the action. Reversing an earlier action requires an explicit later action, such as restoring the original target.

Initial state:

```text
active
```

State transitions:

```text
active + supersede -> superseded
active + delete -> deleted
superseded + restore -> active
deleted + restore -> active
```

The final operation affecting a note determines its current state, subject to validation rules.

The implementation should detect and report ambiguous or invalid relationships, including:

* Missing target note.
* A note superseding itself.
* Supersession cycles.
* Multiple incompatible active entries superseding the same target.
* Invalid action fields.
* Duplicate IDs.

The MVP may still build the view when non-fatal conflicts exist, but unresolved behavior must be deterministic and clearly reported.

A conservative default is preferable: omit notes involved in unresolved cycles or malformed action metadata from the active view and report validation errors.

## 13. CLI Command Structure

General form:

```text
rwf <command> [subcommand] [arguments] [flags]
```

Some top-level commands group related subcommands:

```text
rwf note ...
rwf artifact ...
rwf import <note|artifact> ...
rwf build <view|index-current|index-chronological|index-topics|index-all>
```

Other top-level commands stand alone, although they may accept arguments and flags:

```text
rwf init
rwf inspect ENTRY_ID
rwf search QUERY
rwf refresh
rwf validate
rwf status
```

The CLI does not require every command to follow a resource-action model. For example, `note add` groups operations on notes, `build` selects a generated output, and `validate` and `status` operate on the workspace as a whole.

## 14. Global Flags

All applicable commands should support:

```text
--root PATH
--json
--quiet
```

`--root PATH`

Specifies the workspace root.

`--json`

Returns structured JSON on stdout.

`--quiet`

Suppresses ordinary human-readable output.

For commands that create one primary object, quiet mode may output only the created ID.

The CLI must not prompt interactively by default.

## 15. Initialization Command

```bash
rwf init
```

Options:

```bash
rwf init --root /shared/research
```

Responsibilities:

* Require the selected root directory to exist.
* Create `.rwf/` as the workspace marker.
* Create the operational-state directories, `journal/`, and `artifacts/`.
* Verify that required filesystem operations are available.
* Succeed without changing canonical data when the workspace is already initialized.

`current/`, `indexes/`, and `site/` should be created only by the commands that generate them.

`rwf note add`, `rwf artifact add`, and `rwf import` perform the same initialization automatically when their selected root does not yet contain `.rwf/`. No other command implicitly initializes a workspace. Concurrent initialization and first-entry operations must be safe: directory creation is idempotent, and no process may overwrite another process's files.

## 16. Note Commands

### 16.1 Add a note

```bash
rwf note add
```

Content can be provided through stdin:

```bash
cat note.md | rwf note add \
  --title "Letta archival memory" \
  --author researcher-3 \
  --task task-123 \
  --topic agent-memory \
  --source https://example.com
```

Or through a file:

```bash
rwf note add \
  --file /tmp/research-note.md \
  --title "Letta archival memory" \
  --author researcher-3
```

Supported flags:

```text
--file PATH
--title STRING
--author STRING
--task STRING
--collection STRING
--topic STRING
--source STRING
--artifact ARTIFACT_ID
--action supersede|delete|restore
--target ENTRY_ID
--metadata KEY=VALUE
--metadata-file PATH
--json
--quiet
```

`--topic`, `--source`, `--artifact`, `--target`, and `--metadata` may be repeated. Reconciliation flags simply populate note metadata; they do not select another record type or mutation path.

`--metadata KEY=VALUE` adds arbitrary string-valued frontmatter. `--metadata-file` reads a YAML mapping and supports arbitrary YAML values such as lists and nested mappings. The CLI must reject attempts to set the generated `id` or `created_at` fields, and it must reject conflicting values supplied through named flags and arbitrary metadata.

The command should:

1. Resolve the root and initialize it if necessary.
2. Validate arguments.
3. Generate an ID.
4. Generate the timestamp.
5. Create frontmatter.
6. Write the complete file under `.rwf/tmp/`.
7. Flush the file.
8. Atomically rename it into `journal/YYYY/MM/DD/`.
9. Return the created note ID and path.

Human-readable response:

```text
Created note 01K0ABC7JKM4Y2D8Q9P1STVWXY
journal/2026/07/21/01K0ABC7JKM4Y2D8Q9P1STVWXY-letta-archival-memory.md
```

JSON response:

```json
{
  "ok": true,
  "note": {
    "id": "01K0ABC7JKM4Y2D8Q9P1STVWXY",
    "path": "journal/2026/07/21/01K0ABC7JKM4Y2D8Q9P1STVWXY-letta-archival-memory.md",
    "created_at": "2026-07-21T20:42:10Z"
  }
}
```

Quiet response:

```text
01K0ABC7JKM4Y2D8Q9P1STVWXY
```

### 16.2 Show a note

```bash
rwf note show NOTE_ID
```

Options:

```text
--body
--metadata
--json
```

Default behavior should display the complete note.

### 16.3 Resolve a note path

```bash
rwf note path NOTE_ID
```

Returns the current canonical journal path.

### 16.4 List notes

```bash
rwf note list
```

Supported filters:

```text
--active
--superseded
--deleted
--all
--topic STRING
--author STRING
--task STRING
--collection STRING
--since TIMESTAMP
--title STRING
--metadata KEY=VALUE
--limit NUMBER
--json
```

The default should list active notes, including active notes that contain reconciliation metadata.

`--all` should list every journal note regardless of reconciliation state.

### 16.5 Artifact commands

```bash
rwf artifact add FILE --title "Funding events"
rwf artifact show ARTIFACT_ID
rwf artifact path ARTIFACT_ID
rwf artifact cat ARTIFACT_ID
rwf artifact list
```

`artifact add` accepts the common author, task, collection, topic, source,
action, target, metadata, JSON, and quiet flags, plus `--media-type`.
Creation copies the payload and writes its complete metadata under a unique
temporary directory, flushes both, and atomically renames the directory into
`artifacts/YYYY/MM/DD/`. `artifact cat` streams the original payload bytes.
Artifact list supports the same status, title, metadata, collection, topic,
author, task, time, and limit filters as note list.

### 16.6 Search

```bash
rwf search "enterprise context management"
rwf search "funding" --topic venture-funding
rwf search "old claim" --all
```

Search is case-insensitive fixed-string lexical search by default. It searches
active entries unless a status selector or `--all` is supplied, supports the
same filters as list commands, and returns matching IDs, types, titles,
statuses, paths, and snippets. `--regex` enables a regular expression and
`--case-sensitive` changes matching behavior.

The implementation invokes ripgrep with symlink following (`rg -L`) when
available and supplements payload matches with title and metadata matches. A
built-in fallback preserves correctness when ripgrep is unavailable. Search
does not maintain a persistent index; an indexed backend may replace the
implementation later without changing the command contract.

### 16.7 Historical import

```bash
rwf import note --file report.md --title "Historical report" \
  --created-at 2024-01-02T03:04:05Z

rwf import artifact dataset.csv --title "Historical dataset" \
  --created-at 2024-01-02T03:04:05Z
```

Import uses the normal immutable note and artifact creation paths but permits a
caller-supplied historical `created_at`. Normal add commands never accept that
field. This explicit boundary keeps ordinary creation trustworthy while
supporting migrations whose chronological indexes must retain source history.

## 17. Adding Notes With Reconciliation Metadata

Reconciliation uses the same `rwf note add` command, required common metadata, body input, output, and atomic write path as any other note.

### 17.1 Supersede notes

```bash
echo "The archival memory mechanism stores durable information outside the active context..." | \
  rwf note add \
    --title "Updated memory research" \
    --author reconciler-2 \
    --action supersede \
    --target OLD_ID
```

The new note is the replacement for `OLD_ID`; no separate replacement note or field is needed.

Multiple targets:

```bash
echo "The combined findings from the duplicate notes..." | \
  rwf note add \
    --title "Merge duplicate memory research" \
    --author reconciler-2 \
    --action supersede \
    --target NOTE_A \
    --target NOTE_B
```

### 17.2 Delete notes

```bash
echo "The cited source is invalid." | \
  rwf note add \
    --title "Withdraw note with invalid source" \
    --author reconciler-2 \
    --action delete \
    --target NOTE_ID
```

Multiple `--target` flags may be supplied.

### 17.3 Restore notes

```bash
echo "The prior deletion was incorrect." | \
  rwf note add \
    --title "Restore incorrectly deleted note" \
    --author reconciler-2 \
    --action restore \
    --target NOTE_ID
```

Each command above appends an ordinary immutable note to `journal/`. It never modifies a target note or a prior action-bearing note.

## 18. Inspect Command

```bash
rwf inspect ENTRY_ID
rwf inspect ENTRY_ID --lineage
```

The command should show:

* The entry's type, recognized metadata, and additional metadata.
* Its current status.
* Any action declared by the entry.
* Every entry that targets it.
* Its complete state history in replay order.
* Any conflicts involving it.

Example output:

```text
Note: 01K0ABC7JKM4Y2D8Q9P1STVWXY
Title: Letta archival memory
Status: superseded

Superseded by:
  01K0XYZ4Q2ABCDEFGHJKMNPQRS

Superseding note:
  01K0XYZ4Q2ABCDEFGHJKMNPQRS
  author: reconciler-2
  title: Updated Letta archival memory findings

History:
  2026-07-21T20:42:10Z  created     active
  2026-07-21T21:03:00Z  superseded  by 01K0XYZ4Q2ABCDEFGHJKMNPQRS
```

Workspace-wide conflicts are reported by `rwf validate`.

`--lineage` recursively traverses both targets and incoming actions and returns
the complete connected reconciliation graph. JSON output contains explicit
entry nodes and directed action edges, so a long-lived logical document can be
understood without manually following one supersession hop at a time.

## 19. Active View

The active view is a generated directory containing symbolic links only to active entries. Action-bearing entries are included when active, just like other entries.

Example:

```text
current/
├── notes/
│   ├── 01K0ABC7JKM4Y2D8Q9P1STVWXY-letta-archival-memory.md
│   └── 01K0DEF8LMN3Z7K1R4T6GHJKMN-agent-context-management.md
└── artifacts/
    └── 01K0GHI9-example-dataset.csv
```

Each entry points to the canonical journal file.

Example target:

```text
../../journal/2026/07/21/01K0ABC7JKM4Y2D8Q9P1STVWXY-letta-archival-memory.md
```

Each type-specific directory remains flat. Do not organize the view by topic because an entry may belong to multiple topics. Ordinary filesystem search requires symlink following; `rwf search` handles this internally through `rg -L`.

## 20. Build View Target

```bash
rwf build view
```

Responsibilities:

1. Parse all journal notes and artifact metadata.
2. Validate identities and relationships.
3. Replay action-bearing entries.
4. Determine active entries.
5. Build a complete temporary symlink directory.
6. Atomically replace the existing `current/` directory.

Options:

```text
--wait
--no-wait
--json
```

The view builder must use an exclusive lock:

```text
.rwf/locks/view.lock
```

Recommended default behavior:

* Wait for a short bounded period.
* If another builder completes successfully during that period, return success.
* Do not allow two processes to replace `current/` concurrently.

The builder should regenerate the entire directory rather than incrementally patching symlinks.

## 21. Indexes

The MVP should generate:

```text
indexes/
├── current.md
├── chronological.md
├── topics.md
├── topics/
├── collections.md
├── collections/
├── artifacts.md
├── manifest.json
└── manifest.schema.json
```

### 21.1 Current index

Contains active notes and artifacts in stable type-specific sections.

Example:

```markdown
# Current Notes

- [Agent context management](../current/notes/01K0DEF...-agent-context-management.md)
- [Letta archival memory](../current/notes/01K0ABC...-letta-archival-memory.md)
```

Ordering should be deterministic. Recommended default:

1. Title, case-insensitive.
2. Note ID as a tie-breaker.

### 21.2 Chronological index

Lists active notes and artifacts by creation time.

Example:

```markdown
# Notes by Date

## 2026-07-21

- [Letta archival memory](...)
- [Agent context management](...)
```

### 21.3 Topic index

`topics.md` is a compact summary with counts and links. Each normalized topic
has a separate page under `indexes/topics/` listing its active entries. This
keeps navigation usable for large workspaces.

Example:

```markdown
# Notes by Topic

## Agent Memory

- [Letta archival memory](...)

## Coordination

- [Shared-filesystem coordination](...)
```

Collections use the same summary-and-page structure under
`indexes/collections/`. `artifacts.md` lists active artifacts with media type,
size, and digest.

### 21.4 Manifest

`manifest.json` is a generated instance document, not a JSON Schema. It
references the separately generated `manifest.schema.json`, which uses JSON
Schema draft 2020-12. The package versions the canonical schema and tests all
generated manifests against its contract.

Example:

```json
{
  "$schema": "./manifest.schema.json",
  "schema_version": 1,
  "generated_at": "2026-07-21T21:10:00Z",
  "notes": [
    {
      "id": "01K0ABC7JKM4Y2D8Q9P1STVWXY",
      "type": "note",
      "status": "active",
      "title": "Letta archival memory",
      "created_at": "2026-07-21T20:42:10Z",
      "metadata": {
        "author": "researcher-3",
        "topics": ["agent-memory"]
      },
      "action": null,
      "targets": [],
      "artifacts": [],
      "canonical_path": "journal/2026/07/21/01K0ABC7JKM4Y2D8Q9P1STVWXY-letta-archival-memory.md",
      "current_path": "current/notes/01K0ABC7JKM4Y2D8Q9P1STVWXY-letta-archival-memory.md",
      "content_sha256": "..."
    }
  ],
  "artifacts": []
}
```

The manifest includes every canonical note and artifact, including inactive
entries, with status, action, targets, complete arbitrary metadata, hashes,
canonical paths, and active paths where applicable. This makes references and
reconciliation history resolvable without reparsing canonical files.

## 22. Index Build Targets

```bash
rwf build index-current
```

Supported targets:

```bash
rwf build index-current
rwf build index-chronological
rwf build index-topics
rwf build index-all
```

The build target is required. `index-all` generates all Markdown indexes and the manifest.

The index builder must consume the resolved active state or the generated current view. It should not implement reconciliation replay itself.

Use an exclusive lock:

```text
.rwf/locks/index.lock
```

Generate all requested files under a temporary directory and atomically replace the final index files or directory.

## 23. Refresh Command

```bash
rwf refresh
```

Equivalent to:

```text
rwf validate
rwf build view
rwf build index-all
```

The command should stop if validation fails.

It should return a summary:

```text
Validated 351 entries, including 342 notes and 9 artifacts
Built active view with 298 entries
Generated navigation indexes, manifest, and schema
```

## 24. Validation

```bash
rwf validate
```

Validation checks should include:

* The workspace marker and required directories exist.
* The workspace and required directories have usable permissions.
* The workspace is writable.
* Symbolic links are supported.
* Atomic rename works.
* Temporary and final directories are on the same filesystem.
* Locks can be acquired.
* No abandoned locks exist.
* Every journal file parses.
* Every artifact metadata record parses.
* Every artifact payload exists and matches its recorded size and SHA-256.
* Every note artifact reference resolves to an artifact.
* Required frontmatter fields exist.
* IDs are unique.
* Filename IDs match frontmatter IDs.
* Action metadata is valid for the selected action.
* Action targets exist.
* No entry supersedes itself.
* No supersession cycles exist.
* No target has multiple incompatible active superseding notes.
* All symbolic links in `current/` resolve.
* Generated indexes reference valid active entries.
* No unexpected files exist in generated directories.
* Temporary files are not stranded beyond an acceptable age.

Machine-readable form:

```bash
rwf validate --json
```

Validation must report workspace-wide conflicts and distinguish warnings from errors. It must not mutate canonical state. Filesystem capability checks may create uniquely named probe files and locks under `.rwf/tmp/` and `.rwf/locks/`, but they must clean them up before returning.

## 25. Status

```bash
rwf status
```

Example:

```text
Entries:                351
Notes:                  342
Artifacts:                9
Action entries:          58
Active entries:         298
Superseded entries:      47
Deleted entries:          6
Conflicts:                2
Current view:         stale
Indexes:              stale
```

To detect stale derived outputs, the implementation may store build metadata under:

```text
.rwf/state/
```

For example:

```json
{
  "latest_journal_id": "01K...",
  "view_built_through": "01K...",
  "indexes_built_through": "01K..."
}
```

This state is operational metadata, not canonical research data.

## 26. Concurrency Model

### 26.1 Canonical appends

Do not use a global lock.

Algorithm:

```text
Generate unique ID
Construct final path
Write complete content to unique temporary path
Flush file contents
Optionally fsync parent directory
Atomically rename temporary file to final path
```

Artifact creation applies the same algorithm to a complete temporary directory
containing metadata and payload. Because IDs are globally unique, destination
collisions should be extremely unlikely. A collision must fail safely and
never overwrite existing canonical data.

### 26.2 Derived-state builds

Use one exclusive lock per output:

```text
.rwf/locks/view.lock
.rwf/locks/index.lock
.rwf/locks/site.lock
```

Build under a temporary sibling directory:

```text
.rwf/tmp/current-<ID>/
```

Then atomically replace the final generated directory.

The exact replacement strategy must account for platform behavior. The initial supported platform may be limited to Unix-like systems if necessary.

### 26.3 Locks

Lock files should contain diagnostic information:

```json
{
  "pid": 12345,
  "hostname": "worker-2",
  "created_at": "2026-07-21T21:10:00Z",
  "command": "rwf build view"
}
```

Do not automatically remove a lock merely because it is old. Verify process or lease semantics where possible.

## 27. Standard Output Contract

Use:

* `stdout` for requested results.
* `stderr` for warnings and diagnostics.
* Exit codes for machine-level control flow.

In JSON mode, stdout must contain only valid JSON.

Warnings in JSON mode should either:

* Be included in the JSON payload, or
* Be written to stderr.

Do not mix human-readable text with JSON on stdout.

## 28. JSON Response Shape

Successful response:

```json
{
  "ok": true,
  "result": {}
}
```

Resource-specific responses may use named top-level fields, such as `note`, while retaining `ok`.

Failed response:

```json
{
  "ok": false,
  "error": {
    "code": "RECONCILIATION_CONFLICT",
    "message": "Note has already been superseded by another active note.",
    "details": {}
  }
}
```

Error codes are stable API identifiers and should not depend on exact human-readable wording.

## 29. Exit Codes

Use stable documented exit codes:

```text
0   success
1   general failure
2   invalid arguments
3   validation failure
4   entry not found
5   conflict detected
6   lock unavailable
7   filesystem failure
8   workspace not initialized
```

Additional exit codes should only be added deliberately and documented.

## 30. Agent Roles

The CLI itself does not need to implement authorization in the MVP, but command access may be constrained through OS users, containers, or wrapper scripts.

Research agents require:

```text
rwf note add
rwf note show
rwf note list
rwf artifact add
rwf artifact show
rwf artifact list
rwf search
rwf status
```

Reconciliation agents require:

```text
rwf note add
rwf note show
rwf note list
rwf artifact show
rwf artifact list
rwf inspect ENTRY_ID
rwf search
```

Builder processes require:

```text
rwf validate
rwf build view
rwf build index-all
rwf refresh
```

Publisher processes may later require:

```text
rwf site build
rwf site publish
```

## 31. Static Publication Boundary

Humans consume the research through a generated website.

The publisher should consume:

```text
current/
indexes/
journal/
artifacts/
```

At minimum, the published site should expose:

* Current active notes.
* Current active artifacts.
* Topic index.
* Chronological index.
* Individual note pages.
* Sources and metadata.
* Reconciliation status where relevant.

Publication is outside the first CLI implementation unless explicitly added.

The CLI should nevertheless generate paths and files that are easy for a static-site generator to consume.

## 32. Recommended MVP Command Set

Implement these commands first:

```text
rwf init

rwf note add
rwf note show
rwf note path
rwf note list

rwf artifact add
rwf artifact show
rwf artifact path
rwf artifact cat
rwf artifact list

rwf import note
rwf import artifact

rwf inspect ENTRY_ID
rwf search QUERY

rwf build view
rwf build index-current
rwf build index-chronological
rwf build index-topics
rwf build index-all
rwf refresh

rwf validate
rwf status
```

## 33. Commands Explicitly Deferred

Do not implement these in the MVP:

```text
rwf note edit
rwf note delete-physical
rwf note move
rwf synthesize
rwf git ...
rwf daemon
rwf watch
rwf plugin ...
rwf remote ...
```

## 34. Implementation Guidance

The CLI is implemented as a TypeScript npm workspace under:

```text
packages/research-workflow/
```

It targets Node.js 24, compiles to ESM JavaScript, and exposes `dist/cli.js` as
the `rwf` package binary. Runtime dependencies are deliberately small:

```text
yaml   YAML frontmatter parsing and serialization
ulid   chronologically sortable note identifiers
```

Filesystem operations, hashing, process inspection, and the CLI runtime use
Node.js standard library APIs. The package uses strict TypeScript checking and
Node's built-in test runner. Lexical search invokes `rg -L` when ripgrep is
available and falls back to an internal scan. Ajv is a test-only dependency
used to validate generated manifests against the checked-in schema.

## 35. Suggested Internal Modules

```text
src/
├── artifacts.ts
├── cli.ts
├── build.ts
├── entry.ts
├── errors.ts
├── frontmatter.ts
├── index.ts
├── journal.ts
├── locks.ts
├── replay.ts
├── state.ts
├── types.ts
├── util.ts
├── validation.ts
└── workspace.ts
```

The reconciliation replay logic should be isolated and unit-testable.

## 36. Testing Requirements

### 36.1 Unit tests

Cover:

* Note parsing.
* Artifact metadata parsing and payload integrity.
* Action-metadata parsing.
* Filename and ID validation.
* Slug generation.
* State transitions.
* Restore behavior.
* Supersession cycle detection.
* Deterministic ordering.
* JSON output serialization.
* Lexical search and metadata filtering.
* Recursive lineage.
* Manifest schema compatibility.
* Exit-code mapping.

### 36.2 Concurrency tests

Test:

* Many concurrent `note add` commands.
* Concurrent first-note additions to an uninitialized existing root.
* Concurrent and repeated `init` commands.
* Concurrent action-bearing entry appends.
* Concurrent `build view` attempts.
* Concurrent index build attempts.
* A process crashing before atomic rename.
* A process crashing during derived-directory generation.

### 36.3 Filesystem tests

Test:

* Broken symbolic links.
* Missing journal targets.
* Read-only workspace.
* Cross-filesystem rename failure.
* Existing destination collision.
* Interrupted temporary files.
* Invalid permissions.
* Unsupported symbolic links.

### 36.4 End-to-end test

A complete test should:

1. Initialize a workspace.
2. Add an initial note.
3. Add a second note with `action: supersede` targeting the initial note.
4. Add another note, then add a note with `action: delete` targeting it.
5. Add an artifact and reference it from a note.
6. Supersede the artifact with a new artifact version.
7. Build the active view.
8. Verify that targeted entries are absent and replacement entries are present.
9. Search active note and artifact contents.
10. Build all indexes and validate the manifest against its schema.
11. Validate the workspace.
12. Add a note with `action: restore` targeting the deleted note.
13. Refresh and verify the new active state.

## 37. Example End-to-End Workflow

```bash
rwf init --root /shared/research

echo "Initial research about memory." | \
  rwf note add \
    --root /shared/research \
    --title "Initial memory research" \
    --author researcher-1 \
    --task task-100 \
    --topic agent-memory \
    --quiet
```

Output:

```text
01K0NOTE_A
```

```bash
echo "Updated research with stronger sources." | \
  rwf note add \
    --root /shared/research \
    --title "Updated memory research" \
    --author researcher-2 \
    --task task-101 \
    --topic agent-memory \
    --source https://example.com \
    --action supersede \
    --target 01K0NOTE_A \
    --quiet
```

Output:

```text
01K0NOTE_B
```

```bash
rwf refresh --root /shared/research
```

Expected active view:

```text
current/
├── notes/
│   └── 01K0NOTE_B-updated-memory-research.md
└── artifacts/
```

## 38. Acceptance Criteria

The MVP is complete when:

* `rwf init` creates an empty workspace without a configuration file.
* The first `rwf note add` can initialize an existing directory implicitly.
* Implicit initialization never creates a missing root path.
* Multiple processes can append notes concurrently without corruption.
* Multiple processes can append artifacts concurrently without corruption.
* Multiple processes can append action-bearing entries concurrently.
* All canonical notes, artifact metadata, and payloads are immutable after creation.
* Reconciliation replay is deterministic.
* Superseded and deleted entries are absent from `current/`.
* Restored entries return to `current/`.
* `current/` contains valid symbolic links only.
* `rwf search` finds active note and textual artifact content without requiring callers to know that the view uses symlinks.
* Title, collection, and arbitrary metadata filters work.
* `inspect --lineage` returns the complete connected reconciliation graph.
* Topic and collection indexes remain split into bounded pages.
* The manifest contains all entries and complete metadata and conforms to the versioned JSON Schema.
* Invalid references and cycles are detected.
* All commands support stable JSON output where applicable.
* Derived state can be deleted and rebuilt from canonical files.
* No database or Git repository is required.
