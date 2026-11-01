const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const PLACEHOLDER_ORIGIN = "https://app.invalid";

/**
 * Returns the URL only if it is https (or http on loopback in development), else null.
 * Every link built from API or connector data goes through this before rendering.
 */
export function safeHttpUrl(value: string, allowLoopbackHttp = process.env.NODE_ENV !== "production"): string | null {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return url.toString();
    if (url.protocol === "http:" && allowLoopbackHttp && LOOPBACK.has(url.hostname)) return url.toString();
    return null;
  } catch {
    return null;
  }
}

/**
 * Same-origin relative path only (e.g. an OIDC returnTo). Rejects absolute,
 * protocol-relative, backslash and control-character tricks such as "/\t/evil.com".
 */
export function safeReturnPath(value: string | null | undefined): string {
  // eslint-disable-next-line no-control-regex
  if (!value || !value.startsWith("/") || /[\\\u0000-\u001f\u007f]/.test(value)) return "/";
  try {
    const url = new URL(value, PLACEHOLDER_ORIGIN);
    if (url.origin !== PLACEHOLDER_ORIGIN) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

/** Current path + query, for returning the user to the same view after sign-in. */
export function currentReturnPath(): string {
  return safeReturnPath(`${window.location.pathname}${window.location.search}`);
}
