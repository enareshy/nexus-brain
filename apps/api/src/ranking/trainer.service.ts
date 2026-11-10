import type { Logger } from "@brain/telemetry";
import { trainCompanies, type CompanyTraining, type TrainingStore } from "./train.js";

/** Once a day is plenty for ratings that build up over weeks. */
const TRAIN_EVERY_MS = 24 * 60 * 60 * 1000;
/** The first run waits a little after start, so a restart is not slowed by it. */
const FIRST_RUN_AFTER_MS = 10 * 60 * 1000;

/**
 * Trains each company's learned ranker on a timer (FR-RET-08), through the app's scoped database
 * functions. `exclusive` runs it on one server at a time; another server that finds it running skips
 * that round. A problem with one company is logged and the rest still train.
 */
export class RankerTrainer {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly deps: {
      readonly store: TrainingStore;
      readonly logger: Pick<Logger, "info" | "warn" | "error">;
      /** Runs `work` unless another server already is; resolves to null if it skipped. */
      readonly exclusive?: <T>(work: () => Promise<T>) => Promise<T | null>;
    },
  ) {}

  /** One round for every company. Null when another server was already training. */
  async trainAll(): Promise<readonly CompanyTraining[] | null> {
    const work = () =>
      trainCompanies(this.deps.store, (tenantId, err) =>
        this.deps.logger.error({ tenant_id: tenantId, errorType: err instanceof Error ? err.name : typeof err }, "Training a company's ranker failed"),
      );
    const results = this.deps.exclusive ? await this.deps.exclusive(work) : await work();
    if (results === null) {
      this.deps.logger.info({}, "Ranker training skipped: another server is running it");
      return null;
    }
    for (const { tenantId, metrics } of results) {
      this.deps.logger.info(
        { tenant_id: tenantId, answers: metrics.answers, examples: metrics.examples, active: metrics.active, reason: metrics.reason },
        "Company ranker trained",
      );
    }
    return results;
  }

  start(): void {
    if (this.timer) return;
    const run = () => {
      void this.trainAll()
        .catch((err: unknown) => this.deps.logger.error({ errorType: err instanceof Error ? err.name : typeof err }, "Ranker training failed"))
        .finally(() => {
          if (this.timer) this.schedule(run, TRAIN_EVERY_MS);
        });
    };
    this.schedule(run, FIRST_RUN_AFTER_MS);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** One round at a time: the next is set only when the last has finished. */
  private schedule(run: () => void, delayMs: number): void {
    this.timer = setTimeout(run, delayMs);
    this.timer.unref?.();
  }
}
