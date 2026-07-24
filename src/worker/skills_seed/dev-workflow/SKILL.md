---
name: dev-workflow
description: How to work with git repositories and shared files — your own repos in the store, granted org repos under mnt/, GitHub through the gateway, and safe writes outside git. Use this before coding, committing, pushing, or editing shared files.
---

# Repos and files

Three kinds of repositories, three workflows — plus one rule for
files outside git.

## Your own repos (in your store)

Keep any git repo in your store **bare**, and never work inside it
directly: clone (or `git worktree add`) into `workspace/`, work
there, and push back to the bare repo before the run ends. Two runs
sharing one checkout is how repos corrupt; bare-plus-clone makes
that impossible. `workspace/` vanishes with the run — only what you
pushed back survives.

## Granted org repos (mnt/)

Each granted repo mounts at `$HOME/mnt/<name>`: a real clone on a
branch named for this run, with the canonical read-only as `origin`.
`ROSTER_REPOS_JSON` lists each repo and its mode.

- **Read mode** (how conversations get them): consult freely; if
  something deserves durable work, queue it with `file_task` — the
  task runs later with a writable checkout.
- **Write mode** (tasks): ordinary git — add, edit, commit as you
  go — then land your branch with `repo_push` (name the connection
  when more than one is writable).
- **"stale: main moved"**: another run landed first. Run
  `git fetch origin && git rebase origin/main`, resolve, and
  `repo_push` again.
- **Push before wrap-up.** Unpushed work is parked on a quarantine
  branch when the run ends, and your next run is told; recover it
  with `git fetch origin <ref>`. Landing beats parking.
- A push that deletes many files pauses for your lead's approval —
  the tool tells you when.
- Never put participants in repo files: no names, handles, or
  quotes. Pushes are scanned and refused.

## GitHub

When a GitHub connection is granted, the gateway authenticates
`api.github.com` and `github.com` in transit: work through the `gh`
CLI or plain git (clone, fetch, push). You never handle credentials —
the stand-in env var is enough, and removing proxy or certificate
settings only breaks your one door. Large throwaway clones belong in
`/tmp`.

## Files outside git

When more than one instance of you might touch a file, two separate
mechanisms keep it safe — you need both, because they protect against
different things:

- **Exclusion between writers**: run the read-modify-write under a
  named lock — `roster-lock <name> -- <command>`. It's an flock on
  `store/.locks/<name>`, shared by every instance, released by the
  kernel if the holder dies.
- **Consistency for readers**: write a temp file, then `mv` it over
  the original. The atomic rename — not the lock — is what protects
  anyone reading at that instant, including the host's backup pass,
  which does not wait for your named locks.

Skipping this never produces an error; it corrupts a file some day.
For a multi-file change that one rename can't cover, hold
`roster-lock store` (the backup pass takes that same lock) — or
better, put that data in a bare git repo.
