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
import { AuditController } from "./admin/audit.controller.js";
import type { AuditApi } from "./admin/audit.service.js";
import { ProposalsController } from "./proposals/proposals.controller.js";
import type { ProposalsApi } from "./proposals/proposals.service.js";
import { ANSWERS, AUDIT, CONNECTIONS, IDENTITY_VERIFIER, LOGGER, PROPOSALS, USER_DIRECTORY, WEB_APP_URL } from "./tokens.js";

const RATE_LIMIT_PER_MINUTE = 120;

export interface AppDeps {
  readonly verifier: IdentityVerifier;
  readonly directory: UserDirectory;
  readonly logger: Logger;
  readonly connections: ConnectionsApi;
  readonly answers: AnswersApi;
  readonly proposals: ProposalsApi;
  readonly audit: AuditApi;
  /** Browser origin of the web app: CORS allow-list and OAuth return target. */
  readonly webAppUrl: string;
}

@Module({})
class AppModule {
  static register(deps: AppDeps): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        HealthController,
        MeController,
        ConnectionsController,
        SearchController,
        OAuthCallbackController,
        AnswersController,
        ProposalsController,
        AuditController,
      ],
      providers: [
        { provide: IDENTITY_VERIFIER, useValue: deps.verifier },
        { provide: USER_DIRECTORY, useValue: deps.directory },
        { provide: LOGGER, useValue: deps.logger },
        { provide: CONNECTIONS, useValue: deps.connections },
        { provide: ANSWERS, useValue: deps.answers },
        { provide: PROPOSALS, useValue: deps.proposals },
        { provide: AUDIT, useValue: deps.audit },
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
  app.enableCors({ origin: [new URL(deps.webAppUrl).origin], credentials: false });
  app.useGlobalFilters(new AllExceptionsFilter(deps.logger));
  app.enableShutdownHooks();
  return app;
}
