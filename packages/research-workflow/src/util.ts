import {
  closeSync,
  constants,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  fsyncSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, sep } from "node:path";

export const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "note";
}

export function toPosix(value: string): string {
  return value.split(sep).join("/");
}

export function relativePosix(from: string, to: string): string {
  return toPosix(relative(from, to));
}

export function walkFiles(root: string, suffix?: string): string[] {
  const result: string[] = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    throw error;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...walkFiles(path, suffix));
    else if (entry.isFile() && (!suffix || entry.name.endsWith(suffix))) result.push(path);
  }
  return result.sort();
}

export function atomicWrite(tempDir: string, finalPath: string, content: string): void {
  mkdirSync(tempDir, { recursive: true });
  mkdirSync(dirname(finalPath), { recursive: true });
  const tempPath = join(
    tempDir,
    `.write-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const fd = openSync(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o644);
  try {
    writeSync(fd, content, undefined, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tempPath, finalPath);
  } finally {
    unlinkSync(tempPath);
  }
}

export function writeDurableFile(path: string, content: string | Buffer, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
  try {
    if (typeof content === "string") writeSync(fd, content, undefined, "utf8");
    else writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function replaceFile(tempDir: string, finalPath: string, content: string): void {
  mkdirSync(tempDir, { recursive: true });
  mkdirSync(dirname(finalPath), { recursive: true });
  const tempPath = join(
    tempDir,
    `.replace-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  writeFileSync(tempPath, content, { encoding: "utf8", mode: 0o644 });
  renameSync(tempPath, finalPath);
}

export function readText(path: string): string {
  return readFileSync(path, "utf8");
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function removeIfExists(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export function replaceDirectory(tempPath: string, finalPath: string): void {
  const backup = `${finalPath}.old-${process.pid}-${Date.now()}`;
  let hadFinal = false;
  try {
    statSync(finalPath);
    hadFinal = true;
    renameSync(finalPath, backup);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    renameSync(tempPath, finalPath);
    if (hadFinal) removeIfExists(backup);
  } catch (error) {
    if (hadFinal) renameSync(backup, finalPath);
    throw error;
  }
}

export function fingerprint(values: string[]): string {
  return createHash("sha256").update(values.join("\n")).digest("hex");
}

export function compareCreated(
  a: { createdAt: string; id: string },
  b: { createdAt: string; id: string },
): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}
