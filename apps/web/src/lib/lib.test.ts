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
      ok([{ serverId: "atlassian", displayName: "Atlassian", status: "active", lastUsedAt: null, setup: "ready", redirectUrl: "http://127.0.0.1:3001/oauth/callback", allowed: true }]),
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

  it("saves a service's app and sends changes for approval", async () => {
    const proposal = {
      id: "p1",
      serverId: "atlassian",
      action: "create_issue",
      toolName: "createJiraIssue",
      toolClass: "write",
      args: { summary: "x" },
      argsHash: "h",
      status: "pending",
      externalId: null,
      url: null,
      errorCode: null,
      createdAt: "2026-11-01T00:00:00Z",
      expiresAt: "2026-11-01T01:00:00Z",
    };
    const target = { siteId: "s", siteOrigin: "https://a.atlassian.net", projects: [] };
    const fetchImpl = vi.fn(async (url: URL | RequestInfo, _init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/app")) return ok({ saved: true });
      if (path === "/proposals/targets/atlassian") return ok([target]);
      if (path === "/proposals" && _init?.method !== "POST") return ok([proposal]);
      return ok(proposal);
    });
    const api = createApiClient("http://api.test", () => "tok", fetchImpl as typeof fetch);

    expect(await api.saveServerApp("github", { clientId: "i", clientSecret: "s" })).toEqual({ saved: true });
    const saved = fetchImpl.mock.calls[0]!;
    expect(String(saved[0])).toBe("http://api.test/connections/github/app");
    expect(saved[1]?.body).toBe(JSON.stringify({ clientId: "i", clientSecret: "s" }));

    expect(await api.writeTargets("atlassian")).toEqual([target]);
    expect((await api.proposals())[0]?.id).toBe("p1");
    const request = { action: "add_comment", siteId: "s", issueKey: "A-1", body: "b" } as const;
    expect((await api.propose("atlassian", request)).id).toBe("p1");
    expect((await api.approveProposal("p1", "h")).id).toBe("p1");
    expect((await api.rejectProposal("p1")).id).toBe("p1");
    expect(fetchImpl.mock.calls.at(-2)?.[1]?.body).toBe(JSON.stringify({ argsHash: "h" }));
  });

  it("lists, reads, deletes and rates conversations", async () => {
    const fetchImpl = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path === "/conversations") return ok([{ id: "c1", title: "t", updatedAt: "2026-11-02T00:00:00Z" }]);
      if (path.endsWith("/feedback")) return ok({ saved: true });
      if (init?.method === "DELETE") return ok({ deleted: true });
      return ok({ id: "c1", title: "t", messages: [{ id: "m1", role: "user", createdAt: "x", text: "hello" }] });
    });
    const api = createApiClient("http://api.test", () => "tok", fetchImpl as typeof fetch);
    expect((await api.conversations())[0]?.title).toBe("t");
    expect((await api.conversation("c1")).messages[0]?.role).toBe("user");
    expect(await api.deleteConversation("c1")).toEqual({ deleted: true });
    expect(await api.sendFeedback("c1", "m1", { rating: "down", reason: "wrong" })).toEqual({ saved: true });
    const feedback = fetchImpl.mock.calls.at(-1)!;
    expect(String(feedback[0])).toBe("http://api.test/conversations/c1/messages/m1/feedback");
    expect(feedback[1]?.body).toBe(JSON.stringify({ rating: "down", reason: "wrong" }));
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

  it("calls the right route with the right method and body for memory, people, agents and changes", async () => {
    const memory = { id: "m1", text: "Keep it short", readable: true, createdAt: "t", updatedAt: "t" };
    const person = { id: "p1", email: "a@b.c", displayName: "A", role: "member", active: true, deactivatedAt: null };
    const deactivation = { changed: true, connectionsRemoved: 0, connectionsRevoked: 0, triggersPaused: 0, runsCancelled: 0, proposalsRejected: 0, changesInProgress: 0 };
    const run = { id: "r1", goal: "g", status: "running", errorCode: null, createdAt: "t" };
    const budget = { monthlyLimitUsd: 100, perPersonLimitUsd: null, warnAtPercent: 80 };
    const overview = {
      summary: { monthStart: "2026-11-01", totalUsd: 1, calls: 2, unpricedCalls: 0, byFeature: [], byPerson: [], byDay: [] },
      budget,
      companyLevel: "ok",
      credits: null,
    };
    const trigger = { id: "t1", kind: "schedule", goal: "g", schedule: "daily", enabled: true, pausedReason: null, nextRunAt: "t" };
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => ok(null));
    const api = createApiClient("http://api.test", () => "tok", fetchImpl as typeof fetch);
    const cases: Array<[() => Promise<unknown>, unknown, string, string, unknown?]> = [
      [() => api.memories(), [memory], "GET", "/memories"],
      [() => api.addMemory("Keep it short"), memory, "POST", "/memories", { text: "Keep it short" }],
      [() => api.updateMemory("m 1", "x"), memory, "POST", "/memories/m%201", { text: "x" }],
      [() => api.deleteMemory("m1"), { deleted: true }, "DELETE", "/memories/m1"],
      [() => api.deleteAllMemories(), { deleted: 2 }, "DELETE", "/memories"],
      [() => api.usageStatus(), { level: "warn", limit: "person", percentUsed: 85 }, "GET", "/usage/status"],
      [() => api.usageOverview(), overview, "GET", "/admin/usage"],
      [() => api.setBudget(budget), budget, "POST", "/admin/budget", budget],
      [
        () => api.addCredits(500),
        { plan: "team", planLabel: "Team", monthlyCredits: 1, topUpCredits: 500, usedCredits: 0, leftCredits: 501, level: "ok", topUps: [] },
        "POST",
        "/admin/credits",
        { credits: 500 },
      ],
      [() => api.people(), [person], "GET", "/admin/people"],
      [() => api.deactivatePerson("p1"), deactivation, "POST", "/admin/people/p1/deactivate"],
      [() => api.reactivatePerson("p1"), { changed: true }, "POST", "/admin/people/p1/reactivate"],
      [() => api.agentRuns(), [run], "GET", "/agent-runs"],
      [() => api.startAgentRun("g"), run, "POST", "/agent-runs", { goal: "g" }],
      [() => api.cancelAgentRun("r1"), { cancelled: true }, "POST", "/agent-runs/r1/cancel"],
      [() => api.agentTriggers(), [trigger], "GET", "/agent-triggers"],
      [() => api.deleteAgentTrigger("t1"), { deleted: true }, "DELETE", "/agent-triggers/t1"],
      [() => api.markNotificationsRead(["n1"]), { read: true }, "POST", "/notifications/read", { ids: ["n1"] }],
      [() => api.notifications(), { items: [], unread: 0 }, "GET", "/notifications"],
      [() => api.setServerAllowed("slack", false), { allowed: false }, "POST", "/connections/slack/allowed", { allowed: false }],
      [() => api.deleteConversation("c1"), { deleted: true }, "DELETE", "/conversations/c1"],
    ];
    for (const [send, reply, method, path, body] of cases) {
      fetchImpl.mockResolvedValueOnce(ok(reply));
      expect(await send()).toEqual(reply);
      const [url, init] = fetchImpl.mock.calls.at(-1)!;
      expect(`${init?.method ?? "GET"} ${new URL(String(url)).pathname}`).toBe(`${method} ${path}`);
      expect(init?.body).toBe(body === undefined ? undefined : JSON.stringify(body));
    }
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
