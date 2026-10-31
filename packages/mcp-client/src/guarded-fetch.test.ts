import { describe, expect, it, vi } from "vitest";
import { createGuardedFetch, isPrivateAddress } from "./guarded-fetch.js";

const ok = () => vi.fn(async (_input: unknown, _init?: RequestInit) => new Response("ok"));

describe("createGuardedFetch", () => {
  it("allows an allow-listed https host resolving to a public address", async () => {
    const fetchImpl = ok();
    const guarded = createGuardedFetch({
      allowedHosts: ["mcp.atlassian.com"],
      resolve: async () => ["104.192.142.10"],
      fetchImpl,
    });
    await guarded("https://mcp.atlassian.com/v1/mcp", { method: "POST" });
    const init = fetchImpl.mock.calls[0]?.[1] ?? {};
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.method).toBe("POST");
  });

  it("blocks hosts that are not allow-listed", async () => {
    const guarded = createGuardedFetch({ allowedHosts: ["mcp.atlassian.com"], fetchImpl: ok() });
    await expect(guarded("https://evil.example/x")).rejects.toThrow(/not allow-listed/);
  });

  it("blocks plain http", async () => {
    const guarded = createGuardedFetch({ allowedHosts: ["mcp.atlassian.com"], fetchImpl: ok() });
    await expect(guarded("http://mcp.atlassian.com/v1/mcp")).rejects.toThrow(/only https/);
  });

  it("blocks an allow-listed host that resolves to a private address (DNS rebinding)", async () => {
    const guarded = createGuardedFetch({
      allowedHosts: ["mcp.atlassian.com"],
      resolve: async () => ["169.254.169.254"],
      fetchImpl: ok(),
    });
    await expect(guarded("https://mcp.atlassian.com/")).rejects.toThrow(/non-public/);
  });

  it("blocks a host that does not resolve", async () => {
    const guarded = createGuardedFetch({
      allowedHosts: ["mcp.atlassian.com"],
      resolve: async () => [],
      fetchImpl: ok(),
    });
    await expect(guarded("https://mcp.atlassian.com/")).rejects.toThrow(/did not resolve/);
  });

  it("blocks literal private IPs even when allow-listed", async () => {
    const guarded = createGuardedFetch({ allowedHosts: ["10.0.0.5"], fetchImpl: ok() });
    await expect(guarded("https://10.0.0.5/")).rejects.toThrow(/non-public/);
  });

  it("permits http loopback only when explicitly enabled", async () => {
    const strict = createGuardedFetch({ allowedHosts: ["127.0.0.1"], fetchImpl: ok() });
    await expect(strict("http://127.0.0.1:4000/mcp")).rejects.toThrow(/only https/);

    const fetchImpl = ok();
    const dev = createGuardedFetch({
      allowedHosts: ["127.0.0.1"],
      allowInsecureLoopback: true,
      fetchImpl,
    });
    await dev(new Request("http://127.0.0.1:4000/mcp"));
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("keeps a caller abort signal working", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_u: unknown, init?: RequestInit) => {
      controller.abort();
      expect(init?.signal?.aborted).toBe(true);
      return new Response("x");
    });
    const guarded = createGuardedFetch({
      allowedHosts: ["mcp.atlassian.com"],
      resolve: async () => ["104.192.142.10"],
      fetchImpl,
    });
    await guarded("https://mcp.atlassian.com/", { signal: controller.signal });
  });
});

describe("response size cap", () => {
  it("errors when the body exceeds the cap", async () => {
    const guarded = createGuardedFetch({
      allowedHosts: ["mcp.atlassian.com"],
      resolve: async () => ["104.192.142.10"],
      maxResponseBytes: 10,
      fetchImpl: async () => new Response("x".repeat(50)),
    });
    const res = await guarded("https://mcp.atlassian.com/");
    await expect(res.text()).rejects.toThrow(/too large/);
  });

  it("passes bodies under the cap and keeps status and headers", async () => {
    const guarded = createGuardedFetch({
      allowedHosts: ["mcp.atlassian.com"],
      resolve: async () => ["104.192.142.10"],
      fetchImpl: async () => new Response("ok", { status: 201, headers: { "x-test": "1" } }),
    });
    const res = await guarded("https://mcp.atlassian.com/");
    expect(res.status).toBe(201);
    expect(res.headers.get("x-test")).toBe("1");
    expect(await res.text()).toBe("ok");
  });

  it("passes bodiless responses through", async () => {
    const guarded = createGuardedFetch({
      allowedHosts: ["mcp.atlassian.com"],
      resolve: async () => ["104.192.142.10"],
      fetchImpl: async () => new Response(null, { status: 204 }),
    });
    expect((await guarded("https://mcp.atlassian.com/")).status).toBe(204);
  });
});

describe("isPrivateAddress", () => {
  it.each([
    "::ffff:7f00:1",
    "::7f00:1",
    "::127.0.0.1",
    "64:ff9b::a00:1",
    "2002:a00:1::",
    "fec0::1",
    "192.0.0.8",
    "198.18.0.1",
    "203.0.113.5",
    "2001:db8::1",
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fd12::1",
    "fe80::1",
    "::ffff:10.0.0.1",
    "not-an-ip",
  ])("treats %s as private", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(["104.192.142.10", "8.8.8.8", "172.32.0.1", "2606:4700::1111", "::ffff:8.8.8.8"])(
    "treats %s as public",
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    },
  );
});
