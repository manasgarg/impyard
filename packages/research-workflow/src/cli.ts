#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parseMetadataFile } from "./frontmatter.js";
import { buildIndexes, buildView, type BuildTarget } from "./build.js";
import { EXIT, RwfError, invalid } from "./errors.js";
import { createNote, findNote } from "./journal.js";
import { createArtifact, findArtifact } from "./artifacts.js";
import { replay, relationshipIssues } from "./replay.js";
import { journalFingerprint, readBuildState } from "./state.js";
import type {
  Artifact,
  Note,
  OutputOptions,
  ResearchEntry,
  ResolvedJournal,
  ValidationIssue,
  WorkspacePaths,
} from "./types.js";
import { readStdin } from "./util.js";
import { errorsOf, validateWorkspace } from "./validation.js";
import { initializeWorkspace, resolveWorkspace } from "./workspace.js";

const HELP = `research-workflow (rwf)

Usage:
  rwf init [--root PATH]
  rwf note <add|show|path|list> ...
  rwf artifact <add|show|path|cat|list> ...
  rwf import <note|artifact> ... --created-at TIMESTAMP
  rwf inspect ENTRY_ID [--lineage]
  rwf search QUERY [filters]
  rwf build <view|index-current|index-chronological|index-topics|index-all>
  rwf refresh
  rwf validate
  rwf status

Global options:
  --root PATH   Select a workspace root
  --json        Print machine-readable JSON
  --quiet       Suppress ordinary output
  -h, --help    Show help
`;

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string[]>;
}

const BOOLEAN_FLAGS = new Set([
  "json",
  "quiet",
  "help",
  "body",
  "all",
  "active",
  "superseded",
  "deleted",
  "wait",
  "no-wait",
  "lineage",
  "regex",
  "case-sensitive",
]);

function parseArgs(tokens: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "-h") {
      flags.set("help", ["true"]);
      continue;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const raw = token.slice(2);
    const equal = raw.indexOf("=");
    const name = equal >= 0 ? raw.slice(0, equal) : raw;
    const inline = equal >= 0 ? raw.slice(equal + 1) : undefined;
    if (!name) throw invalid("Empty option name");
    let optionValue: string;
    if (inline !== undefined) {
      optionValue = inline;
    } else if (BOOLEAN_FLAGS.has(name)) {
      optionValue = "true";
    } else if (name === "metadata" && !tokens[index + 1]?.includes("=")) {
      optionValue = "true";
    } else {
      const next = tokens[index + 1];
      if (next === undefined || next.startsWith("--")) throw invalid(`--${name} requires a value`);
      optionValue = next;
      index += 1;
    }
    const current = flags.get(name) ?? [];
    current.push(optionValue);
    flags.set(name, current);
  }
  return { positionals, flags };
}

function value(args: ParsedArgs, name: string): string | undefined {
  return args.flags.get(name)?.at(-1);
}

function values(args: ParsedArgs, name: string): string[] {
  return args.flags.get(name) ?? [];
}

function has(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name);
}

function requireValue(args: ParsedArgs, name: string): string {
  const result = value(args, name);
  if (!result) throw invalid(`--${name} is required`);
  return result;
}

function outputOptions(args: ParsedArgs): OutputOptions {
  return { json: has(args, "json"), quiet: has(args, "quiet") };
}

function printJson(result: unknown): void {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function printResult(options: OutputOptions, human: string, json: unknown, quiet?: string): void {
  if (options.json) printJson(json);
  else if (options.quiet) {
    if (quiet !== undefined) process.stdout.write(`${quiet}\n`);
  } else {
    process.stdout.write(`${human.trimEnd()}\n`);
  }
}

function workspace(args: ParsedArgs, mayInitialize = false): WorkspacePaths {
  const root = value(args, "root");
  return resolveWorkspace(root === undefined ? { mayInitialize } : { root, mayInitialize });
}

function assertNoExtraPositionals(args: ParsedArgs, expected: number): void {
  if (args.positionals.length > expected) throw invalid(`Unexpected argument: ${args.positionals[expected]}`);
}

function parseImportedDate(args: ParsedArgs, imported: boolean): Date | undefined {
  const raw = value(args, "created-at");
  if (!imported) {
    if (raw !== undefined) throw invalid("--created-at is available only through rwf import");
    return undefined;
  }
  if (!raw) throw invalid("import requires --created-at");
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw invalid("--created-at must be a valid RFC 3339 timestamp");
  return date;
}

function entryMetadata(args: ParsedArgs, type: "note" | "artifact"): Record<string, unknown> {
  const metadataPath = value(args, "metadata-file");
  const metadata = metadataPath
    ? parseMetadataFile(readFileSync(metadataPath, "utf8"), metadataPath)
    : {};
  for (const entry of values(args, "metadata")) {
    if (entry === "true") throw invalid("--metadata requires KEY=VALUE");
    const equal = entry.indexOf("=");
    if (equal <= 0) throw invalid(`Invalid metadata entry: ${entry}`);
    const key = entry.slice(0, equal);
    if (key in metadata) throw invalid(`Metadata field supplied more than once: ${key}`);
    metadata[key] = entry.slice(equal + 1);
  }
  const reserved = type === "artifact"
    ? ["id", "created_at", "title", "filename", "media_type", "size", "sha256"]
    : ["id", "created_at", "title"];
  for (const key of reserved) {
    if (key in metadata) throw invalid(`${key} is generated by rwf and cannot be supplied`);
  }
  const known: Array<[string, string | string[] | undefined]> = [
    ["author", value(args, "author")],
    ["task_id", value(args, "task")],
    ["collection", value(args, "collection")],
    ["topics", values(args, "topic").length ? values(args, "topic") : undefined],
    ["sources", values(args, "source").length ? values(args, "source") : undefined],
    ["action", value(args, "action")],
    ["targets", values(args, "target").length ? values(args, "target") : undefined],
    ...(type === "note"
      ? [["artifacts", values(args, "artifact").length ? values(args, "artifact") : undefined] as [
          string,
          string[] | undefined,
        ]]
      : []),
  ];
  for (const [key, entry] of known) {
    if (entry === undefined) continue;
    if (key in metadata) throw invalid(`Conflicting metadata field: ${key}`);
    metadata[key] = entry;
  }
  const action = metadata.action;
  const targets = metadata.targets;
  if (action !== undefined && (typeof action !== "string" || !["supersede", "delete", "restore"].includes(action))) {
    throw invalid(`Invalid action: ${String(action)}`);
  }
  if (action !== undefined && (!Array.isArray(targets) || targets.length === 0)) {
    throw invalid(`${String(action)} requires at least one target`);
  }
  if (action === undefined && targets !== undefined) throw invalid("targets requires action");
  return metadata;
}

function issuesText(issues: ValidationIssue[]): string {
  if (issues.length === 0) return "No issues found.";
  return issues.map((entry) => `${entry.severity.toUpperCase()} ${entry.code}: ${entry.message}`).join("\n");
}

function requireValid(paths: WorkspacePaths): ResolvedJournal {
  const result = validateWorkspace(paths);
  const errors = errorsOf(result);
  if (errors.length || !result.journal) {
    throw new RwfError("VALIDATION_FAILED", issuesText(result.issues), EXIT.validation, {
      issues: result.issues,
    });
  }
  return result.journal;
}

function entryJson(entry: ResearchEntry, journal?: ResolvedJournal): Record<string, unknown> {
  const common = {
    id: entry.id,
    type: entry.type,
    path: entry.relativePath,
    metadata: entry.metadata,
    ...(journal ? { status: journal.statuses.get(entry.id) } : {}),
  };
  return entry.type === "note"
    ? { ...common, body: entry.body, artifacts: entry.artifacts }
    : {
        ...common,
        payload_path: entry.payloadRelativePath,
        filename: entry.originalFilename,
        media_type: entry.mediaType,
        size: entry.size,
        sha256: entry.sha256,
      };
}

async function commandInit(args: ParsedArgs): Promise<void> {
  assertNoExtraPositionals(args, 1);
  const paths = workspace(args, true);
  initializeWorkspace(paths);
  const result = validateWorkspace(paths);
  const errors = errorsOf(result);
  if (errors.length) {
    throw new RwfError("INITIALIZATION_FAILED", issuesText(result.issues), EXIT.validation, {
      issues: result.issues,
    });
  }
  printResult(
    outputOptions(args),
    `Initialized research-workflow workspace\n${paths.root}`,
    { ok: true, workspace: { root: paths.root } },
  );
}

async function addNote(args: ParsedArgs, imported: boolean): Promise<void> {
  assertNoExtraPositionals(args, imported ? 2 : 2);
  const paths = workspace(args, true);
  initializeWorkspace(paths);
  const title = requireValue(args, "title");
  const file = value(args, "file");
  if (file && !existsSync(file)) throw invalid(`Body file does not exist: ${file}`);
  const body = file ? readFileSync(file, "utf8") : await readStdin();
  const importedDate = parseImportedDate(args, imported);
  const note = createNote(paths, {
    title,
    body,
    metadata: entryMetadata(args, "note"),
    ...(importedDate ? { now: importedDate } : {}),
  });
  printResult(
    outputOptions(args),
    `Created note ${note.id}\n${note.relativePath}`,
    { ok: true, note: entryJson(note) },
    note.id,
  );
}

async function addArtifact(args: ParsedArgs, imported: boolean): Promise<void> {
  assertNoExtraPositionals(args, 3);
  const paths = workspace(args, true);
  initializeWorkspace(paths);
  const positionalPath = args.positionals[2];
  const flagPath = value(args, "file");
  if (positionalPath && flagPath) throw invalid("Supply the artifact path as an argument or --file, not both");
  const sourcePath = positionalPath ?? flagPath;
  if (!sourcePath) throw invalid("artifact add requires FILE");
  const importedDate = parseImportedDate(args, imported);
  const artifact = createArtifact(paths, {
    title: requireValue(args, "title"),
    sourcePath,
    metadata: entryMetadata(args, "artifact"),
    ...(value(args, "media-type") ? { mediaType: value(args, "media-type")! } : {}),
    ...(importedDate ? { now: importedDate } : {}),
  });
  printResult(
    outputOptions(args),
    `Created artifact ${artifact.id}\n${artifact.payloadRelativePath}`,
    { ok: true, artifact: entryJson(artifact) },
    artifact.id,
  );
}

async function commandNoteShow(args: ParsedArgs): Promise<void> {
  const id = args.positionals[2];
  if (!id) throw invalid("note show requires NOTE_ID");
  const note = findNote(workspace(args), id);
  const metadataOnly = values(args, "metadata").includes("true");
  const bodyOnly = has(args, "body");
  if (metadataOnly && bodyOnly) throw invalid("--body and --metadata cannot be combined");
  const content = readFileSync(note.absolutePath, "utf8");
  const human = metadataOnly ? JSON.stringify(note.metadata, null, 2) : bodyOnly ? note.body : content;
  printResult(outputOptions(args), human, { ok: true, note: entryJson(note) });
}

async function commandNotePath(args: ParsedArgs): Promise<void> {
  const id = args.positionals[2];
  if (!id) throw invalid("note path requires NOTE_ID");
  const note = findNote(workspace(args), id);
  printResult(outputOptions(args), note.relativePath, { ok: true, path: note.relativePath }, note.relativePath);
}

function nestedMetadata(metadata: Record<string, unknown>, key: string): unknown {
  let current: unknown = metadata;
  for (const part of key.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function metadataMatches(entry: ResearchEntry, filters: string[]): boolean {
  return filters.every((filter) => {
    const equal = filter.indexOf("=");
    if (equal <= 0) throw invalid(`Invalid metadata filter: ${filter}`);
    const key = filter.slice(0, equal);
    const expected = filter.slice(equal + 1);
    const actual = nestedMetadata(entry.metadata, key);
    return typeof actual === "string" || typeof actual === "number" || typeof actual === "boolean"
      ? String(actual) === expected
      : JSON.stringify(actual) === expected;
  });
}

function entryMatches(entry: ResearchEntry, journal: ResolvedJournal, args: ParsedArgs): boolean {
  const status = journal.statuses.get(entry.id);
  if (has(args, "active") && status !== "active") return false;
  if (has(args, "superseded") && status !== "superseded") return false;
  if (has(args, "deleted") && status !== "deleted") return false;
  if (!has(args, "all") && !has(args, "active") && !has(args, "superseded") && !has(args, "deleted")) {
    if (status !== "active") return false;
  }
  const topic = value(args, "topic");
  if (topic && !entry.topics.includes(topic)) return false;
  const author = value(args, "author");
  if (author && entry.author !== author) return false;
  const task = value(args, "task");
  if (task && entry.taskId !== task) return false;
  const collection = value(args, "collection");
  if (collection && entry.collection !== collection) return false;
  const title = value(args, "title");
  if (title && !entry.title.toLocaleLowerCase().includes(title.toLocaleLowerCase())) return false;
  const since = value(args, "since");
  if (since) {
    const timestamp = new Date(since);
    if (Number.isNaN(timestamp.getTime())) throw invalid("--since must be a valid timestamp");
    if (entry.createdAt < timestamp.toISOString()) return false;
  }
  if (!metadataMatches(entry, values(args, "metadata").filter((entry) => entry !== "true"))) return false;
  if (entry.type === "note") {
    for (const artifactId of values(args, "artifact")) {
      if (!entry.artifacts.includes(artifactId)) return false;
    }
  } else if (values(args, "artifact").length) {
    return false;
  }
  return true;
}

function limitedEntries(entries: ResearchEntry[], args: ParsedArgs): ResearchEntry[] {
  const limitValue = value(args, "limit");
  if (!limitValue) return entries;
  const limit = Number.parseInt(limitValue, 10);
  if (!Number.isSafeInteger(limit) || limit < 0) throw invalid("--limit must be a non-negative integer");
  return entries.slice(0, limit);
}

function listEntries(
  entries: ResearchEntry[],
  journal: ResolvedJournal,
  args: ParsedArgs,
  noun: "notes" | "artifacts",
): void {
  const matches = limitedEntries(entries.filter((entry) => entryMatches(entry, journal, args)), args);
  const human = matches
    .map((entry) => `${entry.id}\t${journal.statuses.get(entry.id)}\t${entry.title}`)
    .join("\n");
  printResult(
    outputOptions(args),
    human || `No ${noun}.`,
    {
      ok: true,
      [noun]: matches.map((entry) => ({
        id: entry.id,
        title: entry.title,
        status: journal.statuses.get(entry.id),
        path: entry.relativePath,
      })),
    },
  );
}

async function commandNoteList(args: ParsedArgs): Promise<void> {
  const journal = requireValid(workspace(args));
  listEntries(journal.notes, journal, args, "notes");
}

async function commandNote(args: ParsedArgs): Promise<void> {
  const subcommand = args.positionals[1];
  if (subcommand === "add") return addNote(args, false);
  if (subcommand === "show") return commandNoteShow(args);
  if (subcommand === "path") return commandNotePath(args);
  if (subcommand === "list") return commandNoteList(args);
  throw invalid("note requires add, show, path, or list");
}

async function commandArtifactShow(args: ParsedArgs): Promise<void> {
  const id = args.positionals[2];
  if (!id) throw invalid("artifact show requires ARTIFACT_ID");
  const artifact = findArtifact(workspace(args), id);
  printResult(
    outputOptions(args),
    JSON.stringify(artifact.metadata, null, 2),
    { ok: true, artifact: entryJson(artifact) },
  );
}

async function commandArtifactPath(args: ParsedArgs): Promise<void> {
  const id = args.positionals[2];
  if (!id) throw invalid("artifact path requires ARTIFACT_ID");
  const artifact = findArtifact(workspace(args), id);
  printResult(
    outputOptions(args),
    artifact.payloadRelativePath,
    { ok: true, path: artifact.payloadRelativePath },
    artifact.payloadRelativePath,
  );
}

async function commandArtifactCat(args: ParsedArgs): Promise<void> {
  const id = args.positionals[2];
  if (!id) throw invalid("artifact cat requires ARTIFACT_ID");
  if (has(args, "json")) throw invalid("artifact cat does not support --json");
  const artifact = findArtifact(workspace(args), id);
  if (!has(args, "quiet")) process.stdout.write(readFileSync(artifact.payloadPath));
}

async function commandArtifactList(args: ParsedArgs): Promise<void> {
  const journal = requireValid(workspace(args));
  listEntries(journal.artifacts, journal, args, "artifacts");
}

async function commandArtifact(args: ParsedArgs): Promise<void> {
  const subcommand = args.positionals[1];
  if (subcommand === "add") return addArtifact(args, false);
  if (subcommand === "show") return commandArtifactShow(args);
  if (subcommand === "path") return commandArtifactPath(args);
  if (subcommand === "cat") return commandArtifactCat(args);
  if (subcommand === "list") return commandArtifactList(args);
  throw invalid("artifact requires add, show, path, cat, or list");
}

async function commandImport(args: ParsedArgs): Promise<void> {
  const type = args.positionals[1];
  if (type === "note") return addNote(args, true);
  if (type === "artifact") return addArtifact(args, true);
  throw invalid("import requires note or artifact");
}

function lineageOf(journal: ResolvedJournal, startId: string): {
  entries: ResearchEntry[];
  edges: Array<{ source: string; action: string; target: string; at: string }>;
} {
  const ids = new Set([startId]);
  const queue = [startId];
  while (queue.length) {
    const id = queue.shift()!;
    const entry = journal.byId.get(id);
    for (const target of entry?.targets ?? []) {
      if (!ids.has(target)) {
        ids.add(target);
        queue.push(target);
      }
    }
    for (const source of journal.incoming.get(id) ?? []) {
      if (!ids.has(source.id)) {
        ids.add(source.id);
        queue.push(source.id);
      }
    }
  }
  const entries = journal.entries.filter((entry) => ids.has(entry.id));
  const edges = entries.flatMap((entry) =>
    entry.action
      ? entry.targets
          .filter((target) => ids.has(target))
          .map((target) => ({ source: entry.id, action: entry.action!, target, at: entry.createdAt }))
      : [],
  );
  return { entries, edges };
}

async function commandInspect(args: ParsedArgs): Promise<void> {
  const id = args.positionals[1];
  if (!id) throw invalid("inspect requires ENTRY_ID");
  const result = validateWorkspace(workspace(args));
  const journal = result.journal;
  if (!journal) throw new RwfError("VALIDATION_FAILED", "Workspace could not be replayed", EXIT.validation);
  const entry = journal.byId.get(id);
  if (!entry) throw new RwfError("ENTRY_NOT_FOUND", `Entry not found: ${id}`, EXIT.notFound);
  const incoming = journal.incoming.get(id) ?? [];
  const history = journal.histories.get(id) ?? [];
  const relatedIssues = result.issues.filter(
    (issue) => issue.noteId === id || incoming.some((candidate) => candidate.id === issue.noteId),
  );
  const lineage = has(args, "lineage") ? lineageOf(journal, id) : undefined;
  const lines = [
    `Entry: ${entry.id}`,
    `Type: ${entry.type}`,
    `Title: ${entry.title}`,
    `Status: ${journal.statuses.get(entry.id)}`,
    `Path: ${entry.relativePath}`,
    "",
  ];
  if (entry.action) lines.push(`Action: ${entry.action} ${entry.targets.join(", ")}`, "");
  if (incoming.length) {
    lines.push("Targeted by:");
    for (const source of incoming) lines.push(`  ${source.id}  ${source.action}  ${source.title}`);
    lines.push("");
  }
  lines.push("History:");
  for (const event of history) {
    lines.push(`  ${event.at}  ${event.status}${event.by ? `  by ${event.by}` : ""}`);
  }
  if (lineage) {
    lines.push("", `Lineage: ${lineage.entries.length} entries, ${lineage.edges.length} relationships`);
    for (const edge of lineage.edges) lines.push(`  ${edge.source} --${edge.action}--> ${edge.target}`);
  }
  printResult(outputOptions(args), lines.join("\n"), {
    ok: true,
    entry: entryJson(entry, journal),
    incoming: incoming.map((candidate) => ({
      id: candidate.id,
      type: candidate.type,
      action: candidate.action,
      title: candidate.title,
    })),
    history,
    issues: relatedIssues,
    ...(lineage
      ? {
          lineage: {
            entries: lineage.entries.map((candidate) => entryJson(candidate, journal)),
            edges: lineage.edges,
          },
        }
      : {}),
  });
}

function idFromSearchPath(path: string): string | undefined {
  return path.match(/(?:^|[/\\])([0-7][0-9A-HJKMNP-TV-Z]{25})-/)?.[1];
}

function textMatches(text: string, query: string, regex: boolean, caseSensitive: boolean): boolean {
  if (regex) {
    try {
      return new RegExp(query, caseSensitive ? "" : "i").test(text);
    } catch (error) {
      throw invalid(`Invalid search expression: ${(error as Error).message}`);
    }
  }
  return caseSensitive
    ? text.includes(query)
    : text.toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

async function commandSearch(args: ParsedArgs): Promise<void> {
  const query = args.positionals[1];
  if (!query) throw invalid("search requires QUERY");
  assertNoExtraPositionals(args, 2);
  const paths = workspace(args);
  const journal = requireValid(paths);
  const fp = journalFingerprint(journal.entries);
  const state = readBuildState(paths);
  const useCurrent = existsSync(paths.current) && state?.viewBuiltThrough === fp && !has(args, "all")
    && !has(args, "superseded") && !has(args, "deleted");
  const searchRoots = useCurrent ? [paths.current] : [paths.journal, paths.artifacts];
  const rgArgs = ["-L", "--json", "--no-messages"];
  if (!has(args, "case-sensitive")) rgArgs.push("-i");
  if (!has(args, "regex")) rgArgs.push("-F");
  rgArgs.push("--", query, ...searchRoots);
  const run = spawnSync("rg", rgArgs, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (!run.error && run.status !== 0 && run.status !== 1) {
    throw new RwfError("SEARCH_FAILED", run.stderr || "ripgrep search failed", EXIT.general);
  }
  const snippets = new Map<string, string[]>();
  if (!run.error) {
    for (const line of run.stdout.split("\n")) {
      if (!line) continue;
      const event = JSON.parse(line) as {
        type: string;
        data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number };
      };
      if (event.type !== "match") continue;
      const id = idFromSearchPath(event.data?.path?.text ?? "");
      if (!id) continue;
      const valuesForId = snippets.get(id) ?? [];
      if (valuesForId.length < 3) {
        valuesForId.push(`${event.data?.line_number ?? "?"}: ${(event.data?.lines?.text ?? "").trim()}`);
      }
      snippets.set(id, valuesForId);
    }
  } else {
    for (const entry of journal.entries) {
      const content = entry.type === "note"
        ? readFileSync(entry.absolutePath, "utf8")
        : `${JSON.stringify(entry.metadata)}\n${readFileSync(entry.payloadPath, "utf8")}`;
      if (textMatches(content, query, has(args, "regex"), has(args, "case-sensitive"))) {
        snippets.set(entry.id, ["matched by built-in fallback"]);
      }
    }
  }
  for (const entry of journal.entries) {
    const searchable = `${entry.title}\n${JSON.stringify(entry.metadata)}`;
    if (textMatches(searchable, query, has(args, "regex"), has(args, "case-sensitive"))) {
      const existing = snippets.get(entry.id) ?? [];
      if (existing.length === 0) existing.push("metadata match");
      snippets.set(entry.id, existing);
    }
  }
  const matches = limitedEntries(
    journal.entries.filter((entry) => snippets.has(entry.id) && entryMatches(entry, journal, args)),
    args,
  );
  const human = matches
    .map((entry) => {
      const detail = snippets.get(entry.id)?.map((snippet) => `    ${snippet}`).join("\n") ?? "";
      return `${entry.id}\t${entry.type}\t${journal.statuses.get(entry.id)}\t${entry.title}\n${detail}`;
    })
    .join("\n");
  printResult(
    outputOptions(args),
    human || "No matches.",
    {
      ok: true,
      query,
      results: matches.map((entry) => ({
        id: entry.id,
        type: entry.type,
        title: entry.title,
        status: journal.statuses.get(entry.id),
        path: entry.relativePath,
        snippets: snippets.get(entry.id),
      })),
    },
  );
}

async function commandValidate(args: ParsedArgs): Promise<void> {
  const result = validateWorkspace(workspace(args));
  const errors = errorsOf(result);
  const summary = errors.length
    ? issuesText(result.issues)
    : `Validated ${result.journal?.entries.length ?? 0} entries with ${result.issues.length} warning(s).`;
  if (outputOptions(args).json) {
    printJson({
      ok: errors.length === 0,
      issues: result.issues,
      entries: result.journal?.entries.length ?? 0,
      notes: result.journal?.notes.length ?? 0,
      artifacts: result.journal?.artifacts.length ?? 0,
    });
  } else if (!outputOptions(args).quiet) {
    process.stdout.write(`${summary}\n`);
  }
  if (errors.length) {
    throw new RwfError("VALIDATION_FAILED", "Workspace validation failed", EXIT.validation, {
      alreadyPrinted: true,
      issues: result.issues,
    });
  }
}

function isBuildTarget(candidate: string): candidate is BuildTarget {
  return ["view", "index-current", "index-chronological", "index-topics", "index-all"].includes(candidate);
}

async function runBuild(paths: WorkspacePaths, target: BuildTarget, args: ParsedArgs): Promise<unknown> {
  const journal = requireValid(paths);
  if (target === "view") {
    const count = await buildView(paths, journal, !has(args, "no-wait"));
    return { target, active_entries: count };
  }
  const files = await buildIndexes(paths, journal, target);
  return { target, files };
}

async function commandBuild(args: ParsedArgs): Promise<void> {
  const target = args.positionals[1];
  if (!target || !isBuildTarget(target)) throw invalid("build requires a valid target");
  const result = await runBuild(workspace(args), target, args);
  const human = target === "view"
    ? `Built active view with ${(result as { active_entries: number }).active_entries} entries`
    : `Generated ${(result as { files: string[] }).files.length} index files`;
  printResult(outputOptions(args), human, { ok: true, result });
}

async function commandRefresh(args: ParsedArgs): Promise<void> {
  const paths = workspace(args);
  const journal = requireValid(paths);
  const active = await buildView(paths, journal);
  const files = await buildIndexes(paths, journal, "index-all");
  printResult(
    outputOptions(args),
    `Validated ${journal.entries.length} entries\nBuilt active view with ${active} entries\nGenerated ${files.length} index files`,
    { ok: true, entries: journal.entries.length, active_entries: active, files },
  );
}

async function commandStatus(args: ParsedArgs): Promise<void> {
  const paths = workspace(args);
  const result = validateWorkspace(paths);
  const journal = result.journal ?? replay([]);
  const counts = { active: 0, superseded: 0, deleted: 0 };
  for (const status of journal.statuses.values()) counts[status] += 1;
  const fp = journalFingerprint(journal.entries);
  const state = readBuildState(paths);
  const status = {
    entries: journal.entries.length,
    notes: journal.notes.length,
    artifacts: journal.artifacts.length,
    action_entries: journal.entries.filter((entry) => entry.action).length,
    ...counts,
    conflicts: relationshipIssues(journal).length,
    validation_errors: errorsOf(result).length,
    current_view: state?.viewBuiltThrough === fp ? "current" : "stale",
    indexes: state?.indexesBuiltThrough === fp ? "current" : "stale",
  };
  const human = [
    `Entries:              ${status.entries}`,
    `Notes:                ${status.notes}`,
    `Artifacts:            ${status.artifacts}`,
    `Action entries:       ${status.action_entries}`,
    `Active entries:       ${status.active}`,
    `Superseded entries:   ${status.superseded}`,
    `Deleted entries:      ${status.deleted}`,
    `Conflicts:            ${status.conflicts}`,
    `Validation errors:    ${status.validation_errors}`,
    `Current view:         ${status.current_view}`,
    `Indexes:              ${status.indexes}`,
  ].join("\n");
  printResult(outputOptions(args), human, { ok: true, status });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (has(args, "help") || args.positionals.length === 0) {
    process.stdout.write(HELP);
    return;
  }
  const command = args.positionals[0];
  if (command === "init") return commandInit(args);
  if (command === "note") return commandNote(args);
  if (command === "artifact") return commandArtifact(args);
  if (command === "import") return commandImport(args);
  if (command === "inspect") return commandInspect(args);
  if (command === "search") return commandSearch(args);
  if (command === "build") return commandBuild(args);
  if (command === "refresh") return commandRefresh(args);
  if (command === "validate") return commandValidate(args);
  if (command === "status") return commandStatus(args);
  throw invalid(`Unknown command: ${command}`);
}

try {
  await main();
} catch (error: unknown) {
  const rwfError = error instanceof RwfError
    ? error
    : new RwfError("GENERAL_FAILURE", error instanceof Error ? error.message : String(error), EXIT.general);
  const parsed = (() => {
    try {
      return parseArgs(process.argv.slice(2));
    } catch {
      return { positionals: [], flags: new Map<string, string[]>() };
    }
  })();
  if (!rwfError.details.alreadyPrinted) {
    if (has(parsed, "json")) {
      printJson({
        ok: false,
        error: { code: rwfError.code, message: rwfError.message, details: rwfError.details },
      });
    } else {
      process.stderr.write(`rwf: ${rwfError.message}\n`);
    }
  }
  process.exitCode = rwfError.exitCode;
}
