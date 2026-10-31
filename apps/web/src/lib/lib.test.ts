import { describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient, describeError, joinUrl } from "./api";
import { readConsentParams } from "./consent";
import { safeHttpUrl, safeReturnPath } from "./safe-url";

const ok = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ success: true, data, error: null }), { status });
const fail = (code: string, message: string, status: number) =>
  new Response(JSON.stringify({ success: false, data: null, error: { code, message } }), { status });

describe("createApiClient", () => {
  it("sends the bearer token and validates the response", async () => {
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) =>
      ok([{ serverId: "atlassian", displayName: "Atlassian", status: "active", lastUsedAt: null }]),
    );
    const api = createApiClient("http://api.test", () => "tok", fetchImpl as typeof fetch);
    const connections = await api.connections();

    expect(connections[0]?.status).toBe("active");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("http://api.test/connections");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer tok");
  });

  it("posts JSON for consent completion and encodes path/query values", async () => {
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => ok({ serverId: "atlassian" }));
    const api = createApiClient("http://api.test", () => "tok", fetchImpl as typeof fetch);
    await api.complete("c", "s");
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(init?.body).toBe(JSON.stringify({ code: "c", state: "s" }));

    fetchImpl.mockResolvedValueOnce(ok({ hits: [], sources: [] }));
    await api.search("a&b=c");
    expect(String(fetchImpl.mock.calls[1]![0])).toBe("http://api.test/search?q=a%26b%3Dc&limit=10");
  });

  it("covers the remaining endpoints", async () => {
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => {
      const path = new URL(String(url)).pathname;
      if (path === "/me") return ok({ tenantId: "t", userId: "u", role: "member", principals: [] });
      if (path.endsWith("/authorize")) return ok({ authorizationUrl: "https://x/authorize" });
      return ok({ disconnected: true, revoked: false });
    });
    const api = createApiClient("http://api.test", () => "tok", fetchImpl as typeof fetch);
    expect((await api.me()).role).toBe("member");
    expect((await api.authorize("atlassian")).authorizationUrl).toBe("https://x/authorize");
    expect(await api.disconnect("atlassian")).toEqual({ disconnected: true, revoked: false });
  });

  it("refuses to call the API without a token", async () => {
    const fetchImpl = vi.fn();
    const api = createApiClient("http://api.test", () => null, fetchImpl as unknown as typeof fetch);
    await expect(api.connections()).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps error envelopes, bad shapes and network failures", async () => {
    const api = (res: () => Promise<Response>) =>
      createApiClient("http://api.test", () => "tok", (async () => res()) as typeof fetch);

    await expect(api(async () => fail("RECONNECT_REQUIRED", "x", 409)).connections()).rejects.toMatchObject({
      code: "RECONNECT_REQUIRED",
      status: 409,
    });
    await expect(api(async () => ok({ unexpected: true })).connections()).rejects.toMatchObject({ code: "BAD_RESPONSE" });
    await expect(api(async () => new Response("not json")).connections()).rejects.toMatchObject({ code: "BAD_RESPONSE" });
    await expect(api(async () => { throw new TypeError("offline"); }).connections()).rejects.toMatchObject({ code: "NETWORK" });
  });
});

describe("joinUrl", () => {
  it("keeps a base path prefix", () => {
    expect(joinUrl("https://h.example/api", "/search?q=x").toString()).toBe("https://h.example/api/search?q=x");
    expect(joinUrl("https://h.example/api/", "me").toString()).toBe("https://h.example/api/me");
    expect(joinUrl("http://127.0.0.1:3001", "/me").toString()).toBe("http://127.0.0.1:3001/me");
  });
});

describe("request cancellation and timeout", () => {
  it("reports ABORTED when the caller cancels", async () => {
    const controller = new AbortController();
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      controller.abort();
      throw init?.signal?.reason ?? new Error("aborted");
    }) as typeof fetch;
    const api = createApiClient("http://api.test", () => "tok", fetchImpl);
    await expect(api.search("x", { signal: controller.signal })).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("explains a timeout", async () => {
    const fetchImpl = (async () => {
      throw new DOMException("timed out", "TimeoutError");
    }) as typeof fetch;
    const api = createApiClient("http://api.test", () => "tok", fetchImpl);
    await expect(api.connections()).rejects.toMatchObject({ code: "NETWORK", message: /too long/ });
  });
});

describe("describeError", () => {
  it.each([
    ["UNAUTHENTICATED", /sign in/],
    ["FORBIDDEN", /access/],
    ["RECONNECT_REQUIRED", /reconnected/],
    ["RATE_LIMITED", /Too many/],
    ["UNAVAILABLE", /unavailable/],
    ["NETWORK", /unavailable/],
    ["INTERNAL", /Something went wrong/],
  ])("gives a human message for %s", (code, pattern) => {
    expect(describeError(new ApiError(code, "server text", 500))).toMatch(pattern);
  });

  it("passes validation messages through and hides unknown errors", () => {
    expect(describeError(new ApiError("VALIDATION", "Authorization expired", 400))).toBe("Authorization expired");
    expect(describeError(new Error("stack"))).not.toContain("stack");
  });
});

describe("safeHttpUrl", () => {
  it("allows https and loopback http in development only", () => {
    expect(safeHttpUrl("https://acme.atlassian.net/browse/A-1")).toBe("https://acme.atlassian.net/browse/A-1");
    expect(safeHttpUrl("http://127.0.0.1:8081/x", true)).toBe("http://127.0.0.1:8081/x");
    expect(safeHttpUrl("http://127.0.0.1:8081/x", false)).toBeNull();
    expect(safeHttpUrl("http://evil.example/x", true)).toBeNull();
  });

  it.each(["javascript:alert(1)", "data:text/html,x", "not a url", "//evil.example"])("rejects %s", (value) => {
    expect(safeHttpUrl(value)).toBeNull();
  });
});

describe("safeReturnPath", () => {
  it.each([
    ["/connections?x=1", "/connections?x=1"],
    ["//evil.example", "/"],
    ["https://evil.example", "/"],
    ["/\\evil.example", "/"],
    ["/\t/evil.example", "/"],
    ["/\n/evil.example", "/"],
    ["/search?q=a#top", "/search?q=a#top"],
    [null, "/"],
    [undefined, "/"],
  ])("maps %s to %s", (input, expected) => {
    expect(safeReturnPath(input)).toBe(expected);
  });
});

describe("readConsentParams", () => {
  const state = "a".repeat(43);

  it("accepts a code and a well-formed state", () => {
    expect(readConsentParams(new URLSearchParams({ code: "c1", state }))).toEqual({ kind: "ok", code: "c1", state });
  });

  it("reports a declined consent", () => {
    expect(readConsentParams(new URLSearchParams({ status: "error" }))).toEqual({ kind: "declined" });
  });

  it.each<Record<string, string>>([{ code: "c" }, { state }, { code: "c", state: "short" }, { code: "x".repeat(3000), state }])(
    "rejects invalid params %o",
    (params) => {
      expect(readConsentParams(new URLSearchParams(params)).kind).toBe("invalid");
    },
  );
});
