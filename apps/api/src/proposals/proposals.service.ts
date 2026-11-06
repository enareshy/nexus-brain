import { AppError } from "@brain/core";
import {
  argsHash,
  classifyTool,
  isApprovable,
  type ToolSession,
  type WriteAdapter,
  type WriteDraft,
  type WriteRequest,
  type WriteTarget,
} from "@brain/connectors";
import {
  activeUndos,
  appendAudit,
  claimProposal,
  countPendingProposals,
  createProposal,
  finishProposal,
  getProposal,
  listProposals,
  markStuckProposalsUnknown,
  recordProposalState,
  rejectProposal,
  releaseProposal,
  type PoolLike,
  type ProposalResult,
  type StoredProposal,
  type UserScope,
} from "@brain/db";
import type { Logger } from "@brain/telemetry";
import { randomUUID } from "node:crypto";

const PROPOSAL_TTL_MS = 60 * 60 * 1000;
/** A claim this old means the process stopped mid-write, so the outcome cannot be known. */
const STUCK_AFTER_MS = 5 * 60 * 1000;
const MAX_PENDING = 20;
const MAX_APPROVALS_PER_MINUTE = 10;
const LIST_LIMIT = 50;

export type ProposalState = StoredProposal["status"] | "expired";

export interface ProposalView {
  readonly id: string;
  readonly serverId: string;
  readonly action: string;
  readonly toolName: string;
  readonly toolClass: "write" | "external-effect";
  /** Exactly what the tool will receive. */
  readonly args: Readonly<Record<string, unknown>>;
  /** Send this back to approve; it ties the approval to the arguments shown. */
  readonly argsHash: string;
  readonly status: ProposalState;
  readonly externalId: string | null;
  readonly url: string | null;
  readonly errorCode: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  /** The agent run that drafted this, if any. */
  readonly agentRunId: string | null;
  /** For an undo: the change it undoes. */
  readonly undoOf: string | null;
  /** Whether this change can be undone (FR-WR-06). */
  readonly canUndo: boolean;
}

export interface ProposalsApi {
  targets(scope: UserScope, serverId: string): Promise<readonly WriteTarget[]>;
  list(scope: UserScope): Promise<readonly ProposalView[]>;
  get(scope: UserScope, id: string): Promise<ProposalView>;
  propose(scope: UserScope, serverId: string, request: WriteRequest): Promise<ProposalView>;
  approve(scope: UserScope, id: string, approvedHash: string): Promise<ProposalView>;
  reject(scope: UserScope, id: string): Promise<ProposalView>;
  undo(scope: UserScope, id: string): Promise<ProposalView>;
}

/** Implemented by ConnectionsService. */
export interface WriteSessions {
  readWithSession<T>(scope: UserScope, serverId: string, work: (session: ToolSession) => Promise<T>): Promise<T>;
  writeWithSession<T>(scope: UserScope, serverId: string, work: (session: ToolSession) => Promise<T>): Promise<T>;
}

export interface ProposalsDeps {
  readonly pool: PoolLike;
  readonly sessions: WriteSessions;
  readonly adapters: ReadonlyMap<string, WriteAdapter>;
  readonly logger: Logger;
  readonly now?: () => number;
}

/** Key order does not matter: two reads of the same fields compare equal. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries.map(([k, v]) => [k, canonical(v)]));
}

function sameState(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

type Sent = { readonly result: Awaited<ReturnType<ToolSession["callTool"]>>; readonly after: Record<string, unknown> | null };
type Attempt = Sent | "not_allowed" | "changed_since";

function stateOf(row: StoredProposal, now: number): ProposalState {
  return row.status === "pending" && row.expiresAt.getTime() <= now ? "expired" : row.status;
}

export class ProposalsService implements ProposalsApi {
  private readonly now: () => number;

  constructor(private readonly deps: ProposalsDeps) {
    this.now = deps.now ?? Date.now;
  }

  targets(scope: UserScope, serverId: string): Promise<readonly WriteTarget[]> {
    const adapter = this.adapter(serverId);
    return this.deps.sessions.readWithSession(scope, serverId, (session) => adapter.targets(session));
  }

  /** Up to `limit` of the person's proposals, newest first, for their data export. Changes nothing. */
  async exportAll(scope: UserScope, limit: number): Promise<readonly ProposalView[]> {
    // What a change replaced and left behind is the person's data too (text they could read in Jira).
    return (await listProposals(this.deps.pool, scope, limit)).map((row) => ({
      ...this.view(row),
      beforeState: row.beforeState,
      afterState: row.afterState,
    }));
  }

  async list(scope: UserScope): Promise<readonly ProposalView[]> {
    const stuck = await markStuckProposalsUnknown(this.deps.pool, scope, new Date(this.now() - STUCK_AFTER_MS));
    await Promise.all(stuck.map((row) => this.audit(scope, "write.unknown", row)));
    const rows = await listProposals(this.deps.pool, scope, LIST_LIMIT);
    return rows.filter((row) => this.deps.adapters.has(row.serverId)).map((row) => this.view(row));
  }

  async get(scope: UserScope, id: string): Promise<ProposalView> {
    return this.view(await this.requireProposal(scope, id));
  }

  /** A proposal from an agent. Its stable id means repeating the step finds the same proposal. */
  proposeForAgent(
    scope: UserScope,
    serverId: string,
    request: WriteRequest,
    origin: { readonly id: string; readonly agentRunId: string },
  ): Promise<ProposalView> {
    return this.createProposal(scope, serverId, request, origin);
  }

  /**
   * Proposes putting back what a change Brain made overwrote. It is an ordinary change that needs
   * approval, and it fails without writing if the fields were edited again since.
   */
  async undo(scope: UserScope, id: string): Promise<ProposalView> {
    const row = await this.requireProposal(scope, id);
    const adapter = this.adapter(row.serverId);
    if (!this.canUndo(row) || !adapter.undoDraft || !row.beforeState || !row.afterState) {
      throw new AppError("VALIDATION", "This change cannot be undone");
    }
    const [existing] = await activeUndos(this.deps.pool, scope, row.id);
    if (existing) return this.view(existing);
    await this.requireRoom(scope);
    const draft = adapter.undoDraft(this.draftOf(row), row.beforeState);
    return this.store(scope, adapter, draft, { id: randomUUID(), undoOf: row.id, expectedState: row.afterState });
  }

  /** Records what would be done. Nothing changes in the connected service here. */
  propose(scope: UserScope, serverId: string, request: WriteRequest): Promise<ProposalView> {
    return this.createProposal(scope, serverId, request, { id: randomUUID() });
  }

  private async createProposal(
    scope: UserScope,
    serverId: string,
    request: WriteRequest,
    origin: { readonly id: string; readonly agentRunId?: string },
  ): Promise<ProposalView> {
    const adapter = this.adapter(serverId);
    await this.requireRoom(scope);
    const draft = await this.deps.sessions.readWithSession(scope, serverId, (session) =>
      adapter.draft(session, request),
    );
    return this.store(scope, adapter, draft, origin);
  }

  private async requireRoom(scope: UserScope): Promise<void> {
    if ((await countPendingProposals(this.deps.pool, scope)) >= MAX_PENDING) {
      throw new AppError("RATE_LIMITED", "Too many changes are waiting. Approve or reject some first");
    }
  }

  private async store(
    scope: UserScope,
    adapter: WriteAdapter,
    draft: WriteDraft,
    origin: {
      readonly id: string;
      readonly agentRunId?: string;
      readonly undoOf?: string;
      readonly expectedState?: Record<string, unknown>;
    },
  ): Promise<ProposalView> {
    const toolClass = classifyTool(adapter.manifest, { name: draft.toolName, annotations: {} });
    if (!isApprovable(toolClass)) throw new AppError("FORBIDDEN", "This kind of change is not allowed");

    const row = await createProposal(this.deps.pool, scope, {
      ...origin,
      serverId: adapter.serverId,
      action: draft.action,
      toolName: draft.toolName,
      toolClass,
      args: { ...draft.args },
      argsHash: argsHash(draft.args),
      siteOrigin: draft.siteOrigin,
      expiresAt: new Date(this.now() + PROPOSAL_TTL_MS),
    }, MAX_PENDING);
    await this.audit(scope, "write.proposed", row);
    return this.view(row);
  }

  async approve(scope: UserScope, id: string, approvedHash: string): Promise<ProposalView> {
    const row = await this.requireProposal(scope, id);
    // Replaying an approval reports what happened; only the claim below can start a write.
    if (row.status !== "pending") return this.view(row);
    if (row.argsHash !== approvedHash || argsHash(row.args) !== row.argsHash) {
      throw new AppError("VALIDATION", "This change is not what was shown. Review it again");
    }
    if (stateOf(row, this.now()) === "expired") throw new AppError("VALIDATION", "This change has expired");

    const claimed = await claimProposal(this.deps.pool, scope, id, approvedHash, MAX_APPROVALS_PER_MINUTE);
    if (claimed === "rate_limited") {
      throw new AppError("RATE_LIMITED", "Too many changes in a short time. Wait a moment and try again");
    }
    if (!claimed) return this.view(await this.requireProposal(scope, id));
    try {
      // No audit record, no write (FR-WR-05).
      await this.appendAuditRow(scope, "write.approved", claimed);
    } catch (err) {
      this.logFailure(err, claimed.id, "Could not audit an approval");
      await releaseProposal(this.deps.pool, scope, claimed.id);
      throw new AppError("UNAVAILABLE", "This change could not be sent. Please try again");
    }
    return this.execute(scope, claimed);
  }

  async reject(scope: UserScope, id: string): Promise<ProposalView> {
    const rejected = await rejectProposal(this.deps.pool, scope, id);
    if (!rejected) return this.view(await this.requireProposal(scope, id));
    await this.audit(scope, "write.rejected", rejected);
    return this.view(rejected);
  }

  /**
   * Runs an approved call once. If it fails before the call is sent, the approval stays open.
   * Once sent, a failure means the change may or may not have happened, so it is never retried.
   */
  private async execute(scope: UserScope, row: StoredProposal): Promise<ProposalView> {
    let sent = false;
    try {
      const attempt = await this.deps.sessions.writeWithSession(scope, row.serverId, (session) =>
        this.attempt(scope, row, session, () => {
          sent = true;
        }),
      );
      if (attempt === "not_allowed") return await this.finish(scope, row, { status: "failed", errorCode: "tool_not_allowed" });
      if (attempt === "changed_since") return await this.finish(scope, row, { status: "failed", errorCode: "changed_since" });
      if (attempt.result.isError) return await this.finish(scope, row, { status: "failed", errorCode: "tool_refused" });
      const outcome = this.adapter(row.serverId).outcome(this.draftOf(row), attempt.result.text);
      const finished = await this.finish(scope, row, {
        status: "succeeded",
        externalId: outcome.externalId,
        resultUrl: outcome.url,
      });
      return await this.saveAfter(scope, finished, row.id, attempt.after);
    } catch (err) {
      if (!sent) {
        await releaseProposal(this.deps.pool, scope, row.id);
        throw err;
      }
      this.logFailure(err, row.id, "Write outcome unknown");
      return this.finish(scope, row, { status: "unknown", errorCode: "outcome_unknown" });
    }
  }

  /** The change is done and recorded: failing to save what it left only means it cannot be undone. */
  private async saveAfter(
    scope: UserScope,
    finished: ProposalView,
    id: string,
    after: Record<string, unknown> | null,
  ): Promise<ProposalView> {
    if (!after) return finished;
    try {
      if (!(await recordProposalState(this.deps.pool, scope, id, { after }))) return finished;
      return this.view(await this.requireProposal(scope, id));
    } catch (err) {
      this.logFailure(err, id, "Could not save a change's result for undo");
      return finished;
    }
  }

  /**
   * Inside the write session: re-checks the tool, reads what the change will overwrite and saves it
   * before sending, and for an undo refuses if that is not what Brain left behind.
   */
  private async attempt(scope: UserScope, row: StoredProposal, session: ToolSession, markSent: () => void): Promise<Attempt> {
    const adapter = this.adapter(row.serverId);
    const tool = (await session.listTools()).find((t) => t.name === row.toolName);
    // The server may have changed the tool since this was proposed (FR-WR-03).
    if (tool === undefined || !isApprovable(classifyTool(adapter.manifest, tool))) return "not_allowed";
    const draft = this.draftOf(row);
    const before = adapter.readState ? await adapter.readState(session, draft) : null;
    if (row.expectedState && (!before || !sameState(before, row.expectedState))) return "changed_since";
    if (before && !(await recordProposalState(this.deps.pool, scope, row.id, { before }))) {
      throw new AppError("INTERNAL", "Could not record what this change replaces");
    }
    markSent();
    const result = await session.callTool(row.toolName, row.args);
    if (result.isError || !before || !adapter.readState) return { result, after: null };
    // The change is made: failing to read it back only means it cannot be undone.
    const after = await adapter.readState(session, draft).catch((err: unknown) => {
      this.logFailure(err, row.id, "Could not read a change back");
      return null;
    });
    return { result, after };
  }

  private async finish(scope: UserScope, row: StoredProposal, result: ProposalResult): Promise<ProposalView> {
    const finished = await finishProposal(this.deps.pool, scope, row.id, result);
    if (!finished) throw new AppError("INTERNAL", "Could not record the result of this change");
    await this.audit(scope, `write.${result.status}`, finished);
    return this.view(finished);
  }

  private draftOf(row: StoredProposal): WriteDraft {
    return { action: row.action, toolName: row.toolName, args: row.args, siteOrigin: row.siteOrigin };
  }

  private adapter(serverId: string): WriteAdapter {
    const adapter = this.deps.adapters.get(serverId);
    if (!adapter) throw new AppError("NOT_FOUND", "This service does not support changes");
    return adapter;
  }

  private async requireProposal(scope: UserScope, id: string): Promise<StoredProposal> {
    const row = await getProposal(this.deps.pool, scope, id);
    if (!row) throw new AppError("NOT_FOUND", "Change not found");
    return row;
  }

  private view(row: StoredProposal): ProposalView {
    return {
      id: row.id,
      serverId: row.serverId,
      action: row.action,
      toolName: row.toolName,
      toolClass: row.toolClass,
      args: row.args,
      argsHash: row.argsHash,
      status: stateOf(row, this.now()),
      externalId: row.externalId,
      url: row.resultUrl,
      errorCode: row.errorCode,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      agentRunId: row.agentRunId,
      undoOf: row.undoOf,
      canUndo: this.canUndo(row),
    };
  }

  private canUndo(row: StoredProposal): boolean {
    const adapter = this.deps.adapters.get(row.serverId);
    return row.status === "succeeded" && row.beforeState !== null && row.afterState !== null && !!adapter?.undoDraft;
  }

  /** FR-WR-05. The change itself is never logged, only its hash. */
  private appendAuditRow(scope: UserScope, action: string, row: StoredProposal): Promise<void> {
    return appendAudit(this.deps.pool, {
      tenantId: scope.tenantId,
      userId: scope.userId,
      action,
      resource: row.serverId,
      meta: {
        proposalId: row.id,
        tool: row.toolName,
        argsHash: row.argsHash,
        approver: scope.userId,
        externalId: row.externalId,
        errorCode: row.errorCode,
        ...(row.undoOf ? { undoOf: row.undoOf } : {}),
      },
    });
  }

  /** For steps after the write: it already happened, so the person who approved it must still be told. */
  private async audit(scope: UserScope, action: string, row: StoredProposal): Promise<void> {
    try {
      await this.appendAuditRow(scope, action, row);
    } catch (err) {
      this.logFailure(err, row.id, "Audit write failed");
    }
  }

  /** Tool and transport errors can quote what was sent, so only their type is logged. */
  private logFailure(err: unknown, proposalId: string, message: string): void {
    const errorType = err instanceof Error ? err.name : typeof err;
    this.deps.logger.error({ errorType, proposalId }, message);
  }
}
