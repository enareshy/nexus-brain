import { AppError, isAppError, type SecretBox } from "@brain/core";
import {
  addNotification,
  addTriggerEvent,
  claimTrigger,
  createTrigger,
  deleteTrigger,
  findDueAgentWork,
  listNotifications,
  listTriggers,
  markNotificationsRead,
  markTriggerBaselined,
  pauseTrigger,
  removeTriggerEvent,
  rescheduleTrigger,
  type PoolLike,
  type StoredTrigger,
  type UserScope,
} from "@brain/db";
import type { Logger } from "@brain/telemetry";
import { randomUUID } from "node:crypto";
import type { AiSettingsSource } from "../admin/ai-settings.service.js";
import type { AgentNotification, AgentsApi } from "./agents.service.js";

export const SCHEDULES = { hourly: 60, daily: 1_440, weekly: 10_080 } as const;
export type Schedule = keyof typeof SCHEDULES;

const MAX_TRIGGERS = 5;
const JIRA_CHECK_MINUTES = 5;
const RETRY_BUSY_MINUTES = 5;
/** Starts from one check, so a burst of assignments cannot start a burst of runs. */
const MAX_RUNS_PER_CHECK = 3;
const MAX_WORK_PER_TICK = 50;
const TICK_MS = 60_000;
/** One person's slow service must not hold up everyone else's triggers. */
const JIRA_CHECK_TIMEOUT_MS = 30_000;
const RETRY_AFTER_DAILY_LIMIT_MINUTES = 60;
const TURNED_OFF: ReadonlySet<string> = new Set(["agents_off", "automatic_off"]);
const NOTIFICATION_LIST_LIMIT = 30;
const MAX_TITLE_CHARS = 100;
const ONE_OF_KIND: Record<Exclude<StoredTrigger["kind"], "schedule">, string> = {
  jira_assigned: "You already have an automatic agent for Jira assignments. Remove it first",
  jira_mention: "You already have an automatic agent for @Brain mentions. Remove it first",
};

export interface AssignedIssue {
  readonly key: string;
  readonly siteId: string;
}

/** "@Brain ..." in a Jira comment the person wrote themselves. */
export interface MentionRequest {
  readonly siteId: string;
  readonly key: string;
  readonly commentId: string;
  readonly request: string;
}

/** Something new in Jira that may start a run. */
interface JiraEvent {
  readonly hashInput: string;
  readonly goal: string;
  readonly title: string;
}

export interface TriggerView {
  readonly id: string;
  readonly kind: StoredTrigger["kind"];
  readonly goal: string;
  readonly schedule: Schedule | null;
  readonly enabled: boolean;
  readonly pausedReason: string | null;
  readonly nextRunAt: string;
}

export interface NotificationView {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly runId: string | null;
  readonly read: boolean;
  readonly createdAt: string;
}

export type NewTrigger =
  | { readonly kind: "schedule"; readonly goal: string; readonly schedule: Schedule }
  | { readonly kind: "jira_assigned" | "jira_mention"; readonly goal: string };

export interface TriggersApi {
  create(scope: UserScope, trigger: NewTrigger): Promise<TriggerView>;
  list(scope: UserScope): Promise<readonly TriggerView[]>;
  remove(scope: UserScope, id: string): Promise<void>;
  notifications(scope: UserScope): Promise<{ items: readonly NotificationView[]; unread: number }>;
  markRead(scope: UserScope, ids?: readonly string[]): Promise<void>;
}

export interface TriggersDeps {
  readonly pool: PoolLike;
  readonly box: Pick<SecretBox, "seal" | "open" | "fingerprint">;
  readonly agents: Pick<AgentsApi, "start" | "resume">;
  /** Issues assigned to the person, read with their own connection. */
  readonly assignments: { list(scope: UserScope): Promise<readonly AssignedIssue[]> };
  /** The person's own @Brain comments, read with their own connection. */
  readonly mentions: { list(scope: UserScope): Promise<readonly MentionRequest[]> };
  readonly logger: Pick<Logger, "error">;
  /** Whether the company allows automatic agents. Without one, it does. */
  readonly aiSettings?: AiSettingsSource;
}

function withinTime<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AppError("UNAVAILABLE", "That took too long")), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

const scheduleOf = (minutes: number): Schedule | null =>
  (Object.entries(SCHEDULES).find(([, value]) => value === minutes)?.[0] as Schedule | undefined) ?? null;

export class TriggersService implements TriggersApi {
  private timer: ReturnType<typeof setInterval> | null = null;
  private isTicking = false;

  constructor(private readonly deps: TriggersDeps) {}

  private goalContext(scope: UserScope, id: string): string {
    return `trigger|${scope.tenantId}|${scope.userId}|${id}`;
  }

  private titleContext(scope: UserScope, id: string): string {
    return `notification|${scope.tenantId}|${scope.userId}|${id}`;
  }

  private view(scope: UserScope, row: StoredTrigger): TriggerView {
    return {
      id: row.id,
      kind: row.kind,
      goal: this.deps.box.open(row.goalCiphertext, this.goalContext(scope, row.id)),
      schedule: row.kind === "schedule" ? scheduleOf(row.intervalMinutes) : null,
      enabled: row.enabled,
      pausedReason: row.pausedReason,
      nextRunAt: row.nextRunAt.toISOString(),
    };
  }

  async create(scope: UserScope, trigger: NewTrigger): Promise<TriggerView> {
    const id = randomUUID();
    const interval = trigger.kind === "schedule" ? SCHEDULES[trigger.schedule] : JIRA_CHECK_MINUTES;
    const created = await createTrigger(
      this.deps.pool,
      scope,
      {
        id,
        kind: trigger.kind,
        goalCiphertext: this.deps.box.seal(trigger.goal, this.goalContext(scope, id)),
        intervalMinutes: interval,
        // A Jira trigger checks soon, to note what is already assigned. A schedule waits its first interval.
        firstRunInMinutes: trigger.kind === "schedule" ? interval : 0,
      },
      MAX_TRIGGERS,
    );
    if (created === "too_many") throw new AppError("RATE_LIMITED", `You can have up to ${MAX_TRIGGERS} automatic agents. Remove one first`);
    if (created === "one_of_kind" && trigger.kind !== "schedule") throw new AppError("VALIDATION", ONE_OF_KIND[trigger.kind]);
    const row = (await listTriggers(this.deps.pool, scope)).find((t) => t.id === id);
    if (!row) throw new AppError("INTERNAL", "The automatic agent could not be saved");
    return this.view(scope, row);
  }

  async list(scope: UserScope): Promise<readonly TriggerView[]> {
    return (await listTriggers(this.deps.pool, scope)).map((row) => this.view(scope, row));
  }

  async remove(scope: UserScope, id: string): Promise<void> {
    if (!(await deleteTrigger(this.deps.pool, scope, id))) throw new AppError("NOT_FOUND", "Automatic agent not found");
  }

  async notifications(scope: UserScope): Promise<{ items: readonly NotificationView[]; unread: number }> {
    const { items, unread } = await listNotifications(this.deps.pool, scope, NOTIFICATION_LIST_LIMIT);
    return {
      unread,
      items: items.map((row) => ({
        id: row.id,
        kind: row.kind,
        title: this.deps.box.open(row.titleCiphertext, this.titleContext(scope, row.id)),
        runId: row.agentRunId,
        read: row.readAt !== null,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  markRead(scope: UserScope, ids?: readonly string[]): Promise<void> {
    return markNotificationsRead(this.deps.pool, scope, ids);
  }

  /** Records an event for the person. A failure here must never stop the work that caused it. */
  readonly notify = async (scope: UserScope, notification: AgentNotification): Promise<void> => {
    const id = randomUUID();
    await addNotification(this.deps.pool, scope, {
      id,
      kind: notification.kind,
      dedupeKey: notification.dedupeKey,
      titleCiphertext: this.deps.box.seal(notification.title.slice(0, MAX_TITLE_CHARS), this.titleContext(scope, id)),
      agentRunId: notification.runId,
    }).catch((err: unknown) => this.logFailure(err, scope, "Notification write failed"));
  };

  start(): void {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Each item runs in its owner's own scope, and one person's failure does not affect another's. */
  async tick(): Promise<void> {
    if (this.isTicking) return;
    this.isTicking = true;
    try {
      for (const item of await findDueAgentWork(this.deps.pool, MAX_WORK_PER_TICK)) {
        const scope = { tenantId: item.tenantId, userId: item.userId };
        if (item.kind === "run") this.deps.agents.resume(scope, item.id);
        else await this.fire(scope, item.id).catch((err: unknown) => this.logFailure(err, scope, "Trigger failed"));
      }
    } catch (err) {
      this.deps.logger.error({ errorType: err instanceof Error ? err.name : typeof err }, "Agent scheduler tick failed");
    } finally {
      this.isTicking = false;
    }
  }

  private async fire(scope: UserScope, id: string): Promise<void> {
    const trigger = await claimTrigger(this.deps.pool, scope, id, (row) => row.intervalMinutes);
    if (!trigger) return;
    // Turned off by an admin: skip this time without reading any service. The claim set the next check.
    const settings = await this.deps.aiSettings?.get(scope.tenantId);
    if (settings && (!settings.agentsEnabled || !settings.automaticAgentsEnabled)) return;
    const goal = this.deps.box.open(trigger.goalCiphertext, this.goalContext(scope, id));
    if (trigger.kind === "schedule") {
      await this.startRun(scope, trigger, goal, goal);
      return;
    }
    await this.checkJira(scope, trigger, goal);
  }

  /** False when limits stopped the run. Hitting the daily limit is reported; being busy just retries soon. */
  private async startRun(scope: UserScope, trigger: StoredTrigger, goal: string, title: string): Promise<boolean> {
    try {
      await this.deps.agents.start(scope, goal, { triggerId: trigger.id });
      return true;
    } catch (err) {
      // Turned off by an admin in the meantime: nothing to report, as the person can see it.
      if (isAppError(err) && err.code === "FORBIDDEN" && TURNED_OFF.has(String(err.details?.limit))) return false;
      if (!isAppError(err) || (err.code !== "RATE_LIMITED" && err.code !== "BUDGET_EXCEEDED")) throw err;
      // An exhausted budget, like the daily limit, is reported once a day rather than retried soon.
      if (err.details?.limit === "triggered" || err.code === "BUDGET_EXCEEDED") {
        const day = new Date().toISOString().slice(0, 10);
        await this.notify(scope, { kind: "trigger_skipped", dedupeKey: `trigger:${trigger.id}:skipped:${day}`, title });
        if (trigger.kind !== "schedule") await rescheduleTrigger(this.deps.pool, scope, trigger.id, RETRY_AFTER_DAILY_LIMIT_MINUTES);
      } else {
        await rescheduleTrigger(this.deps.pool, scope, trigger.id, RETRY_BUSY_MINUTES);
      }
      return false;
    }
  }

  /** New Jira events for this trigger. Only keys, ids and the person's own words reach the goal. */
  private async readEvents(scope: UserScope, trigger: StoredTrigger, goal: string): Promise<JiraEvent[]> {
    if (trigger.kind === "jira_mention") {
      const mentions = await withinTime(this.deps.mentions.list(scope), JIRA_CHECK_TIMEOUT_MS);
      return mentions.map((m) => ({
        hashInput: `mention|${m.siteId}|${m.key}|${m.commentId}`,
        // The request leads, so the run and its notifications are named after it.
        goal: `${m.request}\n\nI asked this in my own comment on Jira issue ${m.key} on site ${m.siteId}. My standing instructions for these requests: ${goal}`,
        title: `${m.key}: ${m.request}`,
      }));
    }
    const issues = await withinTime(this.deps.assignments.list(scope), JIRA_CHECK_TIMEOUT_MS);
    // Only the key is used, never the title: anyone can write a title, and this text becomes the goal.
    return issues.map((issue) => ({
      hashInput: `${issue.siteId}|${issue.key}`,
      goal: `${goal}\n\nThis run started because Jira issue ${issue.key} on site ${issue.siteId} was assigned to me.`,
      title: `${issue.key}: ${goal}`,
    }));
  }

  private async checkJira(scope: UserScope, trigger: StoredTrigger, goal: string): Promise<void> {
    let events: readonly JiraEvent[];
    try {
      events = await this.readEvents(scope, trigger, goal);
    } catch (err) {
      const turnedOff = isAppError(err) && err.details?.reason === "service_turned_off";
      if (!isAppError(err) || (err.code !== "RECONNECT_REQUIRED" && !turnedOff)) throw err;
      await pauseTrigger(this.deps.pool, scope, trigger.id, turnedOff ? "service_turned_off" : "reconnect_jira");
      await this.notify(scope, { kind: "trigger_paused", dedupeKey: `trigger:${trigger.id}:paused:${Date.now()}`, title: goal });
      return;
    }
    const hashOf = (event: JiraEvent) => this.deps.box.fingerprint(event.hashInput);

    // What was already there when this was set up is not news.
    if (!trigger.baselinedAt) {
      for (const event of events) await addTriggerEvent(this.deps.pool, scope, trigger.id, hashOf(event));
      await markTriggerBaselined(this.deps.pool, scope, trigger.id);
      return;
    }

    let started = 0;
    for (const event of events) {
      if (started >= MAX_RUNS_PER_CHECK) return;
      const hash = hashOf(event);
      if (!(await addTriggerEvent(this.deps.pool, scope, trigger.id, hash))) continue;
      let didStart = false;
      try {
        didStart = await this.startRun(scope, trigger, event.goal, event.title);
      } finally {
        // Not started, for whatever reason, so a later check picks it up.
        if (!didStart) await removeTriggerEvent(this.deps.pool, scope, trigger.id, hash);
      }
      if (!didStart) return;
      started += 1;
    }
  }

  private logFailure(err: unknown, scope: UserScope, message: string): void {
    const errorType = err instanceof Error ? err.name : typeof err;
    const code = isAppError(err) ? err.code : undefined;
    this.deps.logger.error({ errorType, code, tenant_id: scope.tenantId, user_id: scope.userId }, message);
  }
}
