/**
 * tests/cli-adapter.test.ts
 * Unit tests for src/adapters/cli/index.ts
 */

jest.mock('../src/observability/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('../src/security/audit', () => ({
  auditLog: { record: jest.fn() },
}));

import { z } from 'zod';
import { CliAdapter } from '../src/adapters/cli/index';

const ECHO_TOOL = {
  id: 'echo-tool',
  command: 'echo',
  args: ['hello'],
  description: 'Echo hello',
  inputSchema: z.object({}),
};

const TEMPLATE_TOOL = {
  id: 'template-tool',
  command: 'echo',
  args: ['{{message}}'],
  description: 'Echo a message',
  inputSchema: z.object({ message: z.string() }),
};

describe('CliAdapter', () => {
  let adapter: CliAdapter;

  beforeEach(() => {
    adapter = new CliAdapter();
    adapter.register(ECHO_TOOL);
  });

  it('initializes without error', async () => {
    await expect(adapter.initialize()).resolves.not.toThrow();
  });

  it('executes a safe command and captures stdout', async () => {
    const result = await adapter.execute('echo-tool', {});
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('throws for an unknown tool ID', async () => {
    await expect(adapter.execute('nonexistent-tool', {})).rejects.toThrow(
      "CLI tool 'nonexistent-tool' not found",
    );
  });

  it('throws for invalid input params (schema validation)', async () => {
    adapter.register(TEMPLATE_TOOL);
    // message is required but not provided
    await expect(adapter.execute('template-tool', {})).rejects.toThrow(
      "Invalid input for CLI tool 'template-tool'",
    );
  });

  it('rejects shell metacharacters in resolved args', async () => {
    adapter.register(TEMPLATE_TOOL);
    await expect(
      adapter.execute('template-tool', { message: 'hello; rm -rf /' }),
    ).rejects.toThrow('Security: shell metacharacter');
  });

  it('rejects pipe metacharacter in resolved args', async () => {
    adapter.register(TEMPLATE_TOOL);
    await expect(
      adapter.execute('template-tool', { message: 'a | cat /etc/passwd' }),
    ).rejects.toThrow('Security: shell metacharacter');
  });

  it('enforces timeout and marks result as timedOut', async () => {
    adapter.register({
      id: 'slow-tool',
      command: 'sleep',
      args: ['10'],
      description: 'Always slow',
      inputSchema: z.object({}),
      timeoutMs: 200,
    });
    const result = await adapter.execute('slow-tool', {});
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  }, 10_000);

  it('reports non-zero exit code without throwing', async () => {
    adapter.register({
      id: 'failing-tool',
      command: 'sh',
      args: ['-c', 'exit 42'],
      description: 'Always fails',
      inputSchema: z.object({}),
    });
    const result = await adapter.execute('failing-tool', {});
    expect(result.exitCode).toBe(42);
    expect(result.timedOut).toBe(false);
  });

  it('captures stderr separately from stdout', async () => {
    adapter.register({
      id: 'stderr-tool',
      command: 'sh',
      args: ['-c', 'echo error >&2'],
      description: 'Writes to stderr',
      inputSchema: z.object({}),
    });
    const result = await adapter.execute('stderr-tool', {});
    expect(result.stderr.trim()).toBe('error');
    expect(result.stdout).toBe('');
  });

  it('deregisters a tool by ID', () => {
    expect(adapter.deregister('echo-tool')).toBe(true);
    expect(adapter.deregister('echo-tool')).toBe(false); // Already removed
  });

  it('lists all registered tools', () => {
    adapter.register(TEMPLATE_TOOL);
    const tools = adapter.getRegisteredTools();
    expect(tools.length).toBe(2);
    expect(tools.map((t) => t.id)).toContain('echo-tool');
  });
});
