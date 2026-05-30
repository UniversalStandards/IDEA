import { SpanKind, SpanStatusCode, type Histogram } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

export interface OtelExporterOptions {
  serviceName?: string;
  otlpEndpoint: string;
  metricExportIntervalMs?: number;
}

export interface OtelTraceEvent {
  orgId: string;
  traceName: string;
  durationMs: number;
  attributes?: Record<string, string | number | boolean>;
  status?: 'ok' | 'error';
}

export interface OtelMetricEvent {
  orgId: string;
  metricName: string;
  value: number;
  attributes?: Record<string, string | number | boolean>;
}

export class OtelExporter {
  private readonly tracerProvider: NodeTracerProvider;
  private readonly meterProvider: MeterProvider;
  private readonly histogram: Histogram;

  constructor(options: OtelExporterOptions) {
    const traceExporter = new OTLPTraceExporter({ url: options.otlpEndpoint });
    const metricExporter = new OTLPMetricExporter({ url: options.otlpEndpoint });

    this.tracerProvider = new NodeTracerProvider({
      spanProcessors: [new BatchSpanProcessor(traceExporter)],
    });
    this.tracerProvider.register();

    this.meterProvider = new MeterProvider({
      readers: [
        new PeriodicExportingMetricReader({
          exporter: metricExporter,
          exportIntervalMillis: options.metricExportIntervalMs ?? 5_000,
        }),
      ],
    });

    this.histogram = this.meterProvider
      .getMeter(options.serviceName ?? 'universal-mcp-hub')
      .createHistogram('mcp_observed_metric');
  }

  exportTrace(event: OtelTraceEvent): void {
    const tracer = this.tracerProvider.getTracer('universal-mcp-hub');
    const endTime = Date.now();
    const startTime = endTime - Math.max(0, event.durationMs);
    const span = tracer.startSpan(event.traceName, {
      kind: SpanKind.INTERNAL,
      startTime,
      attributes: {
        orgId: event.orgId,
        duration_ms: event.durationMs,
        ...(event.attributes ?? {}),
      },
    });
    span.setStatus({
      code: event.status === 'error' ? SpanStatusCode.ERROR : SpanStatusCode.OK,
    });
    span.end(endTime);
  }

  exportMetric(event: OtelMetricEvent): void {
    this.histogram.record(event.value, {
      orgId: event.orgId,
      metricName: event.metricName,
      ...(event.attributes ?? {}),
    });
  }

  async forceFlush(): Promise<void> {
    await Promise.all([
      this.tracerProvider.forceFlush(),
      this.meterProvider.forceFlush(),
    ]);
  }

  async shutdown(): Promise<void> {
    await Promise.all([
      this.tracerProvider.shutdown(),
      this.meterProvider.shutdown(),
    ]);
  }
}
