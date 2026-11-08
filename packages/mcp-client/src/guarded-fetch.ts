import { AppError, isAppError } from "@brain/core";
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP, type LookupFunction } from "node:net";
// undici is Node's own fetch; its Agent lets the connection use the address our check passed.
import { Agent, fetch as undiciFetch } from "undici";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type ResolveHost = (host: string) => Promise<readonly string[]>;

export interface FetchGuardOptions {
  readonly allowedHosts: readonly string[];
  readonly allowInsecureLoopback?: boolean;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly resolve?: ResolveHost;
  readonly fetchImpl?: FetchLike;
}

const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * fetch wrapper for every outbound MCP/OAuth call (NFR-SEC-05, FR-CON-04):
 * HTTPS only, host allow-list, no private/link-local/metadata addresses,
 * no redirects, bounded time and response size.
 *
 * The name is checked before the request, and checked again by the look-up the connection itself
 * uses, so a name that changes to a private address in between (DNS rebinding) is refused when
 * connecting rather than reached. An injected `fetchImpl` (tests) skips the connection check.
 */
export function createGuardedFetch(options: FetchGuardOptions): FetchLike {
  const allowed = new Set(options.allowedHosts.map((h) => h.toLowerCase()));
  const resolve = options.resolve ?? defaultResolve;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const allowLoopback = options.allowInsecureLoopback === true;
  const send: FetchLike = options.fetchImpl ?? pinnedFetch(agentFor(resolve, allowLoopback));

  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    await assertAllowedUrl(url, allowed, allowLoopback, resolve);
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    const response = await send(input, { ...init, signal, redirect: "error" });
    return capResponse(response, maxBytes);
  };
}

/**
 * The look-up a connection uses: the name is resolved again here and only public addresses are
 * handed back, so the socket connects to an address that has just been checked.
 */
export function checkedLookup(resolve: ResolveHost, allowLoopback: boolean): LookupFunction {
  return (hostname, options, callback) => {
    const host = hostname.toLowerCase();
    resolve(host).then(
      (addresses) => {
        if (addresses.length === 0) return callback(blocked(`host ${host} did not resolve`), "");
        // A loopback name, where allowed, must still lead to loopback and nowhere else private.
        const loopbackAllowed = allowLoopback && LOOPBACK_HOSTS.has(host);
        const refused = loopbackAllowed ? addresses.some((a) => !isLoopbackAddress(a)) : addresses.some(isPrivateAddress);
        if (refused) return callback(blocked(`host ${host} resolves to a non-public address`), "");
        const entries = addresses.map((address) => ({ address, family: isIP(address) }));
        const [first] = entries;
        if (options.all) return callback(null, entries);
        return callback(null, first?.address ?? "", first?.family);
      },
      (err: unknown) => callback(err instanceof Error ? err : new Error(String(err)), ""),
    );
  };
}

const MAX_CONNECTIONS_PER_ORIGIN = 20;

/** One connection pool per way of resolving, shared by every fetch that uses it. */
const agents = new WeakMap<ResolveHost, Map<boolean, Agent>>();

function agentFor(resolve: ResolveHost, allowLoopback: boolean): Agent {
  const byMode = agents.get(resolve) ?? new Map<boolean, Agent>();
  agents.set(resolve, byMode);
  const existing = byMode.get(allowLoopback);
  if (existing) return existing;
  // Bounded per service, so one slow or hostile server cannot use up every socket.
  const agent = new Agent({ connections: MAX_CONNECTIONS_PER_ORIGIN, connect: { lookup: checkedLookup(resolve, allowLoopback) } });
  byMode.set(allowLoopback, agent);
  return agent;
}

function pinnedFetch(agent: Agent): FetchLike {
  return async (input, init) => {
    // The MCP SDK passes URLs. A Request would carry its own settings, so it is not accepted here.
    if (input instanceof Request) throw new AppError("INTERNAL", "Outbound requests take a URL");
    try {
      const response = await undiciFetch(input, { ...(init as Record<string, unknown>), dispatcher: agent });
      return response as unknown as Response;
    } catch (err) {
      // fetch reports a refused look-up as "fetch failed"; the reason is the refusal itself.
      const cause = err instanceof Error ? err.cause : undefined;
      if (isAppError(cause)) throw cause;
      throw err;
    }
  };
}

/** Throws unless `url` is https (or allowed loopback http) on an allow-listed public host. */
export async function assertAllowedUrl(
  url: URL,
  allowed: ReadonlySet<string>,
  allowInsecureLoopback: boolean,
  resolve: ResolveHost = defaultResolve,
): Promise<void> {
  const host = url.hostname.toLowerCase();
  const loopback = LOOPBACK_HOSTS.has(host);

  if (!allowed.has(host)) refuse(`host ${host} is not allow-listed`);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback && allowInsecureLoopback)) {
    refuse("only https is allowed");
  }
  if (loopback && allowInsecureLoopback) return;

  const literal = stripBrackets(host);
  const addresses = isIP(literal) ? [literal] : await resolve(host);
  if (addresses.length === 0) refuse(`host ${host} did not resolve`);
  if (addresses.some(isPrivateAddress)) refuse(`host ${host} resolves to a non-public address`);
}

/** Streams the body through a byte counter and errors once the cap is exceeded. */
function capResponse(response: Response, maxBytes: number): Response {
  // Always Node's own Response, whichever fetch produced it, so callers see one kind.
  if (!response.body) {
    return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  let seen = 0;
  const limiter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > maxBytes) {
        controller.error(new AppError("UNAVAILABLE", "Response from connected service is too large"));
        return;
      }
      controller.enqueue(chunk);
    },
  });
  return new Response(response.body.pipeThrough(limiter), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function blocked(reason: string): AppError {
  return new AppError("FORBIDDEN", `Outbound request blocked: ${reason}`);
}

function refuse(reason: string): never {
  throw blocked(reason);
}

async function defaultResolve(host: string): Promise<readonly string[]> {
  const results = await dnsLookup(host, { all: true, verbatim: true });
  return results.map((r) => r.address);
}

function stripBrackets(host: string): string {
  return host.replace(/^\[|\]$/g, "");
}

const BLOCKED = (() => {
  const list = new BlockList();
  const v4: Array<[string, number]> = [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
    ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
    ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
    ["224.0.0.0", 3],
  ];
  const v6: Array<[string, number]> = [
    ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64],
    ["2001::", 32], ["2001:db8::", 32], ["2002::", 16],
    ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
  ];
  v4.forEach(([net, prefix]) => list.addSubnet(net, prefix, "ipv4"));
  v6.forEach(([net, prefix]) => list.addSubnet(net, prefix, "ipv6"));
  return list;
})();

/**
 * Loopback, private, CGNAT, link-local (incl. cloud metadata), ULA, documentation,
 * NAT64/6to4 and multicast ranges. IPv4-mapped and IPv4-compatible IPv6 forms are
 * checked as IPv4. Anything that is not an IP address is treated as private.
 */
export function isPrivateAddress(address: string): boolean {
  const ip = address.toLowerCase();
  const version = isIP(ip);
  if (version === 4) return BLOCKED.check(ip, "ipv4");
  if (version !== 6) return true;
  const embedded = embeddedIpv4(ip);
  if (embedded) return BLOCKED.check(embedded, "ipv4");
  return BLOCKED.check(ip, "ipv6");
}

const LOOPBACK = (() => {
  const list = new BlockList();
  list.addSubnet("127.0.0.0", 8, "ipv4");
  list.addAddress("::1", "ipv6");
  return list;
})();

/** 127.0.0.0/8 or ::1, including ::ffff:127.x forms. */
export function isLoopbackAddress(address: string): boolean {
  const ip = address.toLowerCase();
  const version = isIP(ip);
  if (version === 4) return LOOPBACK.check(ip, "ipv4");
  if (version !== 6) return false;
  const embedded = embeddedIpv4(ip);
  return embedded ? LOOPBACK.check(embedded, "ipv4") : LOOPBACK.check(ip, "ipv6");
}

/** Returns the IPv4 address inside ::ffff:a.b.c.d / ::ffff:7f00:1 / ::a.b.c.d, else null. */
function embeddedIpv4(ip: string): string | null {
  const hextets = expandIpv6(ip);
  const prefixZero = hextets.slice(0, 5).every((h) => h === 0);
  const mapped = prefixZero && hextets[5] === 0xffff;
  const compatible = prefixZero && hextets[5] === 0 && (hextets[6] ?? 0) !== 0;
  if (!mapped && !compatible) return null;
  const hi = hextets[6] ?? 0;
  const lo = hextets[7] ?? 0;
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join(".");
}

function expandIpv6(ip: string): number[] {
  let text = ip;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted?.[1]) {
    const [a = 0, b = 0, c = 0, d = 0] = dotted[1].split(".").map(Number);
    text = text.slice(0, -dotted[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const parse = (part: string) => (part ? part.split(":").map((h) => parseInt(h, 16)) : []);
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  return [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
}
