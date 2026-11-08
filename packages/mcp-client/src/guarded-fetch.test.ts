import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { checkedLookup, createGuardedFetch, isLoopbackAddress, isPrivateAddress } from "./guarded-fetch.js";

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

describe("connecting to the address that was checked (DNS rebinding)", () => {
  it("refuses at connect time when the name now points somewhere private, though it passed the first check", async () => {
    let calls = 0;
    // Public on the first look-up, then a cloud metadata address: the classic rebinding trick.
    const resolve = vi.fn(async () => (++calls === 1 ? ["104.192.142.10"] : ["169.254.169.254"]));
    const guarded = createGuardedFetch({ allowedHosts: ["mcp.atlassian.com"], resolve, timeoutMs: 5_000 });
    await expect(guarded("https://mcp.atlassian.com/v1/mcp")).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringMatching(/non-public/),
    });
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  /** A local server answering by path, reached through the real checked connection. */
  async function withLocalServer(run: (base: string) => Promise<void>) {
    const server = createServer((req, res) => {
      if (req.url === "/empty") return res.writeHead(204).end();
      if (req.url === "/moved") return res.writeHead(302, { location: "http://localhost/elsewhere" }).end();
      res.end("pinned ok");
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as AddressInfo;
    try {
      await run(`http://localhost:${port}`);
    } finally {
      await new Promise((done) => server.close(done));
    }
  }
  const local = () => createGuardedFetch({ allowedHosts: ["localhost"], allowInsecureLoopback: true, resolve: async () => ["127.0.0.1"] });

  it("connects through the checked look-up for a real request, and answers in Node's own Response", async () => {
    await withLocalServer(async (base) => {
      const response = await local()(`${base}/`);
      expect(response).toBeInstanceOf(Response);
      expect(await response.text()).toBe("pinned ok");
      const empty = await local()(`${base}/empty`);
      expect(empty).toBeInstanceOf(Response);
      expect(empty.status).toBe(204);
    });
  });

  it("refuses a redirect on the real connection", async () => {
    await withLocalServer(async (base) => {
      await expect(local()(`${base}/moved`)).rejects.toThrow();
    });
  });

  it("does not let an allowed loopback name lead to another private address", async () => {
    const guarded = createGuardedFetch({ allowedHosts: ["localhost"], allowInsecureLoopback: true, resolve: async () => ["169.254.169.254"], timeoutMs: 5_000 });
    await expect(guarded("http://localhost:65000/")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("checkedLookup", () => {
  const run = (resolve: (host: string) => Promise<readonly string[]>, all: boolean, allowLoopback = false) =>
    new Promise<{ err: Error | null; result: unknown; family?: number }>((done) =>
      checkedLookup(resolve, allowLoopback)("mcp.atlassian.com", { all }, (err, result, family) => done({ err, result, family })),
    );

  it("hands back only public addresses, in either form the socket asks for", async () => {
    expect(await run(async () => ["104.192.142.10"], false)).toEqual({ err: null, result: "104.192.142.10", family: 4 });
    expect(await run(async () => ["104.192.142.10", "2606:4700::1"], true)).toEqual({
      err: null,
      result: [{ address: "104.192.142.10", family: 4 }, { address: "2606:4700::1", family: 6 }],
      family: undefined,
    });
  });

  it("refuses when any address is private, or none came back", async () => {
    expect((await run(async () => ["104.192.142.10", "10.0.0.1"], true)).err).toMatchObject({ code: "FORBIDDEN" });
    expect((await run(async () => [], false)).err).toMatchObject({ code: "FORBIDDEN" });
    expect((await run(async () => { throw new Error("ENOTFOUND"); }, false)).err?.message).toBe("ENOTFOUND");
  });

  it("lets a loopback name through only when loopback is allowed", async () => {
    const loop = (allow: boolean) =>
      new Promise<Error | null>((done) => checkedLookup(async () => ["127.0.0.1"], allow)("localhost", { all: false }, (err) => done(err)));
    expect(await loop(true)).toBeNull();
    expect(await loop(false)).toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("isLoopbackAddress", () => {
  it.each([["127.0.0.1", true], ["127.8.9.10", true], ["::1", true], ["::ffff:127.0.0.1", true], ["10.0.0.1", false], ["169.254.169.254", false], ["2606:4700::1", false], ["localhost", false]])(
    "%s is loopback: %s",
    (address, expected) => expect(isLoopbackAddress(address)).toBe(expected),
  );
});

describe("isPrivateAddress, rarer IPv6 ranges", () => {
  it.each(["2001::1", "100::1", "64:ff9b:1::a00:1"])("blocks %s", (address) => expect(isPrivateAddress(address)).toBe(true));
});
