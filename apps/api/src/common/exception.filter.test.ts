import { AppError } from "@brain/core";
import { createLogger } from "@brain/telemetry";
import { HttpException, type ArgumentsHost } from "@nestjs/common";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { AllExceptionsFilter } from "./exception.filter.js";

const logger = createLogger({
  service: "test",
  destination: new Writable({ write: (_c, _e, done) => done() }),
});

function run(exception: unknown) {
  const sent: { status?: number; body?: unknown } = {};
  const reply = {
    status(code: number) {
      sent.status = code;
      return this;
    },
    send(body: unknown) {
      sent.body = body;
      return this;
    },
  };
  const host = {
    switchToHttp: () => ({ getRequest: () => ({ id: "req-1" }), getResponse: () => reply }),
  } as unknown as ArgumentsHost;
  new AllExceptionsFilter(logger).catch(exception, host);
  return sent;
}

describe("AllExceptionsFilter", () => {
  it("maps AppError codes and statuses", () => {
    const sent = run(new AppError("UNAVAILABLE", "Identity provider unavailable"));
    expect(sent.status).toBe(503);
    expect(sent.body).toMatchObject({ error: { code: "UNAVAILABLE" }, meta: { requestId: "req-1" } });
  });

  it("maps Fastify-native client errors instead of returning 500", () => {
    const err = Object.assign(new Error("Unexpected token in JSON body"), { statusCode: 400 });
    expect(run(err).status).toBe(400);
    const tooLarge = Object.assign(new Error("Request body is too large"), { statusCode: 413 });
    expect(run(tooLarge).body).toMatchObject({ error: { code: "PAYLOAD_TOO_LARGE" } });
  });

  it("maps a 429 HttpException to RATE_LIMITED", () => {
    expect(run(new HttpException("slow down", 429)).body).toMatchObject({
      error: { code: "RATE_LIMITED" },
    });
  });

  it("uses VALIDATION for unmapped 4xx codes", () => {
    expect(run(new HttpException("gone", 410)).body).toMatchObject({
      error: { code: "VALIDATION" },
    });
  });

  it("hides internals for 5xx-coded and unknown errors", () => {
    const upstream = Object.assign(new Error("db password=hunter2"), { statusCode: 502 });
    const sent = run(upstream);
    expect(sent.status).toBe(500);
    expect(JSON.stringify(sent.body)).not.toContain("hunter2");
    expect(run("a string").status).toBe(500);
  });
});
