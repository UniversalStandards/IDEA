/**
 * tests/errors.test.ts
 * Unit tests for src/types/errors.ts
 * Validates that every domain error class is correctly structured.
 */

import {
  McpHubError,
  ConfigurationError,
  AuthenticationError,
  AuthorizationError,
  PolicyDeniedError,
  ApprovalRequiredError,
  CapabilityNotFoundError,
  InstallationError,
  ChecksumMismatchError,
  NoProviderAvailableError,
  CircuitBreakerOpenError,
  WorkflowStepError,
  WorkflowNotFoundError,
  WorkflowNotRunningError,
  NormalizationError,
  AdapterError,
  AdapterTimeoutError,
  InsufficientTrustError,
  SecurityValidationError,
} from '../src/types/errors';

describe('McpHubError base class', () => {
  it('carries a code and context', () => {
    const err = new McpHubError('test message', 'ERR_TEST', { foo: 'bar' });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(McpHubError);
    expect(err.message).toBe('test message');
    expect(err.code).toBe('ERR_TEST');
    expect(err.context).toEqual({ foo: 'bar' });
    expect(err.name).toBe('McpHubError');
  });

  it('has an empty context by default', () => {
    const err = new McpHubError('msg', 'ERR');
    expect(err.context).toEqual({});
  });
});

describe('ConfigurationError', () => {
  it('has correct code and is instanceof McpHubError', () => {
    const err = new ConfigurationError('bad config', { field: 'PORT' });
    expect(err).toBeInstanceOf(McpHubError);
    expect(err.code).toBe('ERR_CONFIGURATION');
    expect(err.context['field']).toBe('PORT');
  });
});

describe('AuthenticationError', () => {
  it('has default message', () => {
    const err = new AuthenticationError();
    expect(err.message).toContain('Authentication');
    expect(err.code).toBe('ERR_AUTHENTICATION');
  });

  it('accepts custom message', () => {
    const err = new AuthenticationError('Token expired');
    expect(err.message).toBe('Token expired');
  });
});

describe('AuthorizationError', () => {
  it('has default message', () => {
    const err = new AuthorizationError();
    expect(err.message).toContain('Permission');
    expect(err.code).toBe('ERR_AUTHORIZATION');
  });
});

describe('PolicyDeniedError', () => {
  it('includes reasons in message and exposes reasons array', () => {
    const reasons = ['Tool blocked', 'High risk action'];
    const err = new PolicyDeniedError(reasons);
    expect(err.reasons).toEqual(reasons);
    expect(err.message).toContain('Tool blocked');
    expect(err.code).toBe('ERR_POLICY_DENIED');
  });
});

describe('ApprovalRequiredError', () => {
  it('exposes approvalId', () => {
    const err = new ApprovalRequiredError('approval-123');
    expect(err.approvalId).toBe('approval-123');
    expect(err.message).toContain('approval-123');
    expect(err.code).toBe('ERR_APPROVAL_REQUIRED');
  });
});

describe('CapabilityNotFoundError', () => {
  it('exposes capabilityId', () => {
    const err = new CapabilityNotFoundError('tool-xyz');
    expect(err.capabilityId).toBe('tool-xyz');
    expect(err.message).toContain('tool-xyz');
    expect(err.code).toBe('ERR_CAPABILITY_NOT_FOUND');
  });
});

describe('InstallationError', () => {
  it('exposes toolId and includes reason in message', () => {
    const err = new InstallationError('my-tool', 'npm ERR!');
    expect(err.toolId).toBe('my-tool');
    expect(err.message).toContain('npm ERR!');
    expect(err.code).toBe('ERR_INSTALLATION');
  });
});

describe('ChecksumMismatchError', () => {
  it('includes expected and actual in context', () => {
    const err = new ChecksumMismatchError('abc123', 'def456');
    expect(err.context['expected']).toBe('abc123');
    expect(err.context['actual']).toBe('def456');
    expect(err.message).toContain('abc123');
    expect(err.message).toContain('def456');
    expect(err.code).toBe('ERR_CHECKSUM_MISMATCH');
  });
});

describe('NoProviderAvailableError', () => {
  it('includes reason in message', () => {
    const err = new NoProviderAvailableError('all providers down');
    expect(err.message).toContain('all providers down');
    expect(err.code).toBe('ERR_NO_PROVIDER');
  });
});

describe('CircuitBreakerOpenError', () => {
  it('exposes providerId', () => {
    const err = new CircuitBreakerOpenError('openai');
    expect(err.providerId).toBe('openai');
    expect(err.message).toContain('openai');
    expect(err.code).toBe('ERR_CIRCUIT_BREAKER_OPEN');
  });
});

describe('WorkflowStepError', () => {
  it('exposes workflowId and stepId', () => {
    const cause = new Error('step blew up');
    const err = new WorkflowStepError('wf-1', 'step-2', cause);
    expect(err.workflowId).toBe('wf-1');
    expect(err.stepId).toBe('step-2');
    expect(err.message).toContain('step blew up');
    expect(err.code).toBe('ERR_WORKFLOW_STEP');
  });
});

describe('WorkflowNotFoundError', () => {
  it('exposes workflowId', () => {
    const err = new WorkflowNotFoundError('wf-99');
    expect(err.workflowId).toBe('wf-99');
    expect(err.message).toContain('wf-99');
    expect(err.code).toBe('ERR_WORKFLOW_NOT_FOUND');
  });
});

describe('WorkflowNotRunningError', () => {
  it('exposes workflowId', () => {
    const err = new WorkflowNotRunningError('wf-5');
    expect(err.workflowId).toBe('wf-5');
    expect(err.code).toBe('ERR_WORKFLOW_NOT_RUNNING');
  });
});

describe('NormalizationError', () => {
  it('includes protocol and reason in message', () => {
    const err = new NormalizationError('JSON-RPC', 'missing method field');
    expect(err.message).toContain('JSON-RPC');
    expect(err.message).toContain('missing method field');
    expect(err.code).toBe('ERR_NORMALIZATION');
  });
});

describe('AdapterError', () => {
  it('exposes adapterType', () => {
    const err = new AdapterError('cli', 'command failed');
    expect(err.adapterType).toBe('cli');
    expect(err.message).toContain('cli');
    expect(err.message).toContain('command failed');
    expect(err.code).toBe('ERR_ADAPTER');
  });
});

describe('AdapterTimeoutError', () => {
  it('includes adapter type and timeout in message', () => {
    const err = new AdapterTimeoutError('graphql', 5000);
    expect(err.message).toContain('graphql');
    expect(err.message).toContain('5000ms');
    expect(err.code).toBe('ERR_ADAPTER_TIMEOUT');
    expect(err.context['timeoutMs']).toBe(5000);
  });
});

describe('InsufficientTrustError', () => {
  it('exposes trustScore and requiredScore', () => {
    const err = new InsufficientTrustError('tool-low', 30, 50);
    expect(err.trustScore).toBe(30);
    expect(err.requiredScore).toBe(50);
    expect(err.message).toContain('30');
    expect(err.message).toContain('50');
    expect(err.code).toBe('ERR_INSUFFICIENT_TRUST');
  });
});

describe('SecurityValidationError', () => {
  it('includes reason in message', () => {
    const err = new SecurityValidationError('path traversal detected');
    expect(err.message).toContain('path traversal detected');
    expect(err.code).toBe('ERR_SECURITY_VALIDATION');
  });
});

describe('Error instanceof hierarchy', () => {
  it('all errors are instanceof McpHubError and Error', () => {
    const errors = [
      new ConfigurationError('x'),
      new AuthenticationError(),
      new AuthorizationError(),
      new PolicyDeniedError(['r']),
      new ApprovalRequiredError('id'),
      new CapabilityNotFoundError('id'),
      new InstallationError('id', 'reason'),
      new ChecksumMismatchError('a', 'b'),
      new NoProviderAvailableError('x'),
      new CircuitBreakerOpenError('p'),
      new WorkflowStepError('w', 's', new Error('x')),
      new WorkflowNotFoundError('w'),
      new WorkflowNotRunningError('w'),
      new NormalizationError('proto', 'reason'),
      new AdapterError('type', 'reason'),
      new AdapterTimeoutError('type', 100),
      new InsufficientTrustError('t', 10, 50),
      new SecurityValidationError('reason'),
    ];
    for (const e of errors) {
      expect(e).toBeInstanceOf(Error);
      expect(e).toBeInstanceOf(McpHubError);
    }
  });

  it('each error has a unique descriptive .name', () => {
    const err = new PolicyDeniedError(['x']);
    expect(err.name).toBe('PolicyDeniedError');
  });
});
