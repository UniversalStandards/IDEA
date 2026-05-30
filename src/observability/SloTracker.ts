type IndicatorType = 'error_rate' | 'p99_latency_ms';

interface ParsedIndicator {
  type: IndicatorType;
  threshold: number;
}

export interface SloDefinition {
  name: string;
  target: number;
  window: string;
  indicator: string;
}

export interface SloSample {
  timestamp?: Date;
  errorRate?: number;
  p99LatencyMs?: number;
  totalEvents?: number;
  goodEvents?: number;
}

export interface SloStatus {
  orgId: string;
  sloName: string;
  target: number;
  windowMs: number;
  successRate: number;
  errorBudgetRemaining: number;
  burnRate: number;
  totalEvents: number;
  goodEvents: number;
  updatedAt: string;
}

export interface SloWindowRecord extends SloStatus {
  table: 'slo_windows';
  windowStart: string;
  windowEnd: string;
}

export interface SloStore {
  upsert(record: SloWindowRecord): Promise<void>;
  get(orgId: string, sloName: string): Promise<SloWindowRecord | undefined>;
}

class InMemorySloStore implements SloStore {
  private readonly records = new Map<string, SloWindowRecord>();

  async upsert(record: SloWindowRecord): Promise<void> {
    this.records.set(`${record.orgId}:${record.sloName}`, record);
  }

  async get(orgId: string, sloName: string): Promise<SloWindowRecord | undefined> {
    return this.records.get(`${orgId}:${sloName}`);
  }
}

interface RollingPoint {
  ts: number;
  total: number;
  good: number;
}

export class SloTracker {
  private readonly definitionsByOrg = new Map<string, Map<string, SloDefinition>>();
  private readonly pointsBySlo = new Map<string, RollingPoint[]>();

  constructor(private readonly store: SloStore = new InMemorySloStore()) {}

  defineFromYaml(orgId: string, yamlContent: string): SloDefinition[] {
    const definitions = this.parseYamlDefinitions(yamlContent);
    const map = new Map<string, SloDefinition>();
    for (const definition of definitions) {
      this.parseIndicator(definition.indicator);
      map.set(definition.name, definition);
    }
    this.definitionsByOrg.set(orgId, map);
    return definitions;
  }

  async record(orgId: string, sloName: string, sample: SloSample): Promise<SloStatus> {
    const definition = this.definitionsByOrg.get(orgId)?.get(sloName);
    if (!definition) {
      throw new Error(`SLO is not defined for org ${orgId}: ${sloName}`);
    }

    const indicator = this.parseIndicator(definition.indicator);
    const ts = (sample.timestamp ?? new Date()).getTime();
    const windowMs = this.parseWindow(definition.window);
    const key = `${orgId}:${sloName}`;
    const points = this.pointsBySlo.get(key) ?? [];
    const point = this.toRollingPoint(indicator, sample, ts);
    points.push(point);

    const cutoff = ts - windowMs;
    const activePoints = points.filter((p) => p.ts >= cutoff);
    this.pointsBySlo.set(key, activePoints);

    const totals = activePoints.reduce(
      (acc, cur) => ({ total: acc.total + cur.total, good: acc.good + cur.good }),
      { total: 0, good: 0 },
    );

    const successRate = totals.total === 0 ? 1 : totals.good / totals.total;
    const targetErrorBudget = 1 - definition.target;
    const consumedBudget = Math.max(0, 1 - successRate);
    const errorBudgetRemaining = targetErrorBudget <= 0 ? Number(successRate >= definition.target) : Math.max(
      0,
      (targetErrorBudget - consumedBudget) / targetErrorBudget,
    );
    const burnRate = targetErrorBudget <= 0 ? 0 : consumedBudget / targetErrorBudget;

    const nowIso = new Date(ts).toISOString();
    const status: SloStatus = {
      orgId,
      sloName,
      target: definition.target,
      windowMs,
      successRate,
      errorBudgetRemaining,
      burnRate,
      totalEvents: totals.total,
      goodEvents: totals.good,
      updatedAt: nowIso,
    };

    await this.store.upsert({
      ...status,
      table: 'slo_windows',
      windowStart: new Date(cutoff).toISOString(),
      windowEnd: nowIso,
    });

    return status;
  }

  async getStatus(orgId: string, sloName: string): Promise<SloWindowRecord | undefined> {
    return this.store.get(orgId, sloName);
  }

  private parseYamlDefinitions(yamlContent: string): SloDefinition[] {
    const lines = yamlContent
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#') && line !== 'slos:');

    const definitions: SloDefinition[] = [];
    let current: Partial<SloDefinition> | undefined;

    for (const line of lines) {
      if (line.startsWith('- ')) {
        if (current) {
          definitions.push(this.validateDefinition(current));
        }
        current = {};
        const rest = line.slice(2);
        const [key, value] = this.parseKeyValue(rest);
        this.assignDefinitionField(current, key, value);
        continue;
      }

      if (!current) continue;
      const [key, value] = this.parseKeyValue(line);
      this.assignDefinitionField(current, key, value);
    }

    if (current) {
      definitions.push(this.validateDefinition(current));
    }

    return definitions;
  }

  private parseKeyValue(input: string): [keyof SloDefinition, string | number] {
    const sep = input.indexOf(':');
    if (sep <= 0) {
      throw new Error(`Invalid YAML key/value line: ${input}`);
    }
    const key = input.slice(0, sep).trim();
    const rawValue = input.slice(sep + 1).trim();
    if (key === 'target') return [key, Number(rawValue)];
    if (key === 'name' || key === 'window' || key === 'indicator') return [key, rawValue];
    throw new Error(`Unsupported SLO key: ${key}`);
  }

  private assignDefinitionField(
    definition: Partial<SloDefinition>,
    key: keyof SloDefinition,
    value: string | number,
  ): void {
    if (key === 'target') {
      definition.target = typeof value === 'number' ? value : Number(value);
      return;
    }
    definition[key] = String(value);
  }

  private validateDefinition(definition: Partial<SloDefinition>): SloDefinition {
    if (!definition.name || definition.target === undefined || !definition.window || !definition.indicator) {
      throw new Error(`Invalid SLO definition: ${JSON.stringify(definition)}`);
    }
    return {
      name: definition.name,
      target: definition.target,
      window: definition.window,
      indicator: definition.indicator,
    };
  }

  private parseIndicator(indicator: string): ParsedIndicator {
    const match = indicator.match(/^([a-z0-9_]+)\s*<\s*([0-9.]+)$/u);
    if (!match) {
      throw new Error(`Unsupported SLO indicator: ${indicator}`);
    }
    const typeValue = match[1];
    const thresholdValue = match[2];
    if (typeValue === undefined || thresholdValue === undefined) {
      throw new Error(`Unsupported SLO indicator: ${indicator}`);
    }
    const type = typeValue as IndicatorType;
    const threshold = Number(thresholdValue);
    if (type !== 'error_rate' && type !== 'p99_latency_ms') {
      throw new Error(`Unsupported SLO indicator type: ${type}`);
    }
    return { type, threshold };
  }

  private parseWindow(windowText: string): number {
    const match = windowText.match(/^(\d+)([smhd])$/u);
    if (!match) {
      throw new Error(`Unsupported SLO window format: ${windowText}`);
    }
    const amountValue = match[1];
    const unit = match[2];
    if (amountValue === undefined || unit === undefined) {
      throw new Error(`Unsupported SLO window format: ${windowText}`);
    }
    const amount = Number(amountValue);
    const unitMs: Record<string, number> = {
      s: 1_000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
    };
    return amount * (unitMs[unit] ?? 0);
  }

  private toRollingPoint(indicator: ParsedIndicator, sample: SloSample, ts: number): RollingPoint {
    const total = Math.max(1, sample.totalEvents ?? 1);

    if (sample.goodEvents !== undefined) {
      return {
        ts,
        total,
        good: Math.max(0, Math.min(total, sample.goodEvents)),
      };
    }

    if (indicator.type === 'error_rate') {
      if (sample.errorRate === undefined) {
        throw new Error('errorRate is required for error_rate indicators');
      }
      const good = sample.errorRate < indicator.threshold ? total : 0;
      return { ts, total, good };
    }

    if (sample.p99LatencyMs === undefined) {
      throw new Error('p99LatencyMs is required for p99_latency_ms indicators');
    }
    const good = sample.p99LatencyMs < indicator.threshold ? total : 0;
    return { ts, total, good };
  }
}

export const sloTracker = new SloTracker();
