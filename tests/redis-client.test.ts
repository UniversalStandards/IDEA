/**
 * tests/redis-client.test.ts
 * Unit tests for src/core/redis-client.ts
 *
 * All Redis interaction is mocked so no live Redis instance is required.
 */

import EventEmitter from 'events';

// ── Shared mock state ──────────────────────────────────────────────────────
const mockQuit = jest.fn().mockResolvedValue('OK');
const mockDisconnect = jest.fn();

class MockRedis extends EventEmitter {
  quit = mockQuit;
  disconnect = mockDisconnect;
}

let mockInstance: MockRedis | null = null;

// Mock ioredis before importing the module under test
jest.mock('ioredis', () => {
  return jest.fn().mockImplementation((_url: string, _opts: unknown) => {
    mockInstance = new MockRedis();
    return mockInstance;
  });
});

// ── Module under test ──────────────────────────────────────────────────────
// Import after the mock is set up
import { getRedis, shutdownRedis, _setRedisClient } from '../src/core/redis-client';

describe('redis-client', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    // Reset internal singleton between tests
    _setRedisClient(null);
    mockInstance = null;
    jest.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    _setRedisClient(null);
  });

  describe('getRedis()', () => {
    it('returns null when REDIS_URL is not set', () => {
      delete process.env['REDIS_URL'];
      const client = getRedis();
      expect(client).toBeNull();
    });

    it('creates a Redis client when REDIS_URL is set', () => {
      process.env['REDIS_URL'] = 'redis://localhost:6379';
      const client = getRedis();
      expect(client).not.toBeNull();
      expect(client).toBeInstanceOf(MockRedis);
    });

    it('returns the same singleton instance on repeated calls', () => {
      process.env['REDIS_URL'] = 'redis://localhost:6379';
      const first = getRedis();
      const second = getRedis();
      expect(first).toBe(second);
    });

    it('returns null after client is manually cleared via _setRedisClient(null)', () => {
      process.env['REDIS_URL'] = 'redis://localhost:6379';
      getRedis(); // initialise singleton
      _setRedisClient(null);
      // Without REDIS_URL we get null; with it we get a fresh instance
      delete process.env['REDIS_URL'];
      expect(getRedis()).toBeNull();
    });
  });

  describe('shutdownRedis()', () => {
    it('is a no-op when no client has been created', async () => {
      await expect(shutdownRedis()).resolves.toBeUndefined();
    });

    it('calls quit() and clears the singleton on graceful shutdown', async () => {
      process.env['REDIS_URL'] = 'redis://localhost:6379';
      getRedis(); // create singleton

      await shutdownRedis();

      expect(mockQuit).toHaveBeenCalledTimes(1);
      // After shutdown, getRedis() returns null (REDIS_URL still set but client cleared)
      // The module's _connecting guard is reset so a new client can be made
      const clientAfterShutdown = getRedis();
      // A new client is created after shutdown when REDIS_URL is still configured
      expect(clientAfterShutdown).not.toBeNull();
    });

    it('calls disconnect() if quit() rejects', async () => {
      mockQuit.mockRejectedValueOnce(new Error('connection lost'));
      process.env['REDIS_URL'] = 'redis://localhost:6379';
      getRedis();

      await shutdownRedis();

      expect(mockQuit).toHaveBeenCalledTimes(1);
      expect(mockDisconnect).toHaveBeenCalledTimes(1);
    });
  });

  describe('_setRedisClient() — test helper', () => {
    it('overrides the internal client', () => {
      const fake = new MockRedis() as unknown as import('ioredis').default;
      _setRedisClient(fake);
      expect(getRedis()).toBe(fake);
    });
  });
});
