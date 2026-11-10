import type { Logger } from "@brain/telemetry";
import rateLimit from "@fastify/rate-limit";
import { Module, type DynamicModule } from "@nestjs/common";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { createHash, randomUUID } from "node:crypto";
import { AuthGuard } from "./auth/auth.guard.js";
import type { IdentityVerifier } from "./auth/jwt-verifier.js";
import type { UserDirectory } from "./auth/user-directory.js";
import { AllExceptionsFilter } from "./common/exception.filter.js";
import {
  ConnectionsController,
  OAuthCallbackController,
  SearchController,
} from "./connections/connections.controller.js";
import type { ConnectionsApi } from "./connections/connections.service.js";
import { AnswersController } from "./answers/answers.controller.js";
import type { AnswersApi } from "./answers/answers.service.js";
import { HealthController, MeController } from "./controllers.js";
import { AgentsController } from "./agents/agents.controller.js";
import type { AgentsApi } from "./agents/agents.service.js";
import { TriggersController } from "./agents/triggers.controller.js";
import type { TriggersApi } from "./agents/triggers.service.js";
import { AuditController } from "./admin/audit.controller.js";
import type { AuditApi } from "./admin/audit.service.js";
import { PeopleController } from "./admin/people.controller.js";
import type { PeopleApi } from "./admin/people.service.js";
import { MemoryController } from "./memory/memory.controller.js";
import { GraphController } from "./graph/graph.controller.js";
import type { WorkGraphApi } from "./graph/graph.service.js";
import type { MemoryApi } from "./memory/memory.service.js";
import { DataController } from "./data/data.controller.js";
import type { ExportApi } from "./data/export.service.js";
import type { RetentionApi } from "./data/retention.service.js";
import { SkillsController } from "./skills/skills.controller.js";
import type { SkillsApi } from "./skills/skills.service.js";
import { UsageController } from "./usage/usage.controller.js";
import type { UsageApi } from "./usage/usage.service.js";
import { ConversationsController } from "./conversations/conversations.controller.js";
import type { ConversationsApi } from "./conversations/conversations.service.js";
import { McpController, type McpEndpointDeps } from "./mcp/mcp.controller.js";
import { ProposalsController } from "./proposals/proposals.controller.js";
import type { ProposalsApi } from "./proposals/proposals.service.js";
import { AiSettingsController } from "./admin/ai-settings.controller.js";
import type { AiSettingsApi } from "./admin/ai-settings.service.js";
import { AGENTS, AI_SETTINGS, ANSWERS, AUDIT, CONNECTIONS, CONVERSATIONS, IDENTITY_VERIFIER, LOGGER, MCP, EXPORTS, MEMORY, WORK_GRAPH, PEOPLE, RETENTION, SKILLS, PROPOSALS, TRIGGERS, USAGE, USER_DIRECTORY, WEB_APP_URL } from "./tokens.js";

const RATE_LIMIT_PER_MINUTE = 120;

export interface AppDeps {
  readonly verifier: IdentityVerifier;
  readonly directory: UserDirectory;
  readonly logger: Logger;
  readonly connections: ConnectionsApi;
  readonly answers: AnswersApi;
  readonly proposals: ProposalsApi;
  readonly audit: AuditApi;
  readonly conversations: ConversationsApi;
  readonly agents: AgentsApi;
  /** Without this, there is no MCP endpoint. */
  readonly mcp?: McpEndpointDeps;
  /** Without this, there are no automatic agents or notifications. */
  readonly triggers?: TriggersApi;
  /** Without this, admins cannot turn people off. */
  readonly people?: PeopleApi;
  /** Without this, there is no Memory page. */
  readonly memory?: MemoryApi;
  /** Without this, people cannot see or clear their own work graph. */
  readonly workGraph?: WorkGraphApi;
  /** Without this, there is no Skills page. */
  readonly skills?: SkillsApi;
  /** Without both, there are no retention settings or data export. */
  readonly data?: { readonly retention: RetentionApi; readonly exports: ExportApi };
  /** Without this, there is no spending dashboard and no budgets. */
  readonly usage?: UsageApi;
  /** Without this, there are no company AI settings, and the defaults apply. */
  readonly aiSettings?: AiSettingsApi;
  /** Browser origin of the web app: CORS allow-list and OAuth return target. */
  readonly webAppUrl: string;
}

@Module({})
class AppModule {
  static register(deps: AppDeps): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        ...(deps.mcp ? [McpController] : []),
        ...(deps.triggers ? [TriggersController] : []),
        ...(deps.people ? [PeopleController] : []),
        ...(deps.memory ? [MemoryController] : []),
        ...(deps.workGraph ? [GraphController] : []),
        ...(deps.skills ? [SkillsController] : []),
        ...(deps.data ? [DataController] : []),
        ...(deps.usage ? [UsageController] : []),
        ...(deps.aiSettings ? [AiSettingsController] : []),
        HealthController,
        MeController,
        ConnectionsController,
        SearchController,
        OAuthCallbackController,
        AnswersController,
        ProposalsController,
        AuditController,
        ConversationsController,
        AgentsController,
      ],
      providers: [
        { provide: IDENTITY_VERIFIER, useValue: deps.verifier },
        { provide: USER_DIRECTORY, useValue: deps.directory },
        { provide: LOGGER, useValue: deps.logger },
        { provide: CONNECTIONS, useValue: deps.connections },
        { provide: ANSWERS, useValue: deps.answers },
        { provide: PROPOSALS, useValue: deps.proposals },
        { provide: AUDIT, useValue: deps.audit },
        { provide: CONVERSATIONS, useValue: deps.conversations },
        { provide: AGENTS, useValue: deps.agents },
        ...(deps.mcp ? [{ provide: MCP, useValue: deps.mcp }] : []),
        ...(deps.triggers ? [{ provide: TRIGGERS, useValue: deps.triggers }] : []),
        ...(deps.people ? [{ provide: PEOPLE, useValue: deps.people }] : []),
        ...(deps.memory ? [{ provide: MEMORY, useValue: deps.memory }] : []),
        ...(deps.workGraph ? [{ provide: WORK_GRAPH, useValue: deps.workGraph }] : []),
        ...(deps.skills ? [{ provide: SKILLS, useValue: deps.skills }] : []),
        ...(deps.data
          ? [
              { provide: RETENTION, useValue: deps.data.retention },
              { provide: EXPORTS, useValue: deps.data.exports },
            ]
          : []),
        ...(deps.usage ? [{ provide: USAGE, useValue: deps.usage }] : []),
        ...(deps.aiSettings ? [{ provide: AI_SETTINGS, useValue: deps.aiSettings }] : []),
        { provide: WEB_APP_URL, useValue: deps.webAppUrl },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    };
  }
}

/** Builds the API with injected dependencies so tests can supply fakes. */
export async function createApp(deps: AppDeps): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({ genReqId: () => randomUUID(), logger: false });
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(deps),
    adapter,
    { logger: false },
  );
  await app.register(rateLimit, {
    max: RATE_LIMIT_PER_MINUTE,
    timeWindow: "1 minute",
    // Per caller credential, so users behind one proxy IP do not share a budget.
    keyGenerator: (req) => {
      const auth = req.headers.authorization;
      return auth ? `token:${createHash("sha256").update(auth).digest("hex").slice(0, 32)}` : `ip:${req.ip}`;
    },
  });
  app.enableCors({ origin: [new URL(deps.webAppUrl).origin], credentials: false, methods: ["GET", "HEAD", "POST", "DELETE"] });
  app.useGlobalFilters(new AllExceptionsFilter(deps.logger));
  app.enableShutdownHooks();
  return app;
}
