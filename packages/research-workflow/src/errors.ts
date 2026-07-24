export const EXIT = {
  success: 0,
  general: 1,
  invalidArguments: 2,
  validation: 3,
  notFound: 4,
  conflict: 5,
  lockUnavailable: 6,
  filesystem: 7,
  notInitialized: 8,
} as const;

export class RwfError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly details: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    exitCode: number,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "RwfError";
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

export function invalid(message: string, details?: Record<string, unknown>): RwfError {
  return new RwfError("INVALID_ARGUMENTS", message, EXIT.invalidArguments, details);
}

export function notFound(message: string, details?: Record<string, unknown>): RwfError {
  return new RwfError("NOTE_NOT_FOUND", message, EXIT.notFound, details);
}
