import { AppError, isAppError, UuidSchema } from "@brain/core";
import type { Logger } from "@brain/telemetry";
import { Body, Controller, Inject, Post, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import type { OutgoingHttpHeaders } from "node:http";
import { z } from "zod";
import { Ctx, type RequestContext } from "../context/request-context.js";
import { ANSWERS, LOGGER } from "../tokens.js";
import type { AnswersApi, AnswerStreamEvent } from "./answers.service.js";

const AnswerBodySchema = z.object({ q: z.string().trim().min(1).max(500), conversationId: UuidSchema.optional() });

/** An item from the person's own search results. Only the service's access check decides if it is read. */
const SummaryBodySchema = z.strictObject({
  serverId: z.string().regex(/^[a-z0-9-]{1,40}$/),
  externalId: z.string().min(1).max(200),
  url: z.string().url().max(2000).refine((u) => u.startsWith("https://"), "https only"),
  siteId: z.string().regex(/^[\w-]{1,100}$/).optional(),
  // Shown to the model as the document's title, so control characters that could reshape it are removed.
  title: z
    .string()
    .max(300)
    .transform((t) => t.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").trim())
    .pipe(z.string().min(1)),
});

@Controller("answers")
export class AnswersController {
  constructor(
    @Inject(ANSWERS) private readonly answers: AnswersApi,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** Streams an answer as server-sent events. POST, because the question must not be in a URL. */
  @Post()
  async answer(
    @Ctx() ctx: RequestContext,
    @Body() body: unknown,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const parsed = AnswerBodySchema.safeParse(body);
    if (!parsed.success) throw new AppError("VALIDATION", "Invalid request parameters");
    await this.stream(ctx, reply, "Answer", (send, signal) =>
      this.answers.answer({ tenantId: ctx.tenantId, userId: ctx.userId }, parsed.data.q, send, signal, parsed.data.conversationId),
    );
  }

  /** Streams a summary of one item (FR-AST-06), in the same events as an answer. */
  @Post("summary")
  async summary(@Ctx() ctx: RequestContext, @Body() body: unknown, @Res() reply: FastifyReply): Promise<void> {
    const summarise = this.answers.summarise?.bind(this.answers);
    if (!summarise) throw new AppError("NOT_FOUND", "Summaries are not available here");
    const parsed = SummaryBodySchema.safeParse(body);
    if (!parsed.success) throw new AppError("VALIDATION", "Invalid request parameters");
    const { siteId, ...item } = parsed.data;
    await this.stream(ctx, reply, "Summary", (send, signal) =>
      summarise({ tenantId: ctx.tenantId, userId: ctx.userId }, { ...item, ...(siteId ? { siteId } : {}) }, send, signal),
    );
  }

  private async stream(
    ctx: RequestContext,
    reply: FastifyReply,
    label: string,
    work: (send: (event: AnswerStreamEvent) => void, signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    reply.hijack();
    const raw = reply.raw;
    // Hijacking bypasses Fastify's send, so carry over the CORS headers it already set.
    const carried = Object.entries(reply.getHeaders()).filter(([, value]) => value !== undefined);
    raw.writeHead(200, {
      ...(Object.fromEntries(carried) as OutgoingHttpHeaders),
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    });

    const controller = new AbortController();
    raw.on("close", () => {
      if (!raw.writableEnded) controller.abort();
    });
    const send = (event: AnswerStreamEvent) => {
      if (!raw.writableEnded) raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    try {
      await work(send, controller.signal);
    } catch (err) {
      const log = this.logger.child({ request_id: ctx.requestId, tenant_id: ctx.tenantId, user_id: ctx.userId });
      if (isAppError(err)) {
        log.warn({ code: err.code, details: err.details }, `${label} failed`);
        send({ type: "error", code: err.code, message: err.message });
      } else {
        log.error({ err }, `${label} failed unexpectedly`);
        send({ type: "error", code: "INTERNAL", message: "Something went wrong. Please try again." });
      }
    } finally {
      raw.end();
    }
  }
}
