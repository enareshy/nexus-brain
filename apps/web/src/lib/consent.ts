export type ConsentParams =
  | { readonly kind: "ok"; readonly code: string; readonly state: string }
  | { readonly kind: "declined" }
  | { readonly kind: "invalid" };

const STATE_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const CODE_MAX_CHARS = 2048;

/** Interprets the query string the API's /oauth/callback forwards to /connections/complete. */
export function readConsentParams(params: URLSearchParams): ConsentParams {
  if (params.get("status") === "error") return { kind: "declined" };
  const code = params.get("code") ?? "";
  const state = params.get("state") ?? "";
  if (!code || code.length > CODE_MAX_CHARS || !STATE_PATTERN.test(state)) return { kind: "invalid" };
  return { kind: "ok", code, state };
}
