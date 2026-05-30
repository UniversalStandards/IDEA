import { config } from '../config';

export interface CachedToolResult {
  key: string;
  action: string;
  params: Record<string, unknown>;
  result: unknown;
  durationMs: number;
  createdAt: number;
  expiresAt: number;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b));
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export class ToolCache {
  private readonly ttlMs: number;
  private readonly store = new Map<string, CachedToolResult>();

  constructor(ttlMs = config.CACHE_TTL * 1000) {
    this.ttlMs = ttlMs;
  }

  keyFor(action: string, params: Record<string, unknown>): string {
    return `${action}:${stableStringify(params)}`;
  }

  set(action: string, params: Record<string, unknown>, result: unknown, durationMs: number): CachedToolResult {
    const now = Date.now();
    const key = this.keyFor(action, params);
    const entry: CachedToolResult = {
      key,
      action,
      params: { ...params },
      result,
      durationMs,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.store.set(key, entry);
    return entry;
  }

  get(action: string, params: Record<string, unknown>): CachedToolResult | undefined {
    const key = this.keyFor(action, params);
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  take(action: string, params: Record<string, unknown>): CachedToolResult | undefined {
    const key = this.keyFor(action, params);
    const entry = this.get(action, params);
    if (entry) {
      this.store.delete(key);
    }
    return entry;
  }

  delete(action: string, params: Record<string, unknown>): void {
    this.store.delete(this.keyFor(action, params));
  }

  clear(): void {
    this.store.clear();
  }
}

export const toolCache = new ToolCache();
