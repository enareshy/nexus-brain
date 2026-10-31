/**
 * Serialises async work per key inside this process. Used per (tenant, user, server)
 * so concurrent requests cannot race a rotating refresh token (security review M2).
 * Multi-instance deployments additionally need a Postgres advisory lock around refresh.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(work);
    this.tails.set(key, current);
    try {
      return await current;
    } finally {
      if (this.tails.get(key) === current) this.tails.delete(key);
    }
  }

  /** Number of keys with work queued or running (for tests and metrics). */
  get size(): number {
    return this.tails.size;
  }
}
