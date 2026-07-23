import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { EXIT, RwfError } from "./errors.js";
import type { WorkspacePaths } from "./types.js";

export function pathsFor(root: string): WorkspacePaths {
  const absolute = resolve(root);
  const marker = join(absolute, ".rwf");
  return {
    root: absolute,
    marker,
    locks: join(marker, "locks"),
    temp: join(marker, "tmp"),
    state: join(marker, "state"),
    journal: join(absolute, "journal"),
    artifacts: join(absolute, "artifacts"),
    current: join(absolute, "current"),
    indexes: join(absolute, "indexes"),
    site: join(absolute, "site"),
  };
}

function assertExistingDirectory(path: string): void {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new RwfError(
      "ROOT_NOT_FOUND",
      `Workspace root does not exist: ${path}`,
      EXIT.filesystem,
      { root: path },
    );
  }
  if (!stat.isDirectory()) {
    throw new RwfError("ROOT_NOT_DIRECTORY", `Workspace root is not a directory: ${path}`, EXIT.filesystem);
  }
}

function findAncestor(start: string): string | undefined {
  let candidate = resolve(start);
  while (true) {
    if (existsSync(join(candidate, ".rwf"))) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) return undefined;
    candidate = parent;
  }
}

export function resolveWorkspace(options: {
  root?: string;
  mayInitialize: boolean;
  cwd?: string;
}): WorkspacePaths {
  const cwd = resolve(options.cwd ?? process.cwd());
  const explicit = options.root ?? process.env.RWF_ROOT;
  const selected = explicit ? resolve(explicit) : findAncestor(cwd) ?? (options.mayInitialize ? cwd : undefined);
  if (!selected) {
    throw new RwfError(
      "WORKSPACE_NOT_INITIALIZED",
      "No research-workflow workspace found",
      EXIT.notInitialized,
    );
  }
  assertExistingDirectory(selected);
  const paths = pathsFor(selected);
  if (!existsSync(paths.marker) && !options.mayInitialize) {
    throw new RwfError(
      "WORKSPACE_NOT_INITIALIZED",
      `Workspace is not initialized: ${selected}`,
      EXIT.notInitialized,
      { root: selected },
    );
  }
  return paths;
}

export function initializeWorkspace(paths: WorkspacePaths): void {
  assertExistingDirectory(paths.root);
  for (const path of [paths.marker, paths.locks, paths.temp, paths.state, paths.journal, paths.artifacts]) {
    mkdirSync(path, { recursive: true });
  }
}
