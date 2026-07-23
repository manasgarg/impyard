import {
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ulid } from "ulid";
import type { Artifact, Note, ResearchEntry, ResolvedJournal, WorkspacePaths } from "./types.js";
import { withLock } from "./locks.js";
import { journalFingerprint, updateBuildState } from "./state.js";
import {
  relativePosix,
  removeIfExists,
  replaceDirectory,
  replaceFile,
  slugify,
} from "./util.js";

export type BuildTarget =
  | "view"
  | "index-current"
  | "index-chronological"
  | "index-topics"
  | "index-all";

function activeEntries(journal: ResolvedJournal): ResearchEntry[] {
  return journal.entries.filter((entry) => journal.statuses.get(entry.id) === "active");
}

function titleOrder(a: ResearchEntry, b: ResearchEntry): number {
  return a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id);
}

function linkFor(entry: ResearchEntry, nested = false): string {
  const section = entry.type === "note" ? "notes" : "artifacts";
  return `${nested ? "../../" : "../"}current/${section}/${entry.filename}`;
}

function escapedTitle(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function entryLink(entry: ResearchEntry, nested = false): string {
  return `[${escapedTitle(entry.title)}](${linkFor(entry, nested)})`;
}

function currentIndex(entries: ResearchEntry[]): string {
  const notes = entries.filter((entry) => entry.type === "note").sort(titleOrder);
  const artifacts = entries.filter((entry) => entry.type === "artifact").sort(titleOrder);
  const lines = ["# Current Research", "", `Active notes: ${notes.length}`, `Active artifacts: ${artifacts.length}`, ""];
  lines.push("## Notes", "");
  for (const note of notes) lines.push(`- ${entryLink(note)}`);
  lines.push("", "## Artifacts", "");
  for (const artifact of artifacts) {
    lines.push(`- ${entryLink(artifact)} — ${artifact.mediaType}, ${artifact.size} bytes`);
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function chronologicalIndex(entries: ResearchEntry[]): string {
  const groups = new Map<string, ResearchEntry[]>();
  for (const entry of entries) {
    const date = entry.createdAt.slice(0, 10);
    const list = groups.get(date) ?? [];
    list.push(entry);
    groups.set(date, list);
  }
  const lines = ["# Research by Date", ""];
  for (const date of [...groups.keys()].sort().reverse()) {
    lines.push(`## ${date}`, "");
    const dated = groups.get(date)!.sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
    for (const entry of dated) lines.push(`- ${entryLink(entry)} — ${entry.type}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function displayName(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

function groupedPages(
  entries: ResearchEntry[],
  valuesFor: (entry: ResearchEntry) => string[],
  heading: string,
  directory: "topics" | "collections",
): Record<string, string> {
  const groups = new Map<string, { names: Set<string>; entries: ResearchEntry[] }>();
  for (const entry of entries) {
    for (const value of valuesFor(entry)) {
      const key = slugify(value);
      const group = groups.get(key) ?? { names: new Set<string>(), entries: [] };
      group.names.add(value);
      if (!group.entries.some((candidate) => candidate.id === entry.id)) group.entries.push(entry);
      groups.set(key, group);
    }
  }
  const files: Record<string, string> = {};
  const summary = [`# ${heading}`, ""];
  for (const [key, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const title = [...group.names].sort().map(displayName).join(" / ");
    summary.push(`- [${escapedTitle(title)}](${directory}/${key}.md) (${group.entries.length})`);
    const lines = [`# ${title}`, ""];
    for (const entry of group.entries.sort(titleOrder)) lines.push(`- ${entryLink(entry, true)} — ${entry.type}`);
    files[`${directory}/${key}.md`] = `${lines.join("\n")}\n`;
  }
  files[`${directory}.md`] = `${summary.join("\n")}\n`;
  return files;
}

function artifactsIndex(entries: ResearchEntry[]): string {
  const artifacts = entries.filter((entry): entry is Artifact => entry.type === "artifact").sort(titleOrder);
  const lines = ["# Active Artifacts", ""];
  for (const artifact of artifacts) {
    lines.push(
      `- ${entryLink(artifact)} — ${artifact.originalFilename}; ${artifact.mediaType}; ${artifact.size} bytes; SHA-256 \`${artifact.sha256}\``,
    );
  }
  return `${lines.join("\n")}\n`;
}

function manifestEntry(paths: WorkspacePaths, journal: ResolvedJournal, entry: ResearchEntry): Record<string, unknown> {
  const section = entry.type === "note" ? "notes" : "artifacts";
  const active = journal.statuses.get(entry.id) === "active";
  const base = {
    id: entry.id,
    type: entry.type,
    status: journal.statuses.get(entry.id),
    title: entry.title,
    created_at: entry.createdAt,
    metadata: entry.metadata,
    action: entry.action ?? null,
    targets: entry.targets,
    canonical_path: entry.relativePath,
    current_path: active
      ? relativePosix(paths.root, join(paths.current, section, entry.filename))
      : null,
  };
  if (entry.type === "note") {
    return {
      ...base,
      artifacts: entry.artifacts,
      content_sha256: createHash("sha256").update(readFileSync(entry.absolutePath)).digest("hex"),
    };
  }
  return {
    ...base,
    payload_path: entry.payloadRelativePath,
    filename: entry.originalFilename,
    media_type: entry.mediaType,
    size: entry.size,
    sha256: entry.sha256,
  };
}

function manifest(paths: WorkspacePaths, journal: ResolvedJournal, entries: ResearchEntry[]): string {
  const data = {
    $schema: "./manifest.schema.json",
    schema_version: 1,
    generated_at: new Date().toISOString(),
    notes: entries
      .filter((entry): entry is Note => entry.type === "note")
      .sort(titleOrder)
      .map((entry) => manifestEntry(paths, journal, entry)),
    artifacts: entries
      .filter((entry): entry is Artifact => entry.type === "artifact")
      .sort(titleOrder)
      .map((entry) => manifestEntry(paths, journal, entry)),
  };
  return `${JSON.stringify(data, null, 2)}\n`;
}

function schemaContent(): string {
  const path = fileURLToPath(new URL("../schemas/manifest.schema.json", import.meta.url));
  return readFileSync(path, "utf8");
}

function allIndexFiles(
  paths: WorkspacePaths,
  journal: ResolvedJournal,
  entries: ResearchEntry[],
): Record<string, string> {
  return {
    "current.md": currentIndex(entries),
    "chronological.md": chronologicalIndex(entries),
    ...groupedPages(entries, (entry) => entry.topics, "Topics", "topics"),
    ...groupedPages(
      entries,
      (entry) => entry.collection ? [entry.collection] : [],
      "Collections",
      "collections",
    ),
    "artifacts.md": artifactsIndex(entries),
    "manifest.json": manifest(paths, journal, journal.entries),
    "manifest.schema.json": schemaContent(),
  };
}

export async function buildView(
  paths: WorkspacePaths,
  journal: ResolvedJournal,
  wait = true,
): Promise<number> {
  return withLock(paths, "view", "rwf build view", () => {
    const temp = join(paths.temp, `current-${ulid()}`);
    const notesDirectory = join(temp, "notes");
    const artifactsDirectory = join(temp, "artifacts");
    mkdirSync(notesDirectory, { recursive: true });
    mkdirSync(artifactsDirectory, { recursive: true });
    const entries = activeEntries(journal);
    try {
      for (const entry of entries) {
        const destinationDirectory = entry.type === "note" ? notesDirectory : artifactsDirectory;
        const finalDirectory = entry.type === "note"
          ? join(paths.current, "notes")
          : join(paths.current, "artifacts");
        const target = relative(finalDirectory, entry.absolutePath);
        symlinkSync(target, join(destinationDirectory, entry.filename));
      }
      replaceDirectory(temp, paths.current);
    } catch (error) {
      removeIfExists(temp);
      throw error;
    }
    const fp = journalFingerprint(journal.entries);
    updateBuildState(paths, fp, "viewBuiltThrough");
    return entries.length;
  }, wait);
}

function writeIndexTree(root: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
  }
}

export async function buildIndexes(
  paths: WorkspacePaths,
  journal: ResolvedJournal,
  target: Exclude<BuildTarget, "view">,
): Promise<string[]> {
  return withLock(paths, "index", `rwf build ${target}`, () => {
    const entries = activeEntries(journal);
    const allFiles = allIndexFiles(paths, journal, entries);
    let files: Record<string, string>;
    if (target === "index-current") files = { "current.md": allFiles["current.md"]! };
    else if (target === "index-chronological") {
      files = { "chronological.md": allFiles["chronological.md"]! };
    } else if (target === "index-topics") {
      files = Object.fromEntries(
        Object.entries(allFiles).filter(([name]) => name === "topics.md" || name.startsWith("topics/")),
      );
    } else {
      files = allFiles;
    }

    if (target === "index-all") {
      const temp = join(paths.temp, `indexes-${ulid()}`);
      mkdirSync(temp, { recursive: true });
      try {
        writeIndexTree(temp, files);
        replaceDirectory(temp, paths.indexes);
      } catch (error) {
        removeIfExists(temp);
        throw error;
      }
      updateBuildState(paths, journalFingerprint(journal.entries), "indexesBuiltThrough");
    } else if (target === "index-topics") {
      mkdirSync(paths.indexes, { recursive: true });
      const tempTopics = join(paths.temp, `topics-${ulid()}`);
      mkdirSync(tempTopics, { recursive: true });
      try {
        const topicPages = Object.fromEntries(
          Object.entries(files)
            .filter(([name]) => name.startsWith("topics/"))
            .map(([name, content]) => [name.slice("topics/".length), content]),
        );
        writeIndexTree(tempTopics, topicPages);
        replaceDirectory(tempTopics, join(paths.indexes, "topics"));
        replaceFile(paths.temp, join(paths.indexes, "topics.md"), files["topics.md"]!);
      } catch (error) {
        removeIfExists(tempTopics);
        throw error;
      }
    } else {
      mkdirSync(paths.indexes, { recursive: true });
      for (const [name, content] of Object.entries(files)) {
        replaceFile(paths.temp, join(paths.indexes, name), content);
      }
    }
    return Object.keys(files);
  });
}
