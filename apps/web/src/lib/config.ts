/**
 * Public, non-secret browser configuration (NEXT_PUBLIC_* are inlined at build time).
 * Development falls back to the local stack; a production build fails if a value is missing,
 * so it can never ship pointing at localhost.
 */
function publicSetting(value: string | undefined, name: string, devDefault: string): string {
  if (value) return value;
  if (process.env.NODE_ENV === "production") {
    throw new Error(`${name} must be set for a production build`);
  }
  return devDefault;
}

export const webConfig = Object.freeze({
  apiUrl: publicSetting(process.env.NEXT_PUBLIC_API_URL, "NEXT_PUBLIC_API_URL", "http://127.0.0.1:3001"),
  oidcIssuer: publicSetting(
    process.env.NEXT_PUBLIC_OIDC_ISSUER,
    "NEXT_PUBLIC_OIDC_ISSUER",
    "http://localhost:8081/realms/brain",
  ),
  oidcClientId: process.env.NEXT_PUBLIC_OIDC_CLIENT_ID ?? "brain-web",
});
