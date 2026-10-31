import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";

export const ISSUER = "http://localhost:8081/realms/brain";
export const AUDIENCE = "brain-api";

export interface TestKeys {
  readonly keySet: JWTVerifyGetKey;
  sign(claims: Record<string, unknown>, opts?: SignOptions): Promise<string>;
}

export interface SignOptions {
  readonly issuer?: string;
  readonly audience?: string;
  /** `null` omits the exp claim entirely. */
  readonly expiresIn?: string | number | null;
  readonly subject?: string;
}

/** Local RS256 key pair and JWKS so tests never call a real identity provider. */
export async function createTestKeys(): Promise<TestKeys> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256" };
  const keySet = createLocalJWKSet({ keys: [jwk] });

  return {
    keySet,
    sign: (claims, opts = {}) => {
      const base = new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuedAt()
        .setIssuer(opts.issuer ?? ISSUER)
        .setAudience(opts.audience ?? AUDIENCE);
      const jwt = opts.expiresIn === null ? base : base.setExpirationTime(opts.expiresIn ?? "5m");
      return (opts.subject ? jwt.setSubject(opts.subject) : jwt).sign(privateKey);
    },
  };
}
