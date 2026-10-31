import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { NodeSDK } from "@opentelemetry/sdk-node";

export interface TracingHandle {
  readonly enabled: boolean;
  shutdown(): Promise<void>;
}

const DISABLED: TracingHandle = Object.freeze({ enabled: false, shutdown: async () => {} });

/**
 * Starts OpenTelemetry tracing when an OTLP endpoint is configured; otherwise a no-op.
 * Call before the HTTP server is created so incoming requests are instrumented.
 */
export function startTracing(serviceName: string, otlpEndpoint: string | undefined): TracingHandle {
  if (!otlpEndpoint) return DISABLED;

  const sdk = new NodeSDK({
    serviceName,
    traceExporter: new OTLPTraceExporter({ url: `${otlpEndpoint.replace(/\/$/, "")}/v1/traces` }),
    instrumentations: [new HttpInstrumentation()],
  });
  sdk.start();
  return { enabled: true, shutdown: () => sdk.shutdown() };
}
