import { AppError } from "@brain/core";
import { appendAudit, getProfile, type PoolLike, type UserScope } from "@brain/db";
import type { Logger } from "@brain/telemetry";

/** Exporting reads and decrypts everything a person has, so it is allowed once a minute per server. */
const EXPORT_INTERVAL_MS = 60_000;
const MAX_TRACKED = 5_000;
/** Far more runs or changes than anyone keeps; reaching it marks the export as cut short, never silently. */
export const EXPORT_LIMIT = 10_000;

/** Each part is read through the service that owns it, so access rules and decryption stay in one place. */
export interface ExportSources {
  readonly conversations: { exportAll(scope: UserScope): Promise<readonly unknown[]> };
  readonly memories: { list(scope: UserScope): Promise<readonly unknown[]> };
  readonly skills: { list(scope: UserScope): Promise<ReadonlyArray<{ readonly mine: boolean }>> };
  readonly agentRuns: { exportAll(scope: UserScope, limit: number): Promise<readonly unknown[]> };
  readonly automaticAgents: { list(scope: UserScope): Promise<readonly unknown[]> };
  readonly changes: { exportAll(scope: UserScope, limit: number): Promise<readonly unknown[]> };
  readonly connections: { list(scope: UserScope): Promise<ReadonlyArray<{ readonly serverId: string; readonly displayName: string; readonly status: string; readonly lastUsedAt: string | null }>> };
}

export interface PersonalExport {
  readonly exportedAt: string;
  /** True only if the person has more runs or changes than an export holds, so some were left out. */
  readonly truncated: boolean;
  readonly profile: { readonly email: string; readonly displayName: string; readonly role: string };
  readonly conversations: readonly unknown[];
  readonly memories: readonly unknown[];
  /** Only skills the person wrote; colleagues' shared skills are theirs. */
  readonly skills: readonly unknown[];
  readonly agentRuns: readonly unknown[];
  readonly automaticAgents: readonly unknown[];
  readonly changes: readonly unknown[];
  /** Which services are connected. Tokens are never exported. */
  readonly connections: readonly unknown[];
}

export interface ExportApi {
  exportFor(scope: UserScope): Promise<PersonalExport>;
}

/**
 * A person's own data, as one file they can keep (FR-ADM-03, GDPR access and portability). Only what
 * is theirs: nothing about colleagues, and no secrets. Usage costs are the company's, so are left out.
 */
export class ExportService implements ExportApi {
  private readonly recent = new Map<string, number>();

  constructor(
    private readonly deps: {
      readonly pool: PoolLike;
      readonly sources: ExportSources;
      readonly logger: Pick<Logger, "error">;
      readonly now?: () => number;
    },
  ) {}

  async exportFor(scope: UserScope): Promise<PersonalExport> {
    const now = (this.deps.now ?? Date.now)();
    const key = `${scope.tenantId}|${scope.userId}`;
    const last = this.recent.get(key);
    if (last !== undefined && now - last < EXPORT_INTERVAL_MS) {
      throw new AppError("RATE_LIMITED", "You exported your data a moment ago. Try again in a minute.");
    }

    const profile = await getProfile(this.deps.pool, scope);
    if (!profile) throw new AppError("NOT_FOUND", "Your account could not be found");
    const s = this.deps.sources;
    const [conversations, memories, skills, agentRuns, automaticAgents, changes, connections] = await Promise.all([
      s.conversations.exportAll(scope),
      s.memories.list(scope),
      s.skills.list(scope),
      s.agentRuns.exportAll(scope, EXPORT_LIMIT),
      s.automaticAgents.list(scope),
      s.changes.exportAll(scope, EXPORT_LIMIT),
      s.connections.list(scope),
    ]);
    // Recorded before anything is handed over: an export with no trail is not given out.
    await appendAudit(this.deps.pool, { tenantId: scope.tenantId, userId: scope.userId, action: "data.exported" }).catch((err: unknown) => {
      this.deps.logger.error({ errorType: err instanceof Error ? err.name : typeof err, tenant_id: scope.tenantId }, "Audit write failed");
      throw new AppError("UNAVAILABLE", "Your data could not be exported just now. Please try again.");
    });
    // Only a finished export counts toward the limit, so a failed one can be tried again at once.
    if (this.recent.size >= MAX_TRACKED) this.recent.clear();
    this.recent.set(key, now);
    return {
      exportedAt: new Date(now).toISOString(),
      truncated: agentRuns.length >= EXPORT_LIMIT || changes.length >= EXPORT_LIMIT,
      profile,
      conversations,
      memories,
      skills: skills.filter((skill) => skill.mine),
      agentRuns,
      automaticAgents,
      changes,
      connections: connections.map(({ serverId, displayName, status, lastUsedAt }) => ({ serverId, displayName, status, lastUsedAt })),
    };
  }
}
