import { getAiSettings, saveAiSettings, type AiSettings, type PoolLike, type UserScope } from "@brain/db";

/** Read before every answer, agent start and agent step, so a change takes effect at once. */
export interface AiSettingsSource {
  get(tenantId: string): Promise<AiSettings>;
}

export interface AiSettingsApi extends AiSettingsSource {
  /** The database checks the person is an active admin. */
  set(scope: UserScope, settings: AiSettings): Promise<AiSettings>;
}

/** A company's AI settings (FR-ADM-02, FR-LLM-07): the model, and whether agents may run. */
export class AiSettingsService implements AiSettingsApi {
  constructor(private readonly deps: { readonly pool: PoolLike }) {}

  get(tenantId: string): Promise<AiSettings> {
    return getAiSettings(this.deps.pool, tenantId);
  }

  async set(scope: UserScope, settings: AiSettings): Promise<AiSettings> {
    await saveAiSettings(this.deps.pool, scope, settings);
    return settings;
  }
}
