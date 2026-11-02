import { AppError, isAppError, type SecretBox } from "@brain/core";
import {
  federatedSearch,
  type FederatedResult,
  type SearchAdapter,
  type SearchHit,
  type ToolSession,
} from "@brain/connectors";
import {
  appendAudit,
  consumePendingAuthorization,
  type ConnectionSummary,
  deleteConnection,
  getServerApp,
  listConnections,
  listServerApps,
  listTurnedOffServers,
  savePendingAuthorization,
  saveServerApp,
  setServerAllowed,
  touchConnection,
  type PoolLike,
  type RemovedConnection,
  type UserScope,
} from "@brain/db";
import {
  beginAuthorization,
  completeAuthorization,
  openSession,
  revokeAuthorization,
  type ClientContext,
  type McpServerDefinition,
  type McpSession,
  type ServerRegistry,
  type ToolInfo,
  type ToolResult,
} from "@brain/mcp-client";
import { createHash } from "node:crypto";
import { withExpandedTerms, type QueryExpander } from "../answers/query-rewriter.js";
import { KeyedMutex } from "./keyed-mutex.js";
import { SessionPool } from "./session-pool.js";
import { TtlCache } from "./ttl-cache.js";
import { createVaultStore, openTokens, readClientInfo, readStoredTokens, verifierContext } from "./vault-store.js";

const STATE_TTL_MS = 10 * 60 * 1000;
const STATE_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const CODE_MAX_CHARS = 2048;
const SESSION_IDLE_MS = 60_000;
const MAX_IDLE_SESSIONS = 200;
const MAX_CACHED_TOOL_RESULTS = 500;
const EXPAND_TIMEOUT_MS = 8_000;

export type ConnectionState = "not_connected" | "active" | "needs_reauth";

export interface ConnectionView {
  readonly serverId: string;
  readonly displayName: string;
  readonly status: ConnectionState;
  readonly lastUsedAt: string | null;
  /**
   * needs_app: an admin must set up this company's sign-in app before anyone can connect.
   * configured: done, and an admin can change it. ready: nothing to set up.
   */
  readonly setup: "ready" | "needs_app" | "configured";
  /** The redirect address an admin gives the provider during setup. */
  readonly redirectUrl: string;
  /** False when the company's admin has turned this service off for everyone. */
  readonly allowed: boolean;
}

export interface ServerAppInput {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** What the HTTP layer needs. Implemented by ConnectionsService; faked in unit tests. */
export interface ConnectionsApi {
  list(scope: UserScope): Promise<readonly ConnectionView[]>;
  authorize(scope: UserScope, serverId: string): Promise<{ authorizationUrl: string }>;
  complete(scope: UserScope, code: string, state: string): Promise<{ serverId: string }>;
  disconnect(scope: UserScope, serverId: string): Promise<{ disconnected: boolean; revoked: boolean }>;
  /** Saves this company's sign-in app. Callers must have checked the user is an admin. */
  saveApp(scope: UserScope, serverId: string, app: ServerAppInput): Promise<{ saved: true }>;
  /** Allows or turns off a service for the whole company. Callers must have checked the user is an admin. */
  setAllowed(scope: UserScope, serverId: string, allowed: boolean): Promise<{ allowed: boolean }>;
  tools(scope: UserScope, serverId: string): Promise<readonly ToolInfo[]>;
  search(scope: UserScope, query: string, limit: number): Promise<FederatedResult>;
  /** Full text of one search result, read with the person's own connection, or null if it cannot be read. */
  readItem(scope: UserScope, item: ItemReference): Promise<string | null>;
}

export interface ItemReference {
  readonly serverId: string;
  readonly externalId: string;
  readonly url: string;
  readonly siteId?: string | undefined;
}

export interface GatheredDocuments extends FederatedResult {
  /** Full text by hit URL, read with the user's own token. */
  readonly bodies: ReadonlyMap<string, string>;
}

/** What the answer service needs from connections. */
export interface DocumentSource {
  gatherDocuments(
    scope: UserScope,
    query: string,
    options: { readonly limit: number; readonly maxDocuments: number; readonly signal?: AbortSignal },
  ): Promise<GatheredDocuments>;
}

export interface ConnectionsDeps {
  readonly pool: PoolLike;
  readonly box: SecretBox;
  readonly registry: ServerRegistry;
  readonly adapters: ReadonlyMap<string, SearchAdapter>;
  readonly client: ClientContext;
  readonly onBackgroundError?: (err: unknown) => void;
  /** Suggests other words when a search finds nothing. Without one, an empty search stays empty. */
  readonly expander?: QueryExpander;
}

function appContext(tenantId: string, serverId: string): string {
  return `app|${tenantId}|${serverId}`;
}

export function hashState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

export class ConnectionsService implements ConnectionsApi, DocumentSource {
  private readonly sessions = new KeyedMutex();
  private readonly idleSessions: SessionPool;
  private readonly toolCache = new TtlCache<ToolResult>(MAX_CACHED_TOOL_RESULTS);

  constructor(private readonly deps: ConnectionsDeps) {
    this.idleSessions = new SessionPool({
      idleMs: SESSION_IDLE_MS,
      maxSessions: MAX_IDLE_SESSIONS,
      onCloseError: deps.onBackgroundError,
    });
  }

  /** Closes idle MCP sessions on shutdown. */
  close(): void {
    this.idleSessions.closeAll();
  }

  async list(scope: UserScope): Promise<readonly ConnectionView[]> {
    // Turned-off services still show their connection, so the person can remove it.
    const rows = new Map((await listConnections(this.deps.pool, scope)).map((r) => [r.serverId, r]));
    const current = new Map((await this.currentConnections(scope)).map((r) => [r.serverId, r]));
    const apps = new Set((await listServerApps(this.deps.pool, scope.tenantId)).map((a) => a.serverId));
    const turnedOff = await listTurnedOffServers(this.deps.pool, scope.tenantId);
    const appKeyOf = (def: McpServerDefinition) => def.appKey ?? def.id;
    return this.deps.registry.list().map((def) => {
      const row = rows.get(def.id);
      return {
        serverId: def.id,
        displayName: def.displayName,
        status: current.get(def.id)?.status ?? row?.status ?? "not_connected",
        lastUsedAt: row?.lastUsedAt?.toISOString() ?? null,
        setup: !def.needsApp || def.client ? "ready" : apps.has(appKeyOf(def)) ? "configured" : "needs_app",
        redirectUrl: this.deps.client.redirectUrl,
        allowed: !turnedOff.has(def.id),
      };
    });
  }

  async setAllowed(scope: UserScope, serverId: string, allowed: boolean): Promise<{ allowed: boolean }> {
    const def = this.deps.registry.get(serverId);
    // Recorded first: a change nobody can trace is worse than one that did not happen.
    await this.audit(scope, allowed ? "connection.service_allowed" : "connection.service_turned_off", def.id);
    await setServerAllowed(this.deps.pool, scope, def.id, allowed);
    if (!allowed) {
      // Sessions kept open for reuse stop now. Work already running finishes; nothing new starts.
      const tenantPrefix = `${scope.tenantId}|`;
      this.idleSessions.evictWhere((key) => key.startsWith(tenantPrefix) && key.endsWith(`|${def.id}`));
      this.toolCache.deleteByPrefix(tenantPrefix);
    }
    return { allowed };
  }

  async saveApp(scope: UserScope, serverId: string, app: ServerAppInput): Promise<{ saved: true }> {
    const def = this.deps.registry.get(serverId);
    if (!def.needsApp || def.client) throw new AppError("VALIDATION", "This service does not need setting up");
    const appKey = def.appKey ?? def.id;
    await saveServerApp(this.deps.pool, scope, appKey, {
      clientId: app.clientId,
      secretCiphertext: this.deps.box.seal(app.clientSecret, appContext(scope.tenantId, appKey)),
    });
    // Sessions opened with the previous app stop now; currentConnections asks people to reconnect.
    const tenantPrefix = `${scope.tenantId}|`;
    const sharing = this.deps.registry.list().filter((d) => (d.appKey ?? d.id) === appKey);
    this.idleSessions.evictWhere(
      (key) => key.startsWith(tenantPrefix) && sharing.some((d) => key.endsWith(`|${d.id}`)),
    );
    this.toolCache.deleteByPrefix(tenantPrefix);
    await this.audit(scope, "connection.app_saved", serverId);
    return { saved: true };
  }

  /**
   * The user's connections. One made before the company's app last changed belongs to the old
   * app and cannot refresh with the new one, so it needs reconnecting. RLS keeps each user's
   * rows private, so this is worked out when read rather than updated for everyone at once.
   * A service the company has turned off is left out, so nothing reads through it (FR-MCP-02).
   */
  private async currentConnections(scope: UserScope): Promise<ConnectionSummary[]> {
    const [all, apps, turnedOff] = await Promise.all([
      listConnections(this.deps.pool, scope),
      listServerApps(this.deps.pool, scope.tenantId),
      listTurnedOffServers(this.deps.pool, scope.tenantId),
    ]);
    const rows = all.filter((row) => !turnedOff.has(row.serverId));
    const changedAt = new Map(apps.map((app) => [app.serverId, app.updatedAt.getTime()]));
    const appKeys = new Map(this.deps.registry.list().map((d) => [d.id, d.appKey ?? d.id]));
    return rows.map((row) => {
      const appChanged = changedAt.get(appKeys.get(row.serverId) ?? row.serverId) ?? 0;
      return row.updatedAt.getTime() < appChanged ? { ...row, status: "needs_reauth" as const } : row;
    });
  }

  /** The server's definition with this company's sign-in app, when it needs one. */
  private async definitionFor(scope: UserScope, serverId: string): Promise<McpServerDefinition> {
    const def = this.deps.registry.get(serverId);
    if (!def.needsApp || def.client) return def;
    const appKey = def.appKey ?? def.id;
    const app = await getServerApp(this.deps.pool, scope.tenantId, appKey);
    if (!app) throw new AppError("VALIDATION", "An admin needs to set up this service first");
    const clientSecret = this.deps.box.open(app.secretCiphertext, appContext(scope.tenantId, appKey));
    return { ...def, client: { clientId: app.clientId, clientSecret } };
  }

  async authorize(scope: UserScope, serverId: string): Promise<{ authorizationUrl: string }> {
    await this.requireAllowed(scope, serverId);
    const def = await this.definitionFor(scope, serverId);
    const store = createVaultStore(this.deps.pool, this.deps.box, scope, serverId);
    const start = await beginAuthorization(def, store, this.deps.client);
    const stateHash = hashState(start.state);

    await savePendingAuthorization(this.deps.pool, scope, {
      stateHash,
      serverId,
      verifierCiphertext: this.deps.box.seal(start.codeVerifier, verifierContext(stateHash)),
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    });
    await this.audit(scope, "connection.authorize_started", serverId);
    return { authorizationUrl: start.authorizationUrl };
  }

  /**
   * Finishes a consent flow for the signed-in user. The state must belong to this
   * user (RLS), which defeats login-CSRF: a stolen or planted state cannot attach
   * someone else's account (security review M1).
   */
  async complete(scope: UserScope, code: string, state: string): Promise<{ serverId: string }> {
    if (!STATE_PATTERN.test(state) || !code || code.length > CODE_MAX_CHARS) {
      throw new AppError("VALIDATION", "Invalid authorization response");
    }
    const stateHash = hashState(state);
    const pending = await consumePendingAuthorization(this.deps.pool, scope, stateHash);
    if (!pending) {
      await this.audit(scope, "connection.complete_rejected", undefined);
      throw new AppError("VALIDATION", "Authorization expired, was already used, or belongs to another user");
    }

    await this.requireAllowed(scope, pending.serverId);
    const def = await this.definitionFor(scope, pending.serverId);
    // Same lock as all session work: a request still using the previous account finishes
    // first, so it cannot re-populate the caches or pool after this reset.
    await this.sessions.run(this.lockKey(scope, def.id), async () => {
      const store = createVaultStore(this.deps.pool, this.deps.box, scope, def.id);
      await completeAuthorization(def, store, this.deps.client, {
        code,
        codeVerifier: this.deps.box.open(pending.verifierCiphertext, verifierContext(stateHash)),
      });
      this.forget(scope, def.id);
    });
    await this.audit(scope, "connection.connected", def.id);
    return { serverId: def.id };
  }

  /** Revokes the grant at the provider when supported, then deletes our stored tokens. */
  async disconnect(
    scope: UserScope,
    serverId: string,
  ): Promise<{ disconnected: boolean; revoked: boolean }> {
    const def = await this.definitionFor(scope, serverId);
    return this.sessions.run(this.lockKey(scope, serverId), async () => {
      const tokens = await readStoredTokens(this.deps.pool, this.deps.box, scope, serverId);
      const revoked = tokens
        ? await revokeAuthorization(def, this.deps.client, tokens, await readClientInfo(this.deps.pool, this.deps.box, serverId))
        : false;
      const disconnected = await deleteConnection(this.deps.pool, scope, serverId);
      this.forget(scope, serverId);
      if (disconnected) await this.audit(scope, "connection.disconnected", serverId, { revoked });
      return { disconnected, revoked };
    });
  }

  /**
   * After someone is turned off their tokens are already deleted here. This revokes each grant at
   * its provider where supported and drops sessions kept for them. Best effort, never retried:
   * the tokens no longer exist, so a failure is reported and left.
   */
  async revokeRemoved(scope: UserScope, removed: readonly RemovedConnection[]): Promise<number> {
    const outcomes = await Promise.allSettled(
      removed.map(async (connection) => {
        this.forget(scope, connection.serverId);
        const tokens = openTokens(this.deps.box, scope, connection.serverId, connection.tokensCiphertext);
        if (!tokens) return false;
        const def = await this.definitionFor(scope, connection.serverId);
        const clientInfo = await readClientInfo(this.deps.pool, this.deps.box, connection.serverId);
        return revokeAuthorization(def, this.deps.client, tokens, clientInfo);
      }),
    );
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") this.deps.onBackgroundError?.(outcome.reason);
    }
    return outcomes.filter((o) => o.status === "fulfilled" && o.value).length;
  }

  async tools(scope: UserScope, serverId: string): Promise<readonly ToolInfo[]> {
    await this.requireActive(scope, serverId);
    return this.withSession(scope, serverId, (session) => session.listTools());
  }

  /** Read-only work on the user's session. `work` may run twice, so it must not change anything. */
  async readWithSession<T>(
    scope: UserScope,
    serverId: string,
    work: (session: ToolSession) => Promise<T>,
  ): Promise<T> {
    await this.requireActive(scope, serverId);
    return this.withSession(scope, serverId, work);
  }

  /**
   * Runs a write once, on a new session, with no retry: repeating it could change data twice.
   */
  writeWithSession<T>(
    scope: UserScope,
    serverId: string,
    work: (session: ToolSession) => Promise<T>,
  ): Promise<T> {
    const key = this.lockKey(scope, serverId);
    return this.sessions.run(key, async () => {
      await this.requireActive(scope, serverId);
      this.idleSessions.evict(key);
      const session = await this.openFresh(scope, serverId);
      try {
        return await work(session);
      } finally {
        session.close().catch((err: unknown) => this.deps.onBackgroundError?.(err));
        await touchConnection(this.deps.pool, scope, serverId).catch((err: unknown) =>
          this.deps.onBackgroundError?.(err),
        );
      }
    });
  }

  async search(scope: UserScope, query: string, limit: number): Promise<FederatedResult> {
    const first = await this.searchOnce(scope, query, limit);
    const result = await this.retryWithBetterWords(scope, query, limit, first);
    await this.audit(scope, "search", undefined, {
      queryFingerprint: this.deps.box.fingerprint(query),
      results: result.hits.map((h) => ({ serverId: h.serverId, externalId: h.externalId })),
      sources: result.sources,
      expanded: result.expandedTerms !== undefined,
    });
    return result;
  }

  /** Only a clean search that found nothing retries: an empty result during an outage means nothing. */
  private async retryWithBetterWords(
    scope: UserScope,
    query: string,
    limit: number,
    first: FederatedResult,
  ): Promise<FederatedResult> {
    const expander = this.deps.expander;
    const cleanAndEmpty = first.hits.length === 0 && first.sources.length > 0 && first.sources.every((s) => s.ok);
    if (!expander || !cleanAndEmpty) return first;
    const expandedTerms = await expander.expand(scope, query, AbortSignal.timeout(EXPAND_TIMEOUT_MS));
    if (expandedTerms.length === 0) return first;
    const second = await this.searchOnce(scope, withExpandedTerms(query, expandedTerms), limit);
    return { ...second, expandedTerms };
  }

  private async searchOnce(scope: UserScope, query: string, limit: number): Promise<FederatedResult> {
    const active = (await this.currentConnections(scope)).filter(
      (c) => c.status === "active" && this.deps.adapters.has(c.serverId),
    );
    return federatedSearch(
      active.map((c) => ({
        id: c.serverId,
        run: (signal) =>
          this.withSession(scope, c.serverId, (session) => this.searchHits(c.serverId, session, query, limit, scope), signal),
      })),
      { limit, rerankQuery: query },
    );
  }

  /** Searches, then reads the top hits' full text in the same session per source. */
  async readItem(scope: UserScope, item: ItemReference): Promise<string | null> {
    const adapter = this.deps.adapters.get(item.serverId);
    if (!adapter) throw new AppError("NOT_FOUND", "This service is not available");
    const { siteId, ...rest } = item;
    // The caller supplies these details, so only the service's own access check decides what is returned.
    const hit: SearchHit = { ...rest, ...(siteId ? { siteId } : {}), title: "", snippet: "", updatedAt: null };
    const read = await this.readWithSession(scope, item.serverId, (session) => adapter.readDocuments?.(session, [hit]) ?? Promise.resolve(null));
    await this.audit(scope, "item.read", item.serverId, { externalId: item.externalId });
    return read?.get(item.url) ?? null;
  }

  async gatherDocuments(
    scope: UserScope,
    query: string,
    options: { readonly limit: number; readonly maxDocuments: number; readonly signal?: AbortSignal },
  ): Promise<GatheredDocuments> {
    const active = (await this.currentConnections(scope)).filter(
      (c) => c.status === "active" && this.deps.adapters.has(c.serverId),
    );
    const bodies = new Map<string, string>();
    const result = await federatedSearch(
      active.map((c) => ({
        id: c.serverId,
        run: (signal) =>
          this.withSession(
            scope,
            c.serverId,
            async (session) => {
              const adapter = this.deps.adapters.get(c.serverId)!;
              const hits = await this.searchHits(c.serverId, session, query, options.limit, scope);
              const read = await adapter.readDocuments?.(session, hits.slice(0, options.maxDocuments));
              read?.forEach((text, url) => bodies.set(url, text));
              return hits;
            },
            // Stops on the time budget or when the caller goes away.
            options.signal ? AbortSignal.any([signal, options.signal]) : signal,
          ),
      })),
      { limit: options.limit, rerankQuery: query },
    );
    return { ...result, bodies };
  }

  private lockKey(scope: UserScope, serverId: string): string {
    return `${scope.tenantId}|${scope.userId}|${serverId}`;
  }

  /**
   * Results are never cached (FR-RET-03): asking the service with the user's own token each time
   * is what checks their access, so removed access and revoked accounts take effect at once.
   */
  private searchHits(
    serverId: string,
    session: McpSession,
    query: string,
    limit: number,
    scope: UserScope,
  ): Promise<readonly SearchHit[]> {
    const adapter = this.deps.adapters.get(serverId)!;
    return adapter.search(this.withToolCache(scope, serverId, adapter, session), query, limit);
  }

  /** Serves tools the adapter marks as slow-changing from a per-user cache. Errors are not cached. */
  private withToolCache(
    scope: UserScope,
    serverId: string,
    adapter: SearchAdapter,
    session: McpSession,
  ): ToolSession {
    return {
      listTools: () => session.listTools(),
      callTool: async (name, args) => {
        const ttl = adapter.cachedTools?.[name];
        if (!ttl) return session.callTool(name, args);
        const key = `${this.lockKey(scope, serverId)}|${name}|${JSON.stringify(args)}`;
        const cached = this.toolCache.get(key);
        if (cached) return cached;
        const result = await session.callTool(name, args);
        if (!result.isError) this.toolCache.set(key, result, ttl);
        return result;
      },
    };
  }

  /** Drops everything held for this user and server, e.g. after connecting another account. */
  private forget(scope: UserScope, serverId: string): void {
    const key = this.lockKey(scope, serverId);
    this.idleSessions.evict(key);
    this.toolCache.deleteByPrefix(`${key}|`);
  }

  /**
   * One session at a time per (tenant, user, server): no refresh-token races.
   * Sessions are reused while idle. If a reused one fails it may simply have gone stale, so
   * `work` runs once more on a fresh session; `work` must therefore be safe to repeat, which
   * holds because everything here only reads. Write tools (FR-WR) use writeWithSession instead.
   */
  private withSession<T>(
    scope: UserScope,
    serverId: string,
    work: (session: McpSession) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const key = this.lockKey(scope, serverId);
    return this.sessions.run(key, async () => {
      if (signal?.aborted) throw new AppError("UNAVAILABLE", "Search budget exceeded");
      // Checked again here, since an admin may have turned the service off while this waited its turn.
      await this.requireAllowed(scope, serverId);
      const reused = this.idleSessions.take(key);
      if (reused) {
        try {
          return await this.useSession(key, scope, serverId, reused, work, signal);
        } catch (err) {
          // Only a service failure can mean a stale session; anything else would just repeat.
          const retryable = isAppError(err) && err.code === "UNAVAILABLE";
          if (signal?.aborted || !retryable) throw err;
        }
      }
      return this.useSession(key, scope, serverId, await this.openFresh(scope, serverId), work, signal);
    });
  }

  private async openFresh(scope: UserScope, serverId: string): Promise<McpSession> {
    const store = createVaultStore(this.deps.pool, this.deps.box, scope, serverId);
    // Needing consent ends this account's access, so nothing cached for it may be reused.
    return openSession(
      await this.definitionFor(scope, serverId),
      {
        ...store,
        markNeedsReauth: async () => {
          await store.markNeedsReauth();
          this.forget(scope, serverId);
        },
      },
      this.deps.client,
    );
  }

  private async requireAllowed(scope: UserScope, serverId: string): Promise<void> {
    if ((await listTurnedOffServers(this.deps.pool, scope.tenantId)).has(serverId)) {
      throw new AppError("FORBIDDEN", "Your admin has turned this service off", { reason: "service_turned_off" });
    }
  }

  private async requireActive(scope: UserScope, serverId: string): Promise<void> {
    await this.requireAllowed(scope, serverId);
    const connection = (await this.currentConnections(scope)).find((c) => c.serverId === serverId);
    if (connection?.status !== "active") {
      throw new AppError("RECONNECT_REQUIRED", "This connection needs to be reconnected");
    }
  }

  /** Returns the session to the pool only after success. Aborting closes it to free the lock. */
  private async useSession<T>(
    key: string,
    scope: UserScope,
    serverId: string,
    session: McpSession,
    work: (session: McpSession) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      session.close().catch((err: unknown) => this.deps.onBackgroundError?.(err));
    };
    signal?.addEventListener("abort", close, { once: true });
    try {
      const result = await work(session);
      // Bookkeeping only: a failure here must not fail or repeat the work.
      await touchConnection(this.deps.pool, scope, serverId).catch((err: unknown) =>
        this.deps.onBackgroundError?.(err),
      );
      if (signal?.aborted) close();
      else this.idleSessions.put(key, session);
      return result;
    } catch (err) {
      close();
      throw err;
    } finally {
      signal?.removeEventListener("abort", close);
    }
  }

  private audit(
    scope: UserScope,
    action: string,
    resource?: string,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    return appendAudit(this.deps.pool, {
      tenantId: scope.tenantId,
      userId: scope.userId,
      action,
      resource,
      meta,
    });
  }
}
