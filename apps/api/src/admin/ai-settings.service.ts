import { AppError } from "@brain/core";
import {
  effectiveModel,
  getAiPreferences,
  getAiSettings,
  saveAiSettings,
  setModelPreference,
  type AiSettings,
  type ModelChoice,
  type PoolLike,
  type UserScope,
} from "@brain/db";

/** Read before every answer, agent start and agent step, so a change takes effect at once. */
export interface AiSettingsSource {
  get(tenantId: string): Promise<AiSettings>;
}

export interface AiSettingsApi extends AiSettingsSource {
  /** The database checks the person is an active admin. */
  set(scope: UserScope, settings: AiSettings): Promise<AiSettings>;
  /** The person's own model choice, and whether their company lets them make one (FR-LLM-07). */
  personalModel(scope: UserScope): Promise<PersonalModelView>;
  setPersonalModel(scope: UserScope, modelChoice: ModelChoice | null): Promise<PersonalModelView>;
}

export interface PersonalModelView {
  /** Null: they use the company's model. */
  readonly modelChoice: ModelChoice | null;
  readonly companyModel: ModelChoice;
  readonly peopleCanChoose: boolean;
  /** What their answers and agents use now. */
  readonly inUse: ModelChoice;
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

  async personalModel(scope: UserScope): Promise<PersonalModelView> {
    const [settings, preferences] = await Promise.all([this.get(scope.tenantId), getAiPreferences(this.deps.pool, scope)]);
    return {
      modelChoice: preferences.modelChoice,
      companyModel: settings.modelChoice,
      peopleCanChoose: settings.peopleChooseModel,
      inUse: effectiveModel(settings, preferences.modelChoice),
    };
  }

  /** Going back to the company's model is always allowed; picking one only while the company allows it. */
  async setPersonalModel(scope: UserScope, modelChoice: ModelChoice | null): Promise<PersonalModelView> {
    if (modelChoice !== null && !(await this.get(scope.tenantId)).peopleChooseModel) {
      throw new AppError("FORBIDDEN", "Your company uses one model for everyone");
    }
    await setModelPreference(this.deps.pool, scope, modelChoice);
    return this.personalModel(scope);
  }
}
