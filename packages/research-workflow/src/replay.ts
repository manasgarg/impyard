import type {
  HistoryEvent,
  ResearchEntry,
  NoteStatus,
  ResolvedJournal,
  ValidationIssue,
} from "./types.js";
import { compareCreated } from "./util.js";

export function replay(entries: ResearchEntry[]): ResolvedJournal {
  const sorted = [...entries].sort(compareCreated);
  const byId = new Map<string, ResearchEntry>();
  const statuses = new Map<string, NoteStatus>();
  const histories = new Map<string, HistoryEvent[]>();
  const incoming = new Map<string, ResearchEntry[]>();
  for (const entry of sorted) {
    if (!byId.has(entry.id)) byId.set(entry.id, entry);
    statuses.set(entry.id, "active");
    histories.set(entry.id, [{ at: entry.createdAt, status: "active", action: "created" }]);
  }
  for (const entry of sorted) {
    if (!entry.action) continue;
    for (const target of entry.targets) {
      const targetNote = byId.get(target);
      if (!targetNote) continue;
      const list = incoming.get(target) ?? [];
      list.push(entry);
      incoming.set(target, list);
      const status: NoteStatus =
        entry.action === "restore" ? "active" : entry.action === "delete" ? "deleted" : "superseded";
      statuses.set(target, status);
      histories.get(target)?.push({
        at: entry.createdAt,
        status,
        action: entry.action,
        by: entry.id,
      });
    }
  }
  return {
    entries: sorted,
    notes: sorted.filter((entry) => entry.type === "note"),
    artifacts: sorted.filter((entry) => entry.type === "artifact"),
    byId,
    statuses,
    histories,
    incoming,
  };
}

function cycleIssues(journal: ResolvedJournal): ValidationIssue[] {
  const edges = new Map<string, string[]>();
  for (const entry of journal.entries) {
    if (entry.action === "supersede") edges.set(entry.id, entry.targets);
  }
  const issues: ValidationIssue[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      const start = path.indexOf(id);
      const cycle = [...path.slice(start), id];
      issues.push({
        severity: "error",
        code: "SUPERSESSION_CYCLE",
        message: `Supersession cycle: ${cycle.join(" -> ")}`,
        noteId: id,
      });
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    path.push(id);
    for (const target of edges.get(id) ?? []) visit(target);
    path.pop();
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of edges.keys()) visit(id);
  return issues;
}

export function relationshipIssues(journal: ResolvedJournal): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const entry of journal.entries) {
    if (entry.action && entry.targets.length === 0) {
      issues.push({
        severity: "error",
        code: "MISSING_TARGETS",
        message: `${entry.action} requires at least one target`,
        noteId: entry.id,
      });
    }
    if (!entry.action && entry.targets.length > 0) {
      issues.push({
        severity: "error",
        code: "TARGETS_WITHOUT_ACTION",
        message: "targets requires action",
        noteId: entry.id,
      });
    }
    for (const target of entry.targets) {
      if (target === entry.id) {
        issues.push({
          severity: "error",
          code: "SELF_TARGET",
          message: "A note cannot target itself",
          noteId: entry.id,
        });
      } else if (!journal.byId.has(target)) {
        issues.push({
          severity: "error",
          code: "MISSING_TARGET",
          message: `Target note does not exist: ${target}`,
          noteId: entry.id,
        });
      }
    }
  }
  for (const [target, incoming] of journal.incoming) {
    const activeSuperseders = incoming.filter(
      (entry) => entry.action === "supersede" && journal.statuses.get(entry.id) === "active",
    );
    if (activeSuperseders.length > 1) {
      issues.push({
        severity: "error",
        code: "CONFLICTING_SUPERSEDERS",
        message: `${target} has multiple active superseding notes: ${activeSuperseders
          .map((entry) => entry.id)
          .join(", ")}`,
        noteId: target,
      });
    }
  }
  return [...issues, ...cycleIssues(journal)];
}
