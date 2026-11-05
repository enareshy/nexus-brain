import { AppError, type SecretBox } from "@brain/core";
import { addSkill, appendAudit, deleteSkill, getSkill, listSkills, updateSkill, type PoolLike, type StoredSkill, type UserScope } from "@brain/db";
import type { Logger } from "@brain/telemetry";
import { randomUUID } from "node:crypto";
import { AGENT_TOOLS } from "../agents/tools.js";

export const MAX_SKILLS = 50;
export const MAX_SKILL_NAME_CHARS = 80;
export const MAX_SKILL_INSTRUCTIONS_CHARS = 4_000;
export const MAX_SKILL_LINES = 60;
/** The agent's own tools. A skill can only narrow what a run may use, never add to it. */
export const SKILL_TOOLS: readonly string[] = AGENT_TOOLS.map((tool) => tool.name);
/**
 * Characters that are invisible or could disguise what a skill says: control and formatting characters
 * (except the joiners some scripts and emoji need), private-use and unassigned ones, and blanks that
 * look like nothing. Instructions may keep line breaks and tabs.
 */
const INVISIBLE = /(?![\u200C\u200D])[\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\p{Cs}]|\p{Variation_Selector}|\u115F|\u1160|\u3164|\u2800/u;
const HIDDEN_IN_NAME = new RegExp(`${INVISIBLE.source}|\\p{Cc}`, "u");
const HIDDEN_IN_INSTRUCTIONS = new RegExp(`${INVISIBLE.source}|(?![\\n\\t])\\p{Cc}`, "u");

export interface SkillInput {
  readonly name: string;
  readonly instructions: string;
  readonly tools: readonly string[];
  readonly shared: boolean;
}

export interface SkillView {
  readonly id: string;
  /** Empty when the skill cannot be decrypted, which only its owner deleting it can fix. */
  readonly name: string;
  readonly instructions: string;
  readonly tools: readonly string[];
  readonly shared: boolean;
  /** Whether the signed-in person wrote it, and so can change it. */
  readonly mine: boolean;
  readonly ownerName: string;
  readonly readable: boolean;
  readonly updatedAt: string;
}

/** What a run copies when it starts, so a later edit cannot change a run already going. */
export interface SkillForRun {
  readonly id: string;
  readonly name: string;
  readonly instructions: string;
  readonly tools: readonly string[];
  /** False for a colleague's skill, which the agent is told to follow only as far as the goal needs. */
  readonly mine: boolean;
}

export interface SkillsApi {
  list(scope: UserScope): Promise<readonly SkillView[]>;
  add(scope: UserScope, input: SkillInput): Promise<SkillView>;
  update(scope: UserScope, id: string, input: SkillInput): Promise<SkillView>;
  remove(scope: UserScope, id: string): Promise<void>;
  /** `version` is the `updatedAt` the person was shown, so a skill changed since then is never followed unseen. */
  forRun(scope: UserScope, id: string, version: string): Promise<SkillForRun>;
}

/** Checked here, not only at the route, so no caller can store a skill that hides what it says. */
export function cleanSkill(input: SkillInput): SkillInput {
  const name = input.name.trim();
  if (!name || [...name].length > MAX_SKILL_NAME_CHARS || HIDDEN_IN_NAME.test(name)) {
    throw new AppError("VALIDATION", `A skill's name is one line of up to ${MAX_SKILL_NAME_CHARS} characters`);
  }
  // Long runs of blank lines or tabs could push text out of sight below what the person reads.
  const instructions = input.instructions
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\t{2,}/g, "\t")
    .trim();
  const lines = instructions.split("\n").length;
  if (
    !instructions ||
    [...instructions].length > MAX_SKILL_INSTRUCTIONS_CHARS ||
    lines > MAX_SKILL_LINES ||
    HIDDEN_IN_INSTRUCTIONS.test(instructions)
  ) {
    throw new AppError(
      "VALIDATION",
      `A skill's instructions are up to ${MAX_SKILL_INSTRUCTIONS_CHARS} characters and ${MAX_SKILL_LINES} lines of plain text`,
    );
  }
  const tools = [...new Set(input.tools)];
  if (tools.length === 0 || tools.some((tool) => !SKILL_TOOLS.includes(tool))) {
    throw new AppError("VALIDATION", "Pick at least one of the agent's tools");
  }
  return { name, instructions, tools: SKILL_TOOLS.filter((tool) => tools.includes(tool)), shared: input.shared };
}

/**
 * Skills (FR-AST-08): a person's named instructions and choice of tools, to reuse when starting an
 * agent. Only the owner can change one; shared, anyone in the same company can use it. Using a skill
 * never widens access: the run acts as the person using it, with their own connections, and can only
 * propose changes for them to approve. The audit trail records which skill changed, never what it says.
 */
export class SkillsService implements SkillsApi {
  constructor(
    private readonly deps: {
      readonly pool: PoolLike;
      readonly box: Pick<SecretBox, "seal" | "open">;
      readonly logger: Pick<Logger, "error">;
    },
  ) {}

  /** Company-wide, as colleagues must be able to read a shared skill. */
  private context(scope: UserScope, id: string, field: "name" | "instructions"): string {
    return `skill|${scope.tenantId}|${id}|${field}`;
  }

  private view(scope: UserScope, row: StoredSkill): SkillView {
    const base = {
      id: row.id,
      tools: row.tools.filter((tool) => SKILL_TOOLS.includes(tool)),
      shared: row.shared,
      mine: row.ownerId === scope.userId,
      ownerName: row.ownerName,
      updatedAt: row.updatedAt.toISOString(),
    };
    try {
      return {
        ...base,
        name: this.deps.box.open(row.nameCiphertext, this.context(scope, row.id, "name")),
        instructions: this.deps.box.open(row.instructionsCiphertext, this.context(scope, row.id, "instructions")),
        readable: true,
      };
    } catch {
      this.deps.logger.error({ tenant_id: scope.tenantId, user_id: scope.userId, skillId: row.id }, "Skill could not be decrypted");
      return { ...base, name: "", instructions: "", readable: false };
    }
  }

  private sealed(scope: UserScope, id: string, input: SkillInput) {
    return {
      nameCiphertext: this.deps.box.seal(input.name, this.context(scope, id, "name")),
      instructionsCiphertext: this.deps.box.seal(input.instructions, this.context(scope, id, "instructions")),
      tools: input.tools,
      shared: input.shared,
    };
  }

  private async read(scope: UserScope, id: string): Promise<SkillView> {
    const row = await getSkill(this.deps.pool, scope, id);
    if (!row) throw new AppError("NOT_FOUND", "Skill not found");
    return this.view(scope, row);
  }

  async list(scope: UserScope): Promise<readonly SkillView[]> {
    return (await listSkills(this.deps.pool, scope)).map((row) => this.view(scope, row));
  }

  async add(scope: UserScope, input: SkillInput): Promise<SkillView> {
    const clean = cleanSkill(input);
    const id = randomUUID();
    if (!(await addSkill(this.deps.pool, scope, { id, ...this.sealed(scope, id, clean) }, MAX_SKILLS))) {
      throw new AppError("VALIDATION", `You can keep up to ${MAX_SKILLS} skills. Delete one first.`);
    }
    await this.audit(scope, "skill.added", id, { shared: clean.shared });
    return this.read(scope, id);
  }

  async update(scope: UserScope, id: string, input: SkillInput): Promise<SkillView> {
    const clean = cleanSkill(input);
    if (!(await updateSkill(this.deps.pool, scope, id, this.sealed(scope, id, clean)))) throw new AppError("NOT_FOUND", "Skill not found");
    await this.audit(scope, "skill.edited", id, { shared: clean.shared });
    return this.read(scope, id);
  }

  async remove(scope: UserScope, id: string): Promise<void> {
    if (!(await deleteSkill(this.deps.pool, scope, id))) throw new AppError("NOT_FOUND", "Skill not found");
    await this.audit(scope, "skill.deleted", id);
  }

  async forRun(scope: UserScope, id: string, version: string): Promise<SkillForRun> {
    const skill = await this.read(scope, id);
    if (!skill.readable || skill.tools.length === 0) throw new AppError("NOT_FOUND", "Skill not found");
    if (skill.updatedAt !== version) {
      throw new AppError("CONFLICT", "This skill has changed since you opened it. Read it again before using it.");
    }
    return { id: skill.id, name: skill.name, instructions: skill.instructions, tools: skill.tools, mine: skill.mine };
  }

  /** After the change, like memories: a missing audit row is logged rather than reported as a failed change. */
  private async audit(scope: UserScope, action: string, resource: string, meta?: Record<string, unknown>): Promise<void> {
    await appendAudit(this.deps.pool, { tenantId: scope.tenantId, userId: scope.userId, action, resource, ...(meta ? { meta } : {}) }).catch(
      (err: unknown) => {
        const errorType = err instanceof Error ? err.name : typeof err;
        this.deps.logger.error({ errorType, action, tenant_id: scope.tenantId, user_id: scope.userId }, "Audit write failed");
      },
    );
  }
}
