/**
 * Server-sent event helpers. While the model is thinking or a source is slow, nothing is sent,
 * and proxies and load balancers close connections that stay quiet for too long (often 30-60 s).
 * A comment line every few seconds keeps the stream open; clients ignore comments.
 */
export const HEARTBEAT_MS = 15_000;
export const HEARTBEAT = ": keep-alive\n\n";

/** Writes a heartbeat until the returned function is called. */
export function startHeartbeat(write: (chunk: string) => void, everyMs: number = HEARTBEAT_MS): () => void {
  const timer = setInterval(() => write(HEARTBEAT), everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export function formatEvent<T extends { readonly type: string }>(event: T): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
