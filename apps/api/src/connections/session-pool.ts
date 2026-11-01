import type { McpSession } from "@brain/mcp-client";

export interface SessionPoolOptions {
  readonly idleMs: number;
  readonly maxSessions: number;
  readonly onCloseError?: (err: unknown) => void;
}

/**
 * Keeps idle MCP sessions for reuse, one per (tenant, user, server) key. A session is
 * removed while in use, so it can never serve two requests or two users at once. Callers
 * serialise per key (KeyedMutex). Idle sessions close themselves after `idleMs`.
 */
export class SessionPool {
  private readonly idle = new Map<string, { session: McpSession; timer: NodeJS.Timeout }>();
  private closed = false;

  constructor(private readonly options: SessionPoolOptions) {}

  /** Removes and returns the idle session for this key, if any. */
  take(key: string): McpSession | null {
    const entry = this.idle.get(key);
    if (!entry) return null;
    clearTimeout(entry.timer);
    this.idle.delete(key);
    return entry.session;
  }

  put(key: string, session: McpSession): void {
    this.evict(key);
    // A request can finish after shutdown began; never keep its session.
    if (this.closed) {
      this.close(session);
      return;
    }
    while (this.idle.size >= this.options.maxSessions) {
      const oldest = this.idle.keys().next().value;
      if (oldest === undefined) break;
      this.evict(oldest);
    }
    const timer = setTimeout(() => this.evict(key), this.options.idleMs);
    timer.unref();
    this.idle.set(key, { session, timer });
  }

  /** Closes every idle session whose key matches. */
  evictWhere(matches: (key: string) => boolean): void {
    for (const key of [...this.idle.keys()]) {
      if (matches(key)) this.evict(key);
    }
  }

  evict(key: string): void {
    const session = this.take(key);
    if (session) this.close(session);
  }

  closeAll(): void {
    this.closed = true;
    for (const key of [...this.idle.keys()]) this.evict(key);
  }

  get size(): number {
    return this.idle.size;
  }

  private close(session: McpSession): void {
    session.close().catch((err: unknown) => this.options.onCloseError?.(err));
  }
}
