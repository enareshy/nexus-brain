export const ERROR_STATUS = {
  VALIDATION: 400,
  UNAUTHENTICATED: 401,
  /** The company's monthly AI budget, or this person's share of it, is used up (FR-MET-03). */
  BUDGET_EXCEEDED: 402,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  RECONNECT_REQUIRED: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  UNAVAILABLE: 503,
  CONFIG_INVALID: 500,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

/** Typed application error. `message` must be safe to show to API clients. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details ? Object.freeze({ ...details }) : undefined;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
