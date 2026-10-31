import { AppError } from "@brain/core";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  OAuthClientInformationSchema,
  OAuthTokensSchema,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export type { OAuthClientInformationMixed, OAuthTokens };

/** Validates tokens read back from storage before they are used. */
export function parseStoredTokens(json: string): OAuthTokens {
  const result = OAuthTokensSchema.safeParse(JSON.parse(json));
  if (!result.success) throw new AppError("INTERNAL", "Stored tokens are invalid");
  return result.data;
}

/** Validates a stored OAuth client registration; extra registration fields are kept. */
export function parseStoredClientInfo(json: string): OAuthClientInformationMixed {
  const raw: unknown = JSON.parse(json);
  if (!OAuthClientInformationSchema.safeParse(raw).success) {
    throw new AppError("INTERNAL", "Stored client registration is invalid");
  }
  return raw as OAuthClientInformationMixed;
}

/** Persistence for one (tenant, user, server) connection. Implemented over the token vault. */
export interface CredentialStore {
  loadTokens(): Promise<OAuthTokens | undefined>;
  saveTokens(tokens: OAuthTokens): Promise<void>;
  markNeedsReauth(): Promise<void>;
  loadClientInfo(): Promise<OAuthClientInformationMixed | undefined>;
  saveClientInfo(info: OAuthClientInformationMixed): Promise<void>;
}

export interface ProviderOptions {
  readonly store: CredentialStore;
  readonly redirectUrl: string;
  readonly clientName: string;
  /**
   * interactive: a user is starting a connection, so capture the authorization URL.
   * background: a request is using an existing connection; needing consent is an error.
   */
  readonly mode: "interactive" | "background";
  readonly state?: string;
  readonly codeVerifier?: string;
}

/**
 * OAuthClientProvider for a server-side, multi-user app. The SDK drives discovery,
 * client registration, PKCE and refresh; we decide where secrets live.
 */
export class StoreBackedOAuthProvider implements OAuthClientProvider {
  private capturedUrl: URL | undefined;
  private verifier: string | undefined;

  constructor(private readonly options: ProviderOptions) {
    this.verifier = options.codeVerifier;
  }

  get redirectUrl(): string {
    return this.options.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.options.clientName,
      redirect_uris: [this.options.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  /** The authorization URL captured during an interactive start. */
  get authorizationUrl(): URL | undefined {
    return this.capturedUrl;
  }

  /** The PKCE verifier generated during an interactive start. */
  get pendingCodeVerifier(): string | undefined {
    return this.verifier;
  }

  /**
   * Only an interactive start may begin a new consent flow. In background mode the SDK
   * reaches here after tokens are gone or rejected, which means the user must reconnect.
   */
  async state(): Promise<string> {
    if (this.options.mode === "background") return this.requireReconnect();
    if (!this.options.state) throw new AppError("INTERNAL", "OAuth state was not provided");
    return this.options.state;
  }

  clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return this.options.store.loadClientInfo();
  }

  saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    return this.options.store.saveClientInfo(info);
  }

  tokens(): Promise<OAuthTokens | undefined> {
    return this.options.store.loadTokens();
  }

  saveTokens(tokens: OAuthTokens): Promise<void> {
    return this.options.store.saveTokens(tokens);
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (this.options.mode === "background") return this.requireReconnect();
    this.capturedUrl = url;
  }

  private async requireReconnect(): Promise<never> {
    await this.options.store.markNeedsReauth();
    throw new AppError("RECONNECT_REQUIRED", "This connection needs to be reconnected");
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new AppError("INTERNAL", "PKCE verifier is missing");
    return this.verifier;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all" || scope === "tokens") await this.options.store.markNeedsReauth();
  }
}
