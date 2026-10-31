import type { Logger } from "@brain/telemetry";
import { Module, type DynamicModule } from "@nestjs/common";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { randomUUID } from "node:crypto";
import { AuthGuard } from "./auth/auth.guard.js";
import type { IdentityVerifier } from "./auth/jwt-verifier.js";
import type { UserDirectory } from "./auth/user-directory.js";
import { AllExceptionsFilter } from "./common/exception.filter.js";
import { HealthController, MeController } from "./controllers.js";
import { IDENTITY_VERIFIER, LOGGER, USER_DIRECTORY } from "./tokens.js";

export interface AppDeps {
  readonly verifier: IdentityVerifier;
  readonly directory: UserDirectory;
  readonly logger: Logger;
}

@Module({})
class AppModule {
  static register(deps: AppDeps): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, MeController],
      providers: [
        { provide: IDENTITY_VERIFIER, useValue: deps.verifier },
        { provide: USER_DIRECTORY, useValue: deps.directory },
        { provide: LOGGER, useValue: deps.logger },
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
  app.useGlobalFilters(new AllExceptionsFilter(deps.logger));
  app.enableShutdownHooks();
  return app;
}
