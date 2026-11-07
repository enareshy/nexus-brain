import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatEvent, HEARTBEAT, HEARTBEAT_MS, startHeartbeat } from "./sse.js";

describe("startHeartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes a keep-alive comment on every interval until stopped", () => {
    const writes: string[] = [];
    const stop = startHeartbeat((chunk) => writes.push(chunk));

    vi.advanceTimersByTime(HEARTBEAT_MS - 1);
    expect(writes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(writes).toEqual([HEARTBEAT]);
    vi.advanceTimersByTime(HEARTBEAT_MS * 2);
    expect(writes).toHaveLength(3);

    stop();
    vi.advanceTimersByTime(HEARTBEAT_MS * 5);
    expect(writes).toHaveLength(3);
  });

  it("is an SSE comment, which clients skip, and keeps proxies from closing a quiet stream", () => {
    expect(HEARTBEAT.startsWith(":")).toBe(true);
    expect(HEARTBEAT.endsWith("\n\n")).toBe(true);
    expect(HEARTBEAT_MS).toBeLessThan(30_000);
  });
});

describe("formatEvent", () => {
  it("names the event and sends it as one JSON data line", () => {
    expect(formatEvent({ type: "text", text: "a\nb" })).toBe('event: text\ndata: {"type":"text","text":"a\\nb"}\n\n');
  });
});
