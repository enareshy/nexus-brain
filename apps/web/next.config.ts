import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";
// `next build` runs with NODE_ENV=production: require real endpoints so a production
// bundle and CSP can never point at localhost. Dev falls back to the local stack.
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? (isDev ? "http://127.0.0.1:3001" : missing("NEXT_PUBLIC_API_URL"));
const OIDC_ISSUER =
  process.env.NEXT_PUBLIC_OIDC_ISSUER ?? (isDev ? "http://localhost:8081/realms/brain" : missing("NEXT_PUBLIC_OIDC_ISSUER"));

function missing(name: string): never {
  throw new Error(`${name} must be set for a production build`);
}

/**
 * Strict browser policy. Untrusted text from connected services is rendered as text,
 * never HTML, and the CSP limits network access to our API and identity provider.
 * TODO(Phase 5): replace 'unsafe-inline' scripts with per-request nonces.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src 'self' ${new URL(API_URL).origin} ${new URL(OIDC_ISSUER).origin}${isDev ? " ws:" : ""}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          // OAuth codes pass through /connections/complete; never leak them in Referer.
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          ...(isDev
            ? []
            : [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]),
        ],
      },
    ];
  },
};

export default config;
