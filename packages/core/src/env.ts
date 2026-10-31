import { z } from "zod";
import { AppError } from "./errors.js";

type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * Parses environment variables with a Zod schema and fails fast.
 * Error details list variable names and issues only, never values.
 */
export function loadEnv<S extends z.ZodTypeAny>(
  schema: S,
  source: EnvSource = process.env,
): z.infer<S> {
  const result = schema.safeParse(source);
  if (result.success) return result.data;

  const issues = result.error.issues.map((issue) => ({
    variable: issue.path.join("."),
    problem: issue.message,
  }));
  throw new AppError(
    "CONFIG_INVALID",
    `Invalid environment: ${issues.map((i) => i.variable).join(", ")}`,
    { issues },
  );
}

/** Shared base settings every service reads. */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});
