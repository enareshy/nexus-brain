import type { SecretBox } from "@brain/core";
import {
  getClientRegistration,
  getConnection,
  markConnection,
  saveClientRegistration,
  saveConnection,
  type PoolLike,
  type UserScope,
} from "@brain/db";
import {
  parseStoredClientInfo,
  parseStoredTokens,
  type CredentialStore,
  type OAuthClientInformationMixed,
  type OAuthTokens,
} from "@brain/mcp-client";

/** AAD context: a sealed token only opens for the same tenant, user and server. */
export function tokenContext(scope: UserScope, serverId: string): string {
  return `tokens|${scope.tenantId}|${scope.userId}|${serverId}`;
}

export function verifierContext(stateHash: string): string {
  return `pkce|${stateHash}`;
}

function clientContext(serverId: string): string {
  return `client|${serverId}`;
}

/** Reads the user's tokens regardless of status (used for revocation on disconnect). */
export async function readStoredTokens(
  pool: PoolLike,
  box: SecretBox,
  scope: UserScope,
  serverId: string,
): Promise<OAuthTokens | undefined> {
  const row = await getConnection(pool, scope, serverId);
  return row ? parseStoredTokens(box.open(row.tokensCiphertext, tokenContext(scope, serverId))) : undefined;
}

/** Opens tokens already taken out of the database, such as those deleted when someone is turned off. */
export function openTokens(box: SecretBox, scope: UserScope, serverId: string, tokensCiphertext: string): OAuthTokens | undefined {
  return parseStoredTokens(box.open(tokensCiphertext, tokenContext(scope, serverId)));
}

export async function readClientInfo(
  pool: PoolLike,
  box: SecretBox,
  serverId: string,
): Promise<OAuthClientInformationMixed | undefined> {
  const sealed = await getClientRegistration(pool, serverId);
  return sealed ? parseStoredClientInfo(box.open(sealed, clientContext(serverId))) : undefined;
}

/** CredentialStore over Postgres (RLS per user) with AES-GCM sealed secrets. */
export function createVaultStore(
  pool: PoolLike,
  box: SecretBox,
  scope: UserScope,
  serverId: string,
): CredentialStore {
  return {
    async loadTokens() {
      const row = await getConnection(pool, scope, serverId);
      if (!row || row.status !== "active") return undefined;
      return parseStoredTokens(box.open(row.tokensCiphertext, tokenContext(scope, serverId)));
    },
    async saveTokens(tokens) {
      await saveConnection(pool, scope, {
        serverId,
        tokensCiphertext: box.seal(JSON.stringify(tokens), tokenContext(scope, serverId)),
        scopes: tokens.scope ?? null,
        expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null,
      });
    },
    markNeedsReauth: () => markConnection(pool, scope, serverId, "needs_reauth"),
    loadClientInfo: () => readClientInfo(pool, box, serverId),
    async saveClientInfo(info) {
      await saveClientRegistration(pool, serverId, box.seal(JSON.stringify(info), clientContext(serverId)));
    },
  };
}
