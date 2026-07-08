// Proves the refresh SUCCESS path end to end against a local mock token
// endpoint — no real provider, no real token consumed. Complements the pure
// unit tests (refresh.test.ts) and the live checks in the transcript.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

test("getFreshCredential refreshes an expired token, captures rotation, merges, and persists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "roster-vault-"));
  process.env.ROSTER_VAULT_DIR = dir; // set before importing vault.ts (module-const)
  const { getFreshCredential } = await import("../src/vault.ts");
  const { PROVIDERS } = await import("../src/providers.ts");

  // A local stand-in for the provider's token endpoint.
  let received: { body: string } | null = null;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received = { body };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "fresh-access", refresh_token: "rotated-refresh", expires_in: 3600 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  PROVIDERS["mock"] = { tokenUrl: `http://127.0.0.1:${port}/token`, clientId: "mock-cid", encoding: "form", skewMs: 0 };

  // An expired credential with an extra field (accountId) to prove the merge.
  writeFileSync(
    join(dir, "mock.json"),
    JSON.stringify({ type: "oauth", access: "old", refresh: "old-rt", expires: Date.now() - 1000, accountId: "acc-1" }),
  );

  const fresh = await getFreshCredential("mock");

  assert.ok(fresh);
  assert.equal(fresh.access, "fresh-access"); // refreshed
  assert.equal(fresh.refresh, "rotated-refresh"); // rotation captured
  assert.equal(fresh.accountId, "acc-1"); // merge preserved the extra field
  assert.ok(fresh.expires > Date.now()); // future expiry

  // The gateway sent a standard refresh_token grant with the old refresh token.
  assert.match(received!.body, /grant_type=refresh_token/);
  assert.match(received!.body, /refresh_token=old-rt/);
  assert.match(received!.body, /client_id=mock-cid/);

  // And it was persisted to the vault (so subsequent calls use the new token).
  const onDisk = JSON.parse(readFileSync(join(dir, "mock.json"), "utf8"));
  assert.equal(onDisk.access, "fresh-access");
  assert.equal(onDisk.accountId, "acc-1");

  server.close();
  rmSync(dir, { recursive: true, force: true });
});
