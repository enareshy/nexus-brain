import { AppError, type SecretBox } from "@brain/core";
import {
  addMemory,
  appendAudit,
  deleteAllMemories,
  deleteMemory,
  listMemories,
  updateMemory,
  type PoolLike,
  type StoredMemory,
  type UserScope,
} from "@brain/db";
import type { Logger } from "@brain/telemetry";
import { randomUUID } from "node:crypto";

/** Enough for a handful of preferences and facts, small enough to send with every request. */
export const MAX_MEMORIES = 30;
export const MAX_MEMORY_CHARS = 300;
/** Control and invisible formatting characters, which could disguise what a memory says or where it ends. */
const HIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export interface MemoryView {
  readonly id: string;
  /** Empty when the memory cannot be decrypted, which only deleting it can fix. */
  readonly text: string;
  readonly readable: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What answers and agents read. Fresh on every call, so an edit or a deletion applies at once. */
export interface MemorySource {
  forPrompt(scope: UserScope): Promise<readonly string[]>;
}

export interface MemoryApi extends MemorySource {
  list(scope: UserScope): Promise<readonly MemoryView[]>;
  add(scope: UserScope, text: string): Promise<MemoryView>;
  update(scope: UserScope, id: string, text: string): Promise<MemoryView>;
  remove(scope: UserScope, id: string): Promise<void>;
  removeAll(scope: UserScope): Promise<{ deleted: number }>;
}

/** Checked here, not only at the route, so no other caller can store anything but one plain line. */
export function cleanMemoryText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed || [...trimmed].length > MAX_MEMORY_CHARS || HIDDEN_CHARACTERS.test(trimmed)) {
    throw new AppError("VALIDATION", `A memory is one line of up to ${MAX_MEMORY_CHARS} characters`);
  }
  return trimmed;
}

/**
 * Things the person asked Brain to remember (FR-AST-07). Only the person writes them: nothing a
 * document says and nothing the model writes can become a memory, so planted text cannot persist.
 * The audit trail records that a memory changed, never what it says.
 */
export class MemoryService implements MemoryApi {
  constructor(
    private readonly deps: {
      readonly pool: PoolLike;
      readonly box: Pick<SecretBox, "seal" | "open">;
      readonly logger: Pick<Logger, "error">;
    },
  ) {}

  private context(scope: UserScope, id: string): string {
    return `memory|${scope.tenantId}|${scope.userId}|${id}`;
  }

  private view(scope: UserScope, row: StoredMemory): MemoryView {
    const dates = { createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
    try {
      return { id: row.id, text: this.deps.box.open(row.textCiphertext, this.context(scope, row.id)), readable: true, ...dates };
    } catch {
      // One damaged memory must not stop answers or hide the others; the person can still delete it.
      this.deps.logger.error({ tenant_id: scope.tenantId, user_id: scope.userId, memoryId: row.id }, "Memory could not be decrypted");
      return { id: row.id, text: "", readable: false, ...dates };
    }
  }

  async list(scope: UserScope): Promise<readonly MemoryView[]> {
    return (await listMemories(this.deps.pool, scope)).map((row) => this.view(scope, row));
  }

  async forPrompt(scope: UserScope): Promise<readonly string[]> {
    return (await this.list(scope)).filter((memory) => memory.readable).map((memory) => memory.text);
  }

  async add(scope: UserScope, text: string): Promise<MemoryView> {
    const clean = cleanMemoryText(text);
    const id = randomUUID();
    const row = await addMemory(this.deps.pool, scope, { id, textCiphertext: this.deps.box.seal(clean, this.context(scope, id)) }, MAX_MEMORIES);
    if (!row) throw new AppError("VALIDATION", `You can keep up to ${MAX_MEMORIES} memories. Delete one first.`);
    await this.audit(scope, "memory.added", id);
    return this.view(scope, row);
  }

  async update(scope: UserScope, id: string, text: string): Promise<MemoryView> {
    const clean = cleanMemoryText(text);
    const row = await updateMemory(this.deps.pool, scope, id, this.deps.box.seal(clean, this.context(scope, id)));
    if (!row) throw new AppError("NOT_FOUND", "Memory not found");
    await this.audit(scope, "memory.edited", id);
    return this.view(scope, row);
  }

  async remove(scope: UserScope, id: string): Promise<void> {
    if (!(await deleteMemory(this.deps.pool, scope, id))) throw new AppError("NOT_FOUND", "Memory not found");
    await this.audit(scope, "memory.deleted", id);
  }

  async removeAll(scope: UserScope): Promise<{ deleted: number }> {
    const deleted = await deleteAllMemories(this.deps.pool, scope);
    await this.audit(scope, "memory.deleted_all", undefined, { deleted });
    return { deleted };
  }

  /**
   * After the change: telling the person it failed when it worked would make them repeat it. A memory
   * holds the person's own words about themselves, so a missing audit row is logged rather than fatal.
   */
  private async audit(scope: UserScope, action: string, resource?: string, meta?: Record<string, unknown>): Promise<void> {
    await appendAudit(this.deps.pool, {
      tenantId: scope.tenantId,
      userId: scope.userId,
      action,
      ...(resource ? { resource } : {}),
      ...(meta ? { meta } : {}),
    }).catch((err: unknown) => {
      const errorType = err instanceof Error ? err.name : typeof err;
      this.deps.logger.error({ errorType, action, tenant_id: scope.tenantId, user_id: scope.userId }, "Audit write failed");
    });
  }
}
