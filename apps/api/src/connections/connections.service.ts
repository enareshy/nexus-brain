import { AppError, type SecretBox } from "@brain/core";
import { federatedSearch, type FederatedResult, type SearchAdapter } from "@brain/connectors";
import {
  appendAudit,
  consumePendingAuthorization,
  deleteConnection,
  listConnections,
  savePendingAuthorization,
  touchConnection,
  type PoolLike,
  type UserScope,
} from "@brain/db";
import {
  beginAuthorization,
  completeAuthorization,
  openSession,
  revokeAuthorization,
  type ClientContext,
  type McpSession,
  type ServerRegistry,
  type ToolInfo,
} from "@brain/mcp-client";
import { createHash } from "node:crypto";
import { KeyedMutex } from "./keyed-mutex.js";
import { createVaultStore, readClientInfo, readStoredTokens, verifierContext } from "./vault-store.js";

const STATE_TTL_MS = 10 * 60 * 1000;
const STATE_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const CODE_MAX_CHARS = 2048;

export type ConnectionState = "not_connected" | "active" | "needs_reauth";

export interface ConnectionView {
  readonly serverId: string;
  readonly displayName: string;
  readonly status: ConnectionState;
  readonly lastUsedAt: string | null;
}

/** What the HTTP layer needs. Implemented by ConnectionsService; faked in unit tests. */
export interface ConnectionsApi {
  list(scope: UserScope): Promise<readonly ConnectionView[]>;
  authorize(scope: UserScope, serverId: string): Promise<{ authorizationUrl: string }>;
  complete(scope: UserScope, code: string, state: string): Promise<{ serverId: string }>;
  disconnect(scope: UserScope, serverId: string): Promise<{ disconnected: boolean; revoked: boolean }>;
  tools(scope: UserScope, serverId: string): Promise<readonly ToolInfo[]>;
  search(scope: UserScope, query: string, limit: number): Promise<FederatedResult>;
}

export interface ConnectionsDeps {
  readonly pool: PoolLike;
  readonly box: SecretBox;
  readonly registry: ServerRegistry;
  readonly adapters: ReadonlyMap<string, SearchAdapter>;
  readonly client: ClientContext;
}

export function hashState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

export class ConnectionsService implements ConnectionsApi {
  private readonly sessions = new KeyedMutex();

  constructor(private readonly deps: ConnectionsDeps) {}

  async list(scope: UserScope): Promise<readonly ConnectionView[]> {
    const rows = new Map((await listConnections(this.deps.pool, scope)).map((r) => [r.serverId, r]));
    return this.deps.registry.list().map((def) => {
      const row = rows.get(def.id);
      return {
        serverId: def.id,
        displayName: def.displayName,
        status: row?.status ?? "not_connected",
        lastUsedAt: row?.lastUsedAt?.toISOString() ?? null,
      };
    });
  }

  async authorize(scope: UserScope, serverId: string): Promise<{ authorizationUrl: string }> {
    const def = this.deps.registry.get(serverId);
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

    const def = this.deps.registry.get(pending.serverId);
    const store = createVaultStore(this.deps.pool, this.deps.box, scope, def.id);
    await completeAuthorization(def, store, this.deps.client, {
      code,
      codeVerifier: this.deps.box.open(pending.verifierCiphertext, verifierContext(stateHash)),
    });
    await this.audit(scope, "connection.connected", def.id);
    return { serverId: def.id };
  }

  /** Revokes the grant at the provider when supported, then deletes our stored tokens. */
  async disconnect(
    scope: UserScope,
    serverId: string,
  ): Promise<{ disconnected: boolean; revoked: boolean }> {
    const def = this.deps.registry.get(serverId);
    return this.sessions.run(this.lockKey(scope, serverId), async () => {
      const tokens = await readStoredTokens(this.deps.pool, this.deps.box, scope, serverId);
      const revoked = tokens
        ? await revokeAuthorization(def, this.deps.client, tokens, await readClientInfo(this.deps.pool, this.deps.box, serverId))
        : false;
      const disconnected = await deleteConnection(this.deps.pool, scope, serverId);
      if (disconnected) await this.audit(scope, "connection.disconnected", serverId, { revoked });
      return { disconnected, revoked };
    });
  }

  tools(scope: UserScope, serverId: string): Promise<readonly ToolInfo[]> {
    return this.withSession(scope, serverId, (session) => session.listTools());
  }

  async search(scope: UserScope, query: string, limit: number): Promise<FederatedResult> {
    const active = (await listConnections(this.deps.pool, scope)).filter(
      (c) => c.status === "active" && this.deps.adapters.has(c.serverId),
    );
    const result = await federatedSearch(
      active.map((c) => ({
        id: c.serverId,
        run: () =>
          this.withSession(scope, c.serverId, (session) =>
            this.deps.adapters.get(c.serverId)!.search(session, query, limit),
          ),
      })),
      { limit },
    );

    await this.audit(scope, "search", undefined, {
      queryFingerprint: this.deps.box.fingerprint(query),
      results: result.hits.map((h) => ({ serverId: h.serverId, externalId: h.externalId })),
      sources: result.sources,
    });
    return result;
  }

  private lockKey(scope: UserScope, serverId: string): string {
    return `${scope.tenantId}|${scope.userId}|${serverId}`;
  }

  /** One session at a time per (tenant, user, server): no refresh-token races. */
  private withSession<T>(
    scope: UserScope,
    serverId: string,
    work: (session: McpSession) => Promise<T>,
  ): Promise<T> {
    const def = this.deps.registry.get(serverId);
    return this.sessions.run(this.lockKey(scope, serverId), async () => {
      const store = createVaultStore(this.deps.pool, this.deps.box, scope, serverId);
      const session = await openSession(def, store, this.deps.client);
      try {
        const result = await work(session);
        await touchConnection(this.deps.pool, scope, serverId);
        return result;
      } finally {
        await session.close();
      }
    });
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
