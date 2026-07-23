import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BuildState, ResearchEntry, WorkspacePaths } from "./types.js";
import { fingerprint, replaceFile } from "./util.js";

export function journalFingerprint(entries: ResearchEntry[]): string {
  return fingerprint(
    entries.map((entry) => `${entry.type}\t${entry.id}\t${entry.createdAt}\t${entry.relativePath}`).sort(),
  );
}

export function readBuildState(paths: WorkspacePaths): BuildState | undefined {
  const path = join(paths.state, "build.json");
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as BuildState;
  } catch {
    return undefined;
  }
}

export function updateBuildState(
  paths: WorkspacePaths,
  fingerprintValue: string,
  field: "viewBuiltThrough" | "indexesBuiltThrough",
): void {
  const previous = readBuildState(paths) ?? { fingerprint: fingerprintValue };
  const next: BuildState = { ...previous, fingerprint: fingerprintValue, [field]: fingerprintValue };
  replaceFile(paths.temp, join(paths.state, "build.json"), `${JSON.stringify(next, null, 2)}\n`);
}
