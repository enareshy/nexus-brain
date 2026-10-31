import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { startTracing } from "./tracing.js";

function capture() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _enc, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  return { lines, destination };
}

describe("createLogger", () => {
  it("emits JSON with service and context fields", () => {
    const { lines, destination } = capture();
    const logger = createLogger({ service: "api", destination });
    logger.child({ tenant_id: "t1", request_id: "r1" }).info("hello");

    const entry = JSON.parse(lines[0] ?? "{}");
    expect(entry).toMatchObject({ service: "api", tenant_id: "t1", request_id: "r1", msg: "hello" });
  });

  it("redacts credentials at top level and nested", () => {
    const { lines, destination } = capture();
    const logger = createLogger({ service: "api", destination });
    logger.info(
      {
        token: "t-secret",
        connection: { accessToken: "a-secret", refreshToken: "r-secret" },
        req: { headers: { authorization: "Bearer b-secret" } },
      },
      "auth",
    );

    const text = lines.join("");
    for (const secret of ["t-secret", "a-secret", "r-secret", "b-secret"]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain("[REDACTED]");
  });

  it("respects the configured level", () => {
    const { lines, destination } = capture();
    const logger = createLogger({ service: "api", level: "warn", destination });
    logger.info("hidden");
    logger.warn("shown");
    expect(lines).toHaveLength(1);
  });
});

describe("startTracing", () => {
  it("is a no-op without an OTLP endpoint", async () => {
    const handle = startTracing("api", undefined);
    expect(handle.enabled).toBe(false);
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });

  it("starts and shuts down with an endpoint", async () => {
    const handle = startTracing("api", "http://127.0.0.1:4318/");
    expect(handle.enabled).toBe(true);
    await handle.shutdown();
  });
});
