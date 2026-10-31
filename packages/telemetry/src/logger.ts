import { pino, type DestinationStream, type Logger } from "pino";

export type { Logger };

/** Fields that must never reach logs (NFR-OBS-02, NFR-SEC-03). */
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "headers.authorization",
  "authorization",
  "token",
  "accessToken",
  "refreshToken",
  "password",
  "apiKey",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.password",
  "*.apiKey",
];

export interface LoggerOptions {
  readonly service: string;
  readonly level?: string;
  readonly destination?: DestinationStream;
}

/** Structured JSON logger. Attach `tenant_id`, `user_id`, `request_id` via `logger.child`. */
export function createLogger(options: LoggerOptions): Logger {
  return pino(
    {
      name: options.service,
      level: options.level ?? "info",
      redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
      base: { service: options.service },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    options.destination,
  );
}
