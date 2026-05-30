export interface CacheSetOptions {
  ttlMs?: number;
  slidingTtl?: boolean;
  tags?: string[];
}

export interface CacheBackend {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, options?: CacheSetOptions): Promise<void>;
  delete(key: string): Promise<boolean>;
  invalidateByTag(tag: string): Promise<number>;
}
