export const ACTIONS = ["supersede", "delete", "restore"] as const;
export type Action = (typeof ACTIONS)[number];
export type NoteStatus = "active" | "superseded" | "deleted";
export type EntryType = "note" | "artifact";

export interface WorkspacePaths {
  root: string;
  marker: string;
  locks: string;
  temp: string;
  state: string;
  journal: string;
  artifacts: string;
  current: string;
  indexes: string;
  site: string;
}

export interface Entry {
  type: EntryType;
  id: string;
  createdAt: string;
  title: string;
  author?: string;
  taskId?: string;
  collection?: string;
  topics: string[];
  sources: string[];
  action?: Action;
  targets: string[];
  metadata: Record<string, unknown>;
  absolutePath: string;
  relativePath: string;
  filename: string;
}

export interface Note extends Entry {
  type: "note";
  body: string;
  artifacts: string[];
}

export interface Artifact extends Entry {
  type: "artifact";
  metadataPath: string;
  payloadPath: string;
  payloadRelativePath: string;
  originalFilename: string;
  mediaType: string;
  size: number;
  sha256: string;
}

export type ResearchEntry = Note | Artifact;

export interface HistoryEvent {
  at: string;
  status: NoteStatus;
  action: "created" | Action;
  by?: string;
}

export interface ResolvedJournal {
  entries: ResearchEntry[];
  notes: Note[];
  artifacts: Artifact[];
  byId: Map<string, ResearchEntry>;
  statuses: Map<string, NoteStatus>;
  histories: Map<string, HistoryEvent[]>;
  incoming: Map<string, ResearchEntry[]>;
}

export type IssueSeverity = "error" | "warning";

export interface ValidationIssue {
  severity: IssueSeverity;
  code: string;
  message: string;
  noteId?: string;
  path?: string;
}

export interface ValidationResult {
  issues: ValidationIssue[];
  journal?: ResolvedJournal;
}

export interface BuildState {
  fingerprint: string;
  viewBuiltThrough?: string;
  indexesBuiltThrough?: string;
}

export interface OutputOptions {
  json: boolean;
  quiet: boolean;
}
