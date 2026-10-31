import { describe, expect, it } from "vitest";
import { z } from "zod";
import { baseEnvSchema, loadEnv } from "./env.js";
import { AppError } from "./errors.js";

describe("loadEnv", () => {
  const schema = baseEnvSchema.extend({
    DATABASE_URL: z.string().url(),
    PORT: z.coerce.number().int().positive().default(3000),
  });

  it("returns parsed values with defaults applied", () => {
    const env = loadEnv(schema, { DATABASE_URL: "postgres://u:p@localhost:5432/db" });
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe("development");
    expect(env.LOG_LEVEL).toBe("info");
  });

  it("coerces numeric strings", () => {
    const env = loadEnv(schema, { DATABASE_URL: "postgres://localhost/db", PORT: "8080" });
    expect(env.PORT).toBe(8080);
  });

  it("throws CONFIG_INVALID naming the missing variable", () => {
    expect(() => loadEnv(schema, {})).toThrowError(AppError);
    try {
      loadEnv(schema, {});
    } catch (err) {
      const appErr = err as AppError;
      expect(appErr.code).toBe("CONFIG_INVALID");
      expect(appErr.message).toContain("DATABASE_URL");
    }
  });

  it("never echoes secret values in the error", () => {
    const secretSchema = z.object({ API_KEY: z.string().startsWith("sk-") });
    try {
      loadEnv(secretSchema, { API_KEY: "super-secret-value" });
      expect.unreachable();
    } catch (err) {
      const text = JSON.stringify({ message: (err as AppError).message, details: (err as AppError).details });
      expect(text).not.toContain("super-secret-value");
      expect(text).toContain("API_KEY");
    }
  });
});
