---
name: schedule
description: How to manage your task list — read the tasks file, reshape it with set_tasks, add single tasks with file_task, and run recurring work. Use this when planning, rescheduling, chaining, or canceling work.
---

# Your schedule

Your plan lives in one document, mounted read-only at
`$ROSTER_TASKS_FILE` (`$HOME/self/schedule.json`) in every run. It
holds your pending tasks and your recurring templates, with a version
number. The file is a **view**: editing it directly changes nothing.
Changes go through the two tools below, and the host validates them
before they land.

## One quick addition

`file_task(prompt[, ceiling_min, at])` adds a single task without
touching the rest of the plan.

- `at` (RFC3339 UTC, like `2026-07-18T09:00:00Z`) schedules it.
  "Wake me at T to do X" is nothing special — a task with `at` set.
- The prompt must be **self-contained**: the future run sees only
  that text. This conversation does not travel with it.
- Keep people out of prompts — no names, handles, or quotes. The
  host scans and refuses prompts that name participants. A task filed
  from a channel reports its results back to that channel; the task
  run's briefing says where.

## Reshaping the whole plan

`set_tasks(base_version, tasks[, recurring])` replaces the document:

1. Read `$ROSTER_TASKS_FILE` fresh and note its version.
2. Send the complete new plan with `base_version` set to that
   version.
3. If someone changed the plan meanwhile, the call fails and tells
   you the current version — re-read and retry.

A reshape covers everything at once: reorder; reschedule
(`scheduled_at`); chain work (`depends_on` lists task ids that must
complete first); cancel a task by omitting it; create or retire
recurring templates (`schedule` is 5-field cron in the host's local
time, like `"0 9 * * 1-5"`).

## What you can't touch

The heartbeat template is host-owned; `set_tasks` cannot change it.
It wakes you at least every N minutes to look at your list, do what's
due, and tidy the plan — so nothing in your file is ever more than
one heartbeat from a chance to act, and if a run crashes, the file
survives and the next heartbeat recovers the plan.

## Finishing

The host tracks every task's lifecycle (pending → claimed → completed
or failed); you never mark your own work done. You do report it: end
a task run with `task_complete`, or `task_fail` with the reason. A
run that ends silently after refused calls is recorded as failed.
Finished tasks leave the file; your journal keeps the story.

## Habits

- Spread recurring work across the day instead of stacking triggers
  at one hour.
- Work filed at a trusted operator's request always runs; your own
  initiative is paced by budget — an over-budget task is late, not
  lost. Don't refile it.
