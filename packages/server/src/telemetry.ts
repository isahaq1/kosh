/**
 * OpenTelemetry (CLAUDE.md, observability): one span per request (`HTTP GET /api/...`, with method, route, status and
 * request id) and a child span around the Shutro transaction. `startTelemetry` installs the SDK when an exporter is
 * configured (OTLP over HTTP via `OTEL_EXPORTER_OTLP_ENDPOINT`, or span processors passed in, e.g. in tests).
 */
import { type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK, tracing } from '@opentelemetry/sdk-node';

/** The tracer Kosh's spans come from. */
export const tracer: ReturnType<typeof trace.getTracer> = trace.getTracer('kosh-server', '0.1.0');

/** A started telemetry SDK. */
export interface Telemetry {
  shutdown(): Promise<void>;
}

/**
 * Starts the OpenTelemetry SDK when there is somewhere to send spans; otherwise does nothing (the API is a no-op).
 */
export function startTelemetry(
  options: {
    readonly serviceName?: string;
    readonly spanProcessors?: readonly tracing.SpanProcessor[];
  } = {},
): Telemetry {
  const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  const processors = [
    ...(options.spanProcessors ?? []),
    ...(endpoint === undefined ? [] : [new tracing.BatchSpanProcessor(new OTLPTraceExporter())]),
  ];
  if (processors.length === 0) return { shutdown: async () => {} };
  const sdk = new NodeSDK({
    serviceName: options.serviceName ?? 'kosh',
    spanProcessors: processors,
  });
  sdk.start();
  return { shutdown: () => sdk.shutdown() };
}

/** Ends a request span with its status. */
export function endSpan(span: Span, status: number, error?: unknown): void {
  span.setAttribute('http.response.status_code', status);
  if (error !== undefined)
    span.recordException(error instanceof Error ? error : new Error(String(error)));
  if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
  span.end();
}
