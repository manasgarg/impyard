import { ACTIONS, type Action, type Entry } from "./types.js";
import { invalid } from "./errors.js";
import { ULID_PATTERN } from "./util.js";

export function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw invalid(`${field} must be a string`);
  return value;
}

export function stringList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw invalid(`${field} must be a list of strings`);
  }
  return value as string[];
}

export type CommonFields = Pick<
  Entry,
  | "id"
  | "createdAt"
  | "title"
  | "topics"
  | "sources"
  | "targets"
  | "metadata"
  | "author"
  | "taskId"
  | "collection"
  | "action"
>;

export function commonFields(
  metadata: Record<string, unknown>,
  source: string,
): CommonFields {
  const id = metadata.id;
  const createdAt = metadata.created_at;
  const title = metadata.title;
  if (typeof id !== "string" || !ULID_PATTERN.test(id)) throw invalid(`${source}: invalid id`);
  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) {
    throw invalid(`${source}: invalid created_at`);
  }
  if (typeof title !== "string" || !title.trim()) throw invalid(`${source}: invalid title`);

  const actionValue = metadata.action;
  let action: Action | undefined;
  if (actionValue !== undefined) {
    if (typeof actionValue !== "string" || !(ACTIONS as readonly string[]).includes(actionValue)) {
      throw invalid(`${source}: invalid action`);
    }
    action = actionValue as Action;
  }

  const fields: CommonFields = {
    id,
    createdAt,
    title,
    topics: stringList(metadata.topics, "topics"),
    sources: stringList(metadata.sources, "sources"),
    targets: stringList(metadata.targets, "targets"),
    metadata,
  };
  const author = optionalString(metadata.author, "author");
  const taskId = optionalString(metadata.task_id, "task_id");
  const collection = optionalString(metadata.collection, "collection");
  if (author !== undefined) fields.author = author;
  if (taskId !== undefined) fields.taskId = taskId;
  if (collection !== undefined) fields.collection = collection;
  if (action !== undefined) fields.action = action;
  return fields;
}
