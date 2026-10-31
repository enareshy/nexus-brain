export * from "./memory-store.js";
export * from "./mock-mcp-server.js";

/** Simulates the browser leg: follows /authorize and returns the code and state. */
export async function simulateConsent(
  authorizationUrl: string,
): Promise<{ code: string; state: string }> {
  const res = await fetch(authorizationUrl, { redirect: "manual" });
  const location = res.headers.get("location");
  if (res.status !== 302 || !location) throw new Error(`consent failed: ${res.status}`);
  const target = new URL(location);
  return {
    code: target.searchParams.get("code") ?? "",
    state: target.searchParams.get("state") ?? "",
  };
}
