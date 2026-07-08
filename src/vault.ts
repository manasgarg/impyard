// The vault: the gateway's own credential store, host-side.
//
// Lives at ~/.roster/vault/ — outside the repo and outside the box mount, so
// the box never sees it. The gateway reads credentials from here to inject
// them in transit (src/gateway.ts); the box holds only sentinels. For now
// the store is plain JSON files seeded from the host's pi auth by
// `vault-sync`; a real secrets manager replaces the files later without
// moving the door. See docs/injection-spec.md.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const VAULT_DIR = join(homedir(), ".roster", "vault");

/** A stored credential. OAuth today; api-key shapes later. Kept raw so the
 * injector renders headers at call time (and refresh can update `access`). */
export interface Credential {
  type: string;
  access?: string;
  refresh?: string;
  expires?: number;
  accountId?: string;
  [k: string]: unknown;
}

export function getCredential(name: string): Credential | null {
  const path = join(VAULT_DIR, `${name}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Credential;
}

/** Seed the vault from the host's pi auth (dev path). Returns the names
 * written. Overwrites — the host auth is the source of truth for now. */
export function syncFromPiAuth(): string[] {
  const src = join(homedir(), ".pi/agent/auth.json");
  if (!existsSync(src)) throw new Error(`no pi auth to sync from at ${src}`);
  mkdirSync(VAULT_DIR, { recursive: true });
  const auth = JSON.parse(readFileSync(src, "utf8")) as Record<string, Credential>;
  const written: string[] = [];
  for (const [name, cred] of Object.entries(auth)) {
    writeFileSync(join(VAULT_DIR, `${name}.json`), JSON.stringify(cred, null, 2) + "\n", { mode: 0o600 });
    written.push(name);
  }
  return written;
}

export function vaultNames(): string[] {
  if (!existsSync(VAULT_DIR)) return [];
  return readdirSync(VAULT_DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
}
