const mockSpanEnd = jest.fn();
const mockSetStatus = jest.fn();
const mockStartSpan = jest.fn(() => ({
  setStatus: mockSetStatus,
  end: mockSpanEnd,
}));
const mockTracerProviderForceFlush = jest.fn(async () => Promise.resolve());
const mockTracerProviderShutdown = jest.fn(async () => Promise.resolve());
const mockRegister = jest.fn();
const mockHistogramRecord = jest.fn();
const mockMeterForceFlush = jest.fn(async () => Promise.resolve());
const mockMeterShutdown = jest.fn(async () => Promise.resolve());

jest.mock('@opentelemetry/sdk-trace-node', () => ({
  NodeTracerProvider: jest.fn().mockImplementation(() => ({
    register: mockRegister,
    getTracer: () => ({ startSpan: mockStartSpan }),
    forceFlush: mockTracerProviderForceFlush,
    shutdown: mockTracerProviderShutdown,
  })),
}));

jest.mock('@opentelemetry/sdk-metrics', () => ({
  MeterProvider: jest.fn().mockImplementation(() => ({
    getMeter: () => ({
      createHistogram: () => ({ record: mockHistogramRecord }),
    }),
    forceFlush: mockMeterForceFlush,
    shutdown: mockMeterShutdown,
  })),
  PeriodicExportingMetricReader: jest.fn(),
}));

jest.mock('@opentelemetry/exporter-trace-otlp-grpc', () => ({
  OTLPTraceExporter: jest.fn(),
}));

jest.mock('@opentelemetry/exporter-metrics-otlp-grpc', () => ({
  OTLPMetricExporter: jest.fn(),
}));

import { OtelExporter } from '../src/observability/OtelExporter';

describe('OtelExporter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('exports traces and metrics and supports flush/shutdown', async () => {
    const exporter = new OtelExporter({
      otlpEndpoint: 'grpc://localhost:4317',
      serviceName: 'test-service',
      metricExportIntervalMs: 1000,
    });

    exporter.exportTrace({
      orgId: 'org-1',
      traceName: 'route',
      durationMs: 25,
      status: 'ok',
      attributes: { route: '/health' },
    });
    exporter.exportMetric({
      orgId: 'org-1',
      metricName: 'latency_ms',
      value: 25,
    });

    expect(mockStartSpan).toHaveBeenCalledTimes(1);
    expect(mockSetStatus).toHaveBeenCalledTimes(1);
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
    expect(mockHistogramRecord).toHaveBeenCalledWith(25, expect.objectContaining({ orgId: 'org-1' }));

    await exporter.forceFlush();
    await exporter.shutdown();

    expect(mockTracerProviderForceFlush).toHaveBeenCalledTimes(1);
    expect(mockMeterForceFlush).toHaveBeenCalledTimes(1);
    expect(mockTracerProviderShutdown).toHaveBeenCalledTimes(1);
    expect(mockMeterShutdown).toHaveBeenCalledTimes(1);
  });
});
