import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, extname, join } from "node:path";
import { ulid } from "ulid";
import { commonFields, optionalString } from "./entry.js";
import { invalid, notFound } from "./errors.js";
import type { Artifact, WorkspacePaths } from "./types.js";
import {
  relativePosix,
  removeIfExists,
  slugify,
  walkFiles,
  writeDurableFile,
} from "./util.js";

const MEDIA_TYPES: Record<string, string> = {
  ".csv": "text/csv",
  ".json": "application/json",
  ".txt": "text/plain",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
};

export function mediaTypeFor(path: string): string {
  return MEDIA_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalid(`${field} must be a non-negative integer`);
  return value as number;
}

export function artifactFromMetadata(paths: WorkspacePaths, metadataPath: string): Artifact {
  let metadata: Record<string, unknown>;
  try {
    const value = JSON.parse(readFileSync(metadataPath, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    metadata = value as Record<string, unknown>;
  } catch (error) {
    throw invalid(`${metadataPath}: invalid artifact metadata (${String(error)})`);
  }
  const common = commonFields(metadata, metadataPath);
  const originalFilename = optionalString(metadata.filename, "filename");
  const mediaType = optionalString(metadata.media_type, "media_type");
  const sha256 = optionalString(metadata.sha256, "sha256");
  if (!originalFilename || basename(originalFilename) !== originalFilename || originalFilename === "." || originalFilename === "..") {
    throw invalid(`${metadataPath}: invalid filename`);
  }
  if (!mediaType) throw invalid(`${metadataPath}: invalid media_type`);
  if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) throw invalid(`${metadataPath}: invalid sha256`);
  const size = integer(metadata.size, "size");
  const payloadPath = join(join(metadataPath, ".."), "payload", originalFilename);
  const extension = extname(originalFilename);
  const displayBase = basename(originalFilename, extension);
  return {
    type: "artifact",
    ...common,
    metadataPath,
    payloadPath,
    payloadRelativePath: relativePosix(paths.root, payloadPath),
    originalFilename,
    mediaType,
    size,
    sha256,
    absolutePath: payloadPath,
    relativePath: relativePosix(paths.root, metadataPath),
    filename: `${common.id}-${slugify(displayBase)}${extension.toLowerCase()}`,
  };
}

export function loadArtifacts(paths: WorkspacePaths): Artifact[] {
  return walkFiles(paths.artifacts)
    .filter((path) => basename(path) === "metadata.json")
    .map((path) => artifactFromMetadata(paths, path));
}

export function findArtifact(paths: WorkspacePaths, id: string): Artifact {
  const matches = loadArtifacts(paths).filter((artifact) => artifact.id === id);
  if (matches.length === 0) throw notFound(`Artifact not found: ${id}`, { artifactId: id });
  if (matches.length > 1) throw invalid(`Duplicate artifact id: ${id}`);
  return matches[0]!;
}

export function createArtifact(
  paths: WorkspacePaths,
  input: {
    title: string;
    sourcePath: string;
    metadata: Record<string, unknown>;
    mediaType?: string;
    now?: Date;
  },
): Artifact {
  let sourceStat;
  try {
    sourceStat = statSync(input.sourcePath);
  } catch {
    throw invalid(`Artifact file does not exist: ${input.sourcePath}`);
  }
  if (!sourceStat.isFile()) throw invalid(`Artifact path is not a file: ${input.sourcePath}`);
  const bytes = readFileSync(input.sourcePath);
  const now = input.now ?? new Date();
  const id = ulid(now.getTime());
  const createdAt = now.toISOString();
  const originalFilename = basename(input.sourcePath);
  const mediaType = input.mediaType ?? mediaTypeFor(originalFilename);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const metadata: Record<string, unknown> = {
    id,
    created_at: createdAt,
    ...input.metadata,
    title: input.title,
    filename: originalFilename,
    media_type: mediaType,
    size: bytes.length,
    sha256,
  };
  const datePath = createdAt.slice(0, 10).replaceAll("-", "/");
  const finalDirectory = join(paths.artifacts, datePath, `${id}-${slugify(input.title)}`);
  const tempDirectory = join(paths.temp, `artifact-${id}`);
  if (existsSync(tempDirectory) || existsSync(finalDirectory)) {
    throw invalid(`Artifact destination already exists: ${id}`);
  }
  mkdirSync(tempDirectory, { recursive: true });
  try {
    writeDurableFile(join(tempDirectory, "payload", originalFilename), bytes);
    writeDurableFile(join(tempDirectory, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
    mkdirSync(join(finalDirectory, ".."), { recursive: true });
    renameSync(tempDirectory, finalDirectory);
  } catch (error) {
    removeIfExists(tempDirectory);
    throw error;
  }
  return artifactFromMetadata(paths, join(finalDirectory, "metadata.json"));
}
