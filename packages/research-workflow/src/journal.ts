import { basename, join } from "node:path";
import { readFileSync } from "node:fs";
import { ulid } from "ulid";
import type { Note, WorkspacePaths } from "./types.js";
import { atomicWrite, relativePosix, slugify, walkFiles } from "./util.js";
import { parseMarkdown, serializeMarkdown } from "./frontmatter.js";
import { invalid, notFound } from "./errors.js";
import { commonFields, stringList } from "./entry.js";

export function noteFromFile(paths: WorkspacePaths, absolutePath: string): Note {
  const parsed = parseMarkdown(readFileSync(absolutePath, "utf8"), absolutePath);
  const common = commonFields(parsed.metadata, absolutePath);
  const note: Note = {
    type: "note",
    ...common,
    body: parsed.body,
    artifacts: stringList(parsed.metadata.artifacts, "artifacts"),
    absolutePath,
    relativePath: relativePosix(paths.root, absolutePath),
    filename: basename(absolutePath),
  };
  return note;
}

export function loadNotes(paths: WorkspacePaths): Note[] {
  return walkFiles(paths.journal, ".md").map((path) => noteFromFile(paths, path));
}

export function findNote(paths: WorkspacePaths, id: string): Note {
  const matches = loadNotes(paths).filter((note) => note.id === id);
  if (matches.length === 0) throw notFound(`Note not found: ${id}`, { noteId: id });
  if (matches.length > 1) throw invalid(`Duplicate note id: ${id}`);
  return matches[0]!;
}

export function createNote(
  paths: WorkspacePaths,
  input: {
    title: string;
    body: string;
    metadata: Record<string, unknown>;
    now?: Date;
  },
): Note {
  const now = input.now ?? new Date();
  const id = ulid(now.getTime());
  const createdAt = now.toISOString();
  const metadata: Record<string, unknown> = {
    id,
    created_at: createdAt,
    ...input.metadata,
    title: input.title,
  };
  const datePath = createdAt.slice(0, 10).replaceAll("-", "/");
  const filename = `${id}-${slugify(input.title)}.md`;
  const absolutePath = join(paths.journal, datePath, filename);
  atomicWrite(paths.temp, absolutePath, serializeMarkdown(metadata, input.body));
  return noteFromFile(paths, absolutePath);
}
