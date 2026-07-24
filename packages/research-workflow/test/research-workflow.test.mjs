import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(packageRoot, "dist", "cli.js");

function run(root, args, input = "") {
  const result = spawnSync(process.execPath, [cli, ...args, "--root", root], {
    input,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    assert.fail(`rwf ${args.join(" ")} failed (${result.status}):\n${result.stderr}\n${result.stdout}`);
  }
  return result.stdout.trim();
}

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "rwf-test-"));
  run(root, ["init"]);
  return root;
}

test("adds, supersedes, restores, and builds derived outputs", (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const original = run(root, ["note", "add", "--title", "Original", "--quiet"], "first");
  const replacement = run(
    root,
    [
      "note",
      "add",
      "--title",
      "Replacement",
      "--action",
      "supersede",
      "--target",
      original,
      "--quiet",
    ],
    "second",
  );
  const withdrawn = run(root, ["note", "add", "--title", "Withdrawn", "--quiet"], "temporary");
  run(
    root,
    [
      "note",
      "add",
      "--title",
      "Withdraw invalid finding",
      "--action",
      "delete",
      "--target",
      withdrawn,
    ],
    "The source was invalid.",
  );

  run(root, ["refresh"]);
  const initialFiles = readdirSync(join(root, "current", "notes"));
  assert.equal(initialFiles.some((name) => name.startsWith(original)), false);
  assert.equal(initialFiles.some((name) => name.startsWith(withdrawn)), false);
  assert.equal(initialFiles.some((name) => name.startsWith(replacement)), true);
  assert.equal(
    readlinkSync(join(root, "current", "notes", `${replacement}-replacement.md`)).startsWith("../../journal/"),
    true,
  );

  const status = JSON.parse(run(root, ["status", "--json"]));
  assert.equal(status.status.active, 2);
  assert.equal(status.status.superseded, 1);
  assert.equal(status.status.deleted, 1);
  assert.equal(status.status.current_view, "current");

  run(
    root,
    ["note", "add", "--title", "Restore withdrawn", "--action", "restore", "--target", withdrawn],
    "The withdrawn finding remains useful.",
  );
  run(root, ["refresh"]);
  const files = readdirSync(join(root, "current", "notes"));
  assert.equal(files.some((name) => name.startsWith(withdrawn)), true);
  assert.equal(files.some((name) => name.startsWith(original)), false);
  assert.equal(files.length, 4);

  const manifest = JSON.parse(readFileSync(join(root, "indexes", "manifest.json"), "utf8"));
  assert.equal(manifest.notes.length, 5);
  assert.equal(manifest.schema_version, 1);
  assert.equal(existsSync(join(root, "indexes", "manifest.schema.json")), true);
  const schema = JSON.parse(readFileSync(join(root, "indexes", "manifest.schema.json"), "utf8"));
  const validateManifest = new Ajv2020({ strict: false, validateFormats: false }).compile(schema);
  assert.equal(validateManifest(manifest), true, JSON.stringify(validateManifest.errors));
  run(root, ["validate"]);
});

test("preserves arbitrary YAML metadata", (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const metadataPath = join(root, "metadata.yaml");
  writeFileSync(metadataPath, "confidence: high\nreviewers:\n  - alice\n");
  const id = run(
    root,
    ["note", "add", "--title", "Metadata", "--metadata-file", metadataPath, "--metadata", "stage=draft", "--quiet"],
    "body",
  );
  const shown = JSON.parse(run(root, ["note", "show", id, "--json"]));
  assert.equal(shown.note.metadata.confidence, "high");
  assert.deepEqual(shown.note.metadata.reviewers, ["alice"]);
  assert.equal(shown.note.metadata.stage, "draft");
});

test("concurrent note additions do not collide or corrupt files", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rwf-first-note-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const children = Array.from({ length: 16 }, (_, index) =>
    new Promise((resolvePromise, reject) => {
      const child = spawn(
        process.execPath,
        [cli, "note", "add", "--root", root, "--title", `Concurrent ${index}`, "--quiet"],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolvePromise(stdout.trim());
        else reject(new Error(stderr));
      });
      child.stdin.end(`body ${index}`);
    }),
  );
  const ids = await Promise.all(children);
  assert.equal(new Set(ids).size, 16);
  const listed = JSON.parse(run(root, ["note", "list", "--all", "--json"]));
  assert.equal(listed.notes.length, 16);
  run(root, ["validate"]);
});

test("an explicit root directory must already exist", () => {
  const parent = mkdtempSync(join(tmpdir(), "rwf-missing-"));
  const root = join(parent, "does-not-exist");
  try {
    const result = spawnSync(
      process.execPath,
      [cli, "note", "add", "--root", root, "--title", "Nope"],
      { input: "body", encoding: "utf8" },
    );
    assert.equal(result.status, 7);
    assert.match(result.stderr, /does not exist/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("stores, relates, supersedes, searches, and indexes first-class artifacts", (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const firstFile = join(root, "funding-v1.csv");
  const secondFile = join(root, "funding-v2.csv");
  writeFileSync(firstFile, "company,amount\nAcme,10\n");
  writeFileSync(secondFile, "company,amount\nAcme,20\n");

  const first = run(root, [
    "artifact",
    "add",
    firstFile,
    "--title",
    "Funding dataset",
    "--collection",
    "venture-monitor",
    "--topic",
    "funding",
    "--metadata",
    "stage=raw",
    "--quiet",
  ]);
  const note = run(
    root,
    [
      "note",
      "add",
      "--title",
      "Funding interpretation",
      "--collection",
      "venture-monitor",
      "--topic",
      "funding",
      "--artifact",
      first,
      "--quiet",
    ],
    "Acme raised ten units.",
  );
  const second = run(root, [
    "artifact",
    "add",
    secondFile,
    "--title",
    "Funding dataset",
    "--collection",
    "venture-monitor",
    "--topic",
    "funding",
    "--action",
    "supersede",
    "--target",
    first,
    "--quiet",
  ]);

  run(root, ["refresh"]);
  assert.equal(run(root, ["artifact", "cat", second]), "company,amount\nAcme,20");
  assert.equal(readdirSync(join(root, "current", "artifacts")).some((name) => name.startsWith(first)), false);
  assert.equal(readdirSync(join(root, "current", "artifacts")).some((name) => name.startsWith(second)), true);
  assert.equal(readdirSync(join(root, "current", "notes")).some((name) => name.startsWith(note)), true);

  const artifacts = JSON.parse(
    run(root, ["artifact", "list", "--collection", "venture-monitor", "--metadata", "stage=raw", "--all", "--json"]),
  );
  assert.equal(artifacts.artifacts.length, 1);
  assert.equal(artifacts.artifacts[0].id, first);

  const noteSearch = JSON.parse(run(root, ["search", "ten units", "--json"]));
  assert.deepEqual(noteSearch.results.map((entry) => entry.id), [note]);
  const artifactSearch = JSON.parse(run(root, ["search", "Acme,20", "--json"]));
  assert.deepEqual(artifactSearch.results.map((entry) => entry.id), [second]);

  const manifest = JSON.parse(readFileSync(join(root, "indexes", "manifest.json"), "utf8"));
  assert.equal(manifest.artifacts.length, 2);
  assert.equal(manifest.artifacts.find((entry) => entry.id === first).status, "superseded");
  assert.equal(manifest.artifacts.find((entry) => entry.id === second).metadata.collection, "venture-monitor");
  assert.equal(manifest.notes.find((entry) => entry.id === note).artifacts[0], first);
  const topicPath = join(root, "indexes", "topics", "funding.md");
  assert.equal(existsSync(topicPath), true);
  const topicLink = readFileSync(topicPath, "utf8").match(/\]\(([^)]+)\)/)?.[1];
  assert.equal(existsSync(resolve(dirname(topicPath), topicLink)), true);
  assert.equal(existsSync(join(root, "indexes", "collections", "venture-monitor.md")), true);
  run(root, ["validate"]);
});

test("filters metadata and returns complete reconciliation lineage", (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = run(
    root,
    ["note", "add", "--title", "Version one", "--metadata", "stage=draft", "--quiet"],
    "one",
  );
  const second = run(
    root,
    ["note", "add", "--title", "Version two", "--action", "supersede", "--target", first, "--quiet"],
    "two",
  );
  const third = run(
    root,
    ["note", "add", "--title", "Version three", "--action", "supersede", "--target", second, "--quiet"],
    "three",
  );

  const filtered = JSON.parse(run(root, ["note", "list", "--all", "--metadata", "stage=draft", "--json"]));
  assert.deepEqual(filtered.notes.map((entry) => entry.id), [first]);
  const byTitle = JSON.parse(run(root, ["note", "list", "--all", "--title", "VERSION TWO", "--json"]));
  assert.deepEqual(byTitle.notes.map((entry) => entry.id), [second]);

  const inspected = JSON.parse(run(root, ["inspect", third, "--lineage", "--json"]));
  assert.equal(inspected.lineage.entries.length, 3);
  assert.equal(inspected.lineage.edges.length, 2);
  assert.deepEqual(
    new Set(inspected.lineage.entries.map((entry) => entry.id)),
    new Set([first, second, third]),
  );
});

test("imports historical notes and artifacts without opening created_at on normal adds", (t) => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const imported = run(
    root,
    ["import", "note", "--title", "Historical", "--created-at", "2024-01-02T03:04:05Z", "--quiet"],
    "history",
  );
  const shown = JSON.parse(run(root, ["note", "show", imported, "--json"]));
  assert.equal(shown.note.metadata.created_at, "2024-01-02T03:04:05.000Z");
  assert.match(shown.note.path, /^journal\/2024\/01\/02\//);

  const source = join(root, "historical.json");
  writeFileSync(source, "{\"old\":true}\n");
  const artifact = run(root, [
    "import",
    "artifact",
    source,
    "--title",
    "Historical artifact",
    "--created-at",
    "2023-02-03T04:05:06Z",
    "--quiet",
  ]);
  const artifactShown = JSON.parse(run(root, ["artifact", "show", artifact, "--json"]));
  assert.equal(artifactShown.artifact.metadata.created_at, "2023-02-03T04:05:06.000Z");
  assert.match(artifactShown.artifact.payload_path, /^artifacts\/2023\/02\/03\//);
  assert.equal(run(root, ["artifact", "cat", artifact]), "{\"old\":true}");

  const rejected = spawnSync(
    process.execPath,
    [cli, "note", "add", "--root", root, "--title", "Invalid", "--created-at", "2024-01-01T00:00:00Z"],
    { input: "body", encoding: "utf8" },
  );
  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /available only through rwf import/);
});
