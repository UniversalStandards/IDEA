jest.mock('../src/observability/logger', () => ({
  createLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { HotReloader } from '../src/provisioning/HotReloader';
import type { IsolationStrategy, SandboxHandle, SandboxSpec } from '../src/provisioning/sandbox/Sandbox';

describe('HotReloader', () => {
  it('starts the new sandbox before draining the old sandbox', async () => {
    const calls: string[] = [];
    const sandbox: IsolationStrategy = {
      kind: 'docker',
      isAvailable: jest.fn(async () => true),
      provision: jest.fn(),
      start: jest.fn(async (handle: SandboxHandle) => {
        calls.push(`start:${handle.id}`);
        return { ...handle, startedAt: new Date() };
      }),
      stop: jest.fn(async (handle: SandboxHandle) => {
        calls.push(`stop:${handle.id}`);
      }),
      remove: jest.fn(async (handle: SandboxHandle) => {
        calls.push(`remove:${handle.id}`);
      }),
      inspect: jest.fn(),
      execute: jest.fn(),
    };

    const registrar = { register: jest.fn() };
    const reloader = new HotReloader(registrar as never);

    const spec: SandboxSpec = {
      toolId: 'tool-1',
      version: '2.0.0',
      capabilityDir: '/tmp/tool-1',
      command: { cmd: 'node', args: ['server.js'] },
    };

    await reloader.reload({
      tool: {
        id: 'tool-1',
        name: 'tool-1',
        version: '2.0.0',
        description: 'tool',
        source: 'official',
        capabilities: [],
        tags: [],
      },
      config: { env: {}, args: [], workingDir: '/tmp/tool-1', timeout: 1000 },
      sandbox,
      nextHandle: { id: 'new', kind: 'docker', spec, metadata: {} },
      previousHandle: { id: 'old', kind: 'docker', spec, metadata: {} },
      drainTimeoutMs: 1,
    });

    expect(calls[0]).toBe('start:new');
    expect(calls).toContain('stop:old');
    expect(registrar.register).toHaveBeenCalled();
  });
});
