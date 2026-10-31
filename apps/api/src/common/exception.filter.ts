import { fail, isAppError, type ErrorCode } from "@brain/core";
import type { Logger } from "@brain/telemetry";
import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import type { ContextRequest } from "../context/request-context.js";

const HTTP_CODE: Readonly<Record<number, ErrorCode>> = {
  400: "VALIDATION",
  401: "UNAUTHENTICATED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
  429: "RATE_LIMITED",
  503: "UNAVAILABLE",
};

/** Maps every error to the API envelope. Internal details never reach the client. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<ContextRequest>();
    const reply = http.getResponse<FastifyReply>();
    const meta = { requestId: String(request.id) };
    const log = this.logger.child({
      request_id: meta.requestId,
      tenant_id: request.ctx?.tenantId,
      user_id: request.ctx?.userId,
    });

    if (isAppError(exception)) {
      log.warn({ code: exception.code, details: exception.details }, exception.message);
      void reply.status(exception.status).send(fail(exception.code, exception.message, meta));
      return;
    }

    const clientStatus = clientErrorStatus(exception);
    if (clientStatus !== null) {
      const code = HTTP_CODE[clientStatus] ?? "VALIDATION";
      void reply.status(clientStatus).send(fail(code, (exception as Error).message, meta));
      return;
    }

    log.error({ err: exception }, "Unhandled error");
    void reply.status(500).send(fail("INTERNAL", "Internal error", meta));
  }
}

/**
 * 4xx status from a Nest HttpException or a Fastify-native error (invalid JSON body,
 * payload too large, unsupported media type). 5xx and unknown errors return null.
 */
function clientErrorStatus(exception: unknown): number | null {
  const status =
    exception instanceof HttpException
      ? exception.getStatus()
      : exception instanceof Error && "statusCode" in exception
        ? Number((exception as { statusCode: unknown }).statusCode)
        : NaN;
  return status >= 400 && status < 500 ? status : null;
}
