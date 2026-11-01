import type { CredentialStore, OAuthClientInformationMixed, OAuthTokens } from "../provider.js";

export interface MemoryStore extends CredentialStore {
  readonly state: {
    tokens: OAuthTokens | undefined;
    clientInfo: OAuthClientInformationMixed | undefined;
    needsReauth: boolean;
  };
}

/** In-memory CredentialStore for tests. Like the vault, it hides tokens once reauth is needed. */
export function createMemoryStore(shared?: { clientInfo?: OAuthClientInformationMixed }): MemoryStore {
  const state = {
    tokens: undefined as OAuthTokens | undefined,
    clientInfo: shared?.clientInfo,
    needsReauth: false,
  };
  return {
    state,
    loadTokens: async () => (state.needsReauth ? undefined : state.tokens),
    saveTokens: async (tokens) => {
      state.tokens = tokens;
      state.needsReauth = false;
    },
    markNeedsReauth: async () => {
      state.needsReauth = true;
    },
    loadClientInfo: async () => state.clientInfo,
    saveClientInfo: async (info) => {
      state.clientInfo = info;
    },
  };
}
