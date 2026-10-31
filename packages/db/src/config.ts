import { baseEnvSchema, loadEnv } from "@brain/core";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const dbEnvSchema = baseEnvSchema.extend({
  /** Owner role: migrations and seed only. */
  DATABASE_URL: z.string().url(),
  /** brain_app role: everything the application does; subject to RLS. */
  DATABASE_APP_ROLE_URL: z.string().url(),
});

export function loadDbEnv(source?: Record<string, string | undefined>) {
  return loadEnv(dbEnvSchema, source);
}

export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));
