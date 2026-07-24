import { closeSync, constants, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { EXIT, RwfError } from "./errors.js";
import type { WorkspacePaths } from "./types.js";

export interface HeldLock {
  path: string;
  release(): void;
}

export async function acquireLock(
  paths: WorkspacePaths,
  name: string,
  command: string,
  wait = true,
  timeoutMs = 5_000,
): Promise<HeldLock> {
  const path = join(paths.locks, `${name}.lock`);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o644);
      writeFileSync(
        fd,
        `${JSON.stringify(
          { pid: process.pid, hostname: hostname(), created_at: new Date().toISOString(), command },
          null,
          2,
        )}\n`,
      );
      closeSync(fd);
      let released = false;
      return {
        path,
        release() {
          if (released) return;
          released = true;
          try {
            unlinkSync(path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!wait || Date.now() >= deadline) {
        let holder = "";
        try {
          holder = readFileSync(path, "utf8");
        } catch {
          // The holder may have released it between attempts.
        }
        throw new RwfError("LOCK_UNAVAILABLE", `Lock unavailable: ${name}`, EXIT.lockUnavailable, {
          lock: path,
          holder,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

export async function withLock<T>(
  paths: WorkspacePaths,
  name: string,
  command: string,
  callback: () => Promise<T> | T,
  wait = true,
): Promise<T> {
  const lock = await acquireLock(paths, name, command, wait);
  try {
    return await callback();
  } finally {
    lock.release();
  }
}
