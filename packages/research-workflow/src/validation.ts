import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { Artifact, Note, ResearchEntry, ValidationIssue, ValidationResult, WorkspacePaths } from "./types.js";
import { noteFromFile } from "./journal.js";
import { artifactFromMetadata } from "./artifacts.js";
import { relationshipIssues, replay } from "./replay.js";
import { ULID_PATTERN, walkFiles } from "./util.js";

function issue(
  severity: "error" | "warning",
  code: string,
  message: string,
  extra: Partial<ValidationIssue> = {},
): ValidationIssue {
  return { severity, code, message, ...extra };
}

function validateFilesystem(paths: WorkspacePaths): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const path of [paths.marker, paths.locks, paths.temp, paths.state, paths.journal, paths.artifacts]) {
    if (!existsSync(path)) issues.push(issue("error", "MISSING_DIRECTORY", `Missing directory: ${path}`, { path }));
  }
  try {
    accessSync(paths.root, constants.R_OK | constants.W_OK);
  } catch {
    issues.push(issue("error", "WORKSPACE_NOT_WRITABLE", `Workspace is not writable: ${paths.root}`));
  }
  if (!existsSync(paths.temp)) return issues;
  const token = `${process.pid}-${Date.now()}`;
  const source = join(paths.temp, `validate-${token}`);
  const renamed = `${source}.renamed`;
  const link = `${source}.link`;
  try {
    writeFileSync(source, "probe", { flag: "wx" });
    renameSync(source, renamed);
    symlinkSync(basename(renamed), link);
    if (readFileSync(link, "utf8") !== "probe") throw new Error("symlink probe content mismatch");
    const lockProbe = join(paths.locks, `validate-${token}.lock`);
    const lockFd = openSync(lockProbe, "wx");
    closeSync(lockFd);
    unlinkSync(lockProbe);
    const devices = [paths.temp, paths.journal, paths.artifacts, paths.root].map((path) => statSync(path).dev);
    if (new Set(devices).size !== 1) throw new Error("temporary and final directories are on different filesystems");
  } catch (error) {
    issues.push(issue("error", "FILESYSTEM_CAPABILITY", `Filesystem capability check failed: ${String(error)}`));
  } finally {
    for (const path of [link, source, renamed]) {
      try {
        unlinkSync(path);
      } catch {
        // Best-effort cleanup; stranded probes are reported below.
      }
    }
  }
  const now = Date.now();
  for (const path of walkFiles(paths.temp)) {
    try {
      if (now - lstatSync(path).mtimeMs > 24 * 60 * 60 * 1_000) {
        issues.push(issue("warning", "STRANDED_TEMP", `Old temporary file: ${path}`, { path }));
      }
    } catch {
      // A concurrent writer may remove a temporary file.
    }
  }
  for (const entry of existsSync(paths.locks) ? readdirSync(paths.locks) : []) {
    if (!entry.endsWith(".lock")) continue;
    const path = join(paths.locks, entry);
    try {
      const data = JSON.parse(readFileSync(path, "utf8")) as { pid?: number; hostname?: string };
      if (data.hostname === hostname() && typeof data.pid === "number") {
        try {
          process.kill(data.pid, 0);
        } catch {
          issues.push(issue("warning", "ABANDONED_LOCK", `Lock holder is not running: ${path}`, { path }));
        }
      }
    } catch {
      issues.push(issue("warning", "INVALID_LOCK", `Unreadable lock file: ${path}`, { path }));
    }
  }
  return issues;
}

function validateDerived(paths: WorkspacePaths, journal: ReturnType<typeof replay>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (existsSync(paths.current)) {
    for (const section of readdirSync(paths.current)) {
      const sectionPath = join(paths.current, section);
      if (!["notes", "artifacts"].includes(section) || !lstatSync(sectionPath).isDirectory()) {
        issues.push(issue("error", "UNEXPECTED_CURRENT_ENTRY", `Unexpected current entry: ${sectionPath}`, { path: sectionPath }));
        continue;
      }
      for (const entry of readdirSync(sectionPath)) {
        const path = join(sectionPath, entry);
        try {
          if (!lstatSync(path).isSymbolicLink()) {
            issues.push(issue("error", "UNEXPECTED_CURRENT_FILE", `Current entry is not a symlink: ${path}`, { path }));
            continue;
          }
          const target = resolve(dirname(path), readlinkSync(path));
          if (!existsSync(target)) {
            issues.push(issue("error", "BROKEN_CURRENT_LINK", `Broken current symlink: ${path}`, { path }));
            continue;
          }
          const id = entry.match(/^([0-7][0-9A-HJKMNP-TV-Z]{25})-/)?.[1];
          const canonical = id ? journal.byId.get(id) : undefined;
          if (!canonical || canonical.type !== (section === "notes" ? "note" : "artifact")) {
            issues.push(issue("error", "UNKNOWN_CURRENT_ENTRY", `Current link has no matching canonical entry: ${path}`, { path }));
          } else if (resolve(target) !== resolve(canonical.absolutePath)) {
            issues.push(issue("error", "WRONG_CURRENT_TARGET", `Current link points to the wrong canonical file: ${path}`, {
              noteId: canonical.id,
              path,
            }));
          }
        } catch (error) {
          issues.push(issue("error", "INVALID_CURRENT_ENTRY", `${path}: ${String(error)}`, { path }));
        }
      }
    }
  }
  if (existsSync(paths.indexes)) {
    const allowed = new Set([
      "current.md",
      "chronological.md",
      "topics.md",
      "topics",
      "collections.md",
      "collections",
      "artifacts.md",
      "manifest.json",
      "manifest.schema.json",
    ]);
    for (const entry of readdirSync(paths.indexes)) {
      if (!allowed.has(entry)) {
        issues.push(
          issue("error", "UNEXPECTED_INDEX_FILE", `Unexpected file in indexes: ${join(paths.indexes, entry)}`),
        );
      }
    }
  }
  return issues;
}

export function validateWorkspace(paths: WorkspacePaths): ValidationResult {
  const issues = [...validateFilesystem(paths)];
  const notes: Note[] = [];
  for (const path of walkFiles(paths.journal, ".md")) {
    try {
      const note = noteFromFile(paths, path);
      const filenameId = basename(path).split("-", 1)[0] ?? "";
      if (!ULID_PATTERN.test(filenameId) || filenameId !== note.id) {
        issues.push(
          issue("error", "FILENAME_ID_MISMATCH", `Filename id does not match frontmatter: ${path}`, {
            noteId: note.id,
            path,
          }),
        );
      }
      notes.push(note);
    } catch (error) {
      issues.push(issue("error", "INVALID_NOTE", `${path}: ${(error as Error).message}`, { path }));
    }
  }
  const artifacts: Artifact[] = [];
  const artifactFiles = walkFiles(paths.artifacts);
  const allowedArtifactFiles = new Set<string>();
  for (const path of artifactFiles.filter((candidate) => basename(candidate) === "metadata.json")) {
    try {
      const artifact = artifactFromMetadata(paths, path);
      const directoryId = basename(dirname(path)).split("-", 1)[0] ?? "";
      if (!ULID_PATTERN.test(directoryId) || directoryId !== artifact.id) {
        issues.push(
          issue("error", "ARTIFACT_DIRECTORY_ID_MISMATCH", `Artifact directory id does not match metadata: ${path}`, {
            noteId: artifact.id,
            path,
          }),
        );
      }
      if (!existsSync(artifact.payloadPath)) {
        issues.push(issue("error", "MISSING_ARTIFACT_PAYLOAD", `Artifact payload is missing: ${artifact.payloadPath}`, {
          noteId: artifact.id,
          path: artifact.payloadPath,
        }));
      } else {
        const bytes = readFileSync(artifact.payloadPath);
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (bytes.length !== artifact.size || digest !== artifact.sha256) {
          issues.push(issue("error", "ARTIFACT_INTEGRITY", `Artifact payload does not match its metadata: ${artifact.payloadPath}`, {
            noteId: artifact.id,
            path: artifact.payloadPath,
          }));
        }
      }
      artifacts.push(artifact);
      allowedArtifactFiles.add(path);
      allowedArtifactFiles.add(artifact.payloadPath);
    } catch (error) {
      issues.push(issue("error", "INVALID_ARTIFACT", `${path}: ${(error as Error).message}`, { path }));
    }
  }
  for (const path of artifactFiles) {
    if (!allowedArtifactFiles.has(path)) {
      issues.push(issue("error", "UNEXPECTED_ARTIFACT_FILE", `Unexpected file in artifact record: ${path}`, { path }));
    }
  }
  const entries: ResearchEntry[] = [...notes, ...artifacts];
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
  for (const [id, count] of counts) {
    if (count > 1) issues.push(issue("error", "DUPLICATE_ID", `Duplicate note id: ${id}`, { noteId: id }));
  }
  const journal = replay(entries);
  issues.push(...relationshipIssues(journal));
  for (const note of journal.notes) {
    for (const artifactId of note.artifacts) {
      const target = journal.byId.get(artifactId);
      if (!target) {
        issues.push(issue("error", "MISSING_ARTIFACT_REFERENCE", `Referenced artifact does not exist: ${artifactId}`, {
          noteId: note.id,
        }));
      } else if (target.type !== "artifact") {
        issues.push(issue("error", "REFERENCE_IS_NOT_ARTIFACT", `Referenced entry is not an artifact: ${artifactId}`, {
          noteId: note.id,
        }));
      }
    }
  }
  issues.push(...validateDerived(paths, journal));
  return { issues, journal };
}

export function errorsOf(result: ValidationResult): ValidationIssue[] {
  return result.issues.filter((entry) => entry.severity === "error");
}
