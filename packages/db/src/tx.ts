import type { ClientBase } from "pg";

/** A failed ROLLBACK must not mask the original error; callers rethrow that one. */
export async function rollbackQuietly(client: Pick<ClientBase, "query">): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Original error is rethrown by the caller.
  }
}
