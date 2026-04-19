/**
 * src/types/errors.ts
 * Domain-specific error classes for the Universal MCP Orchestration Hub.
 * All custom errors extend McpHubError so callers can distinguish hub errors
 * from unexpected third-party exceptions.
 */

// ─────────────────────────────────────────────────────────────────
// Base
// ─────────────────────────────────────────────────────────────────

/**
 * Base class for all hub-specific errors.
 * Carries an optional `code` field for machine-readable classification
 * and an optional `context` bag for structured diagnostics.
 */
export class McpHubError extends Error {
  readonly code: string;
  readonly context: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.context = context;
    // Preserve correct V8 stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────

/** Thrown when environment configuration fails Zod validation. */
export class ConfigurationError extends McpHubError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, 'ERR_CONFIGURATION', context);
  }
}

// ─────────────────────────────────────────────────────────────────
// Authentication & Authorization
// ─────────────────────────────────────────────────────────────────

/** Thrown when a request lacks valid credentials. */
export class AuthenticationError extends McpHubError {
  constructor(message = 'Authentication required', context: Record<string, unknown> = {}) {
    super(message, 'ERR_AUTHENTICATION', context);
  }
}

/** Thrown when an authenticated principal is not permitted to perform an action. */
export class AuthorizationError extends McpHubError {
  constructor(message = 'Permission denied', context: Record<string, unknown> = {}) {
    super(message, 'ERR_AUTHORIZATION', context);
  }
}

// ─────────────────────────────────────────────────────────────────
// Policy
// ─────────────────────────────────────────────────────────────────

/** Thrown when a policy engine evaluation explicitly denies an action. */
export class PolicyDeniedError extends McpHubError {
  readonly reasons: string[];

  constructor(reasons: string[], context: Record<string, unknown> = {}) {
    super(`Action denied by policy: ${reasons.join('; ')}`, 'ERR_POLICY_DENIED', context);
    this.reasons = reasons;
  }
}

/** Thrown when a required approval is not yet granted or has been rejected. */
export class ApprovalRequiredError extends McpHubError {
  readonly approvalId: string;

  constructor(approvalId: string, context: Record<string, unknown> = {}) {
    super(`Approval required: ${approvalId}`, 'ERR_APPROVAL_REQUIRED', {
      approvalId,
      ...context,
    });
    this.approvalId = approvalId;
  }
}

// ─────────────────────────────────────────────────────────────────
// Tool / Capability
// ─────────────────────────────────────────────────────────────────

/** Thrown when a requested tool or capability cannot be found. */
export class CapabilityNotFoundError extends McpHubError {
  readonly capabilityId: string;

  constructor(capabilityId: string, context: Record<string, unknown> = {}) {
    super(`Capability '${capabilityId}' not found`, 'ERR_CAPABILITY_NOT_FOUND', {
      capabilityId,
      ...context,
    });
    this.capabilityId = capabilityId;
  }
}

/** Thrown when tool installation fails. */
export class InstallationError extends McpHubError {
  readonly toolId: string;

  constructor(toolId: string, message: string, context: Record<string, unknown> = {}) {
    super(`Installation failed for '${toolId}': ${message}`, 'ERR_INSTALLATION', {
      toolId,
      ...context,
    });
    this.toolId = toolId;
  }
}

/** Thrown when a package checksum does not match the expected value. */
export class ChecksumMismatchError extends McpHubError {
  constructor(expected: string, actual: string, context: Record<string, unknown> = {}) {
    super(
      `Checksum mismatch — expected ${expected}, got ${actual}`,
      'ERR_CHECKSUM_MISMATCH',
      { expected, actual, ...context },
    );
  }
}

// ─────────────────────────────────────────────────────────────────
// Routing / Provider
// ─────────────────────────────────────────────────────────────────

/** Thrown when no provider can be selected for a given request. */
export class NoProviderAvailableError extends McpHubError {
  constructor(reason: string, context: Record<string, unknown> = {}) {
    super(`No provider available: ${reason}`, 'ERR_NO_PROVIDER', context);
  }
}

/** Thrown when a provider circuit breaker is open. */
export class CircuitBreakerOpenError extends McpHubError {
  readonly providerId: string;

  constructor(providerId: string, context: Record<string, unknown> = {}) {
    super(
      `Circuit breaker is OPEN for provider '${providerId}'`,
      'ERR_CIRCUIT_BREAKER_OPEN',
      { providerId, ...context },
    );
    this.providerId = providerId;
  }
}

// ─────────────────────────────────────────────────────────────────
// Orchestration / Workflow
// ─────────────────────────────────────────────────────────────────

/** Thrown when a workflow step fails after all retries are exhausted. */
export class WorkflowStepError extends McpHubError {
  readonly stepId: string;
  readonly workflowId: string;

  constructor(workflowId: string, stepId: string, cause: Error, context: Record<string, unknown> = {}) {
    super(
      `Workflow '${workflowId}' step '${stepId}' failed: ${cause.message}`,
      'ERR_WORKFLOW_STEP',
      { workflowId, stepId, cause: cause.message, ...context },
    );
    this.stepId = stepId;
    this.workflowId = workflowId;
  }
}

/** Thrown when a workflow cannot be found by ID. */
export class WorkflowNotFoundError extends McpHubError {
  readonly workflowId: string;

  constructor(workflowId: string) {
    super(`Workflow '${workflowId}' not found`, 'ERR_WORKFLOW_NOT_FOUND', { workflowId });
    this.workflowId = workflowId;
  }
}

/** Thrown when a workflow cancellation is requested but the workflow is not running. */
export class WorkflowNotRunningError extends McpHubError {
  readonly workflowId: string;

  constructor(workflowId: string) {
    super(
      `Workflow '${workflowId}' is not in a cancellable state`,
      'ERR_WORKFLOW_NOT_RUNNING',
      { workflowId },
    );
    this.workflowId = workflowId;
  }
}

// ─────────────────────────────────────────────────────────────────
// Normalization
// ─────────────────────────────────────────────────────────────────

/** Thrown when an incoming request cannot be normalized to the internal format. */
export class NormalizationError extends McpHubError {
  constructor(protocol: string, reason: string, context: Record<string, unknown> = {}) {
    super(
      `Failed to normalize ${protocol} request: ${reason}`,
      'ERR_NORMALIZATION',
      { protocol, ...context },
    );
  }
}

// ─────────────────────────────────────────────────────────────────
// Adapter
// ─────────────────────────────────────────────────────────────────

/** Thrown when an adapter operation (CLI spawn, GraphQL, webhook) fails. */
export class AdapterError extends McpHubError {
  readonly adapterType: string;

  constructor(adapterType: string, message: string, context: Record<string, unknown> = {}) {
    super(`Adapter '${adapterType}' error: ${message}`, 'ERR_ADAPTER', {
      adapterType,
      ...context,
    });
    this.adapterType = adapterType;
  }
}

/** Thrown when an adapter command times out. */
export class AdapterTimeoutError extends McpHubError {
  constructor(adapterType: string, timeoutMs: number, context: Record<string, unknown> = {}) {
    super(
      `Adapter '${adapterType}' timed out after ${timeoutMs}ms`,
      'ERR_ADAPTER_TIMEOUT',
      { adapterType, timeoutMs, ...context },
    );
  }
}

// ─────────────────────────────────────────────────────────────────
// Security
// ─────────────────────────────────────────────────────────────────

/** Thrown when a trust score is too low for the requested action. */
export class InsufficientTrustError extends McpHubError {
  readonly trustScore: number;
  readonly requiredScore: number;

  constructor(
    toolId: string,
    trustScore: number,
    requiredScore: number,
    context: Record<string, unknown> = {},
  ) {
    super(
      `Tool '${toolId}' trust score ${trustScore} is below required ${requiredScore}`,
      'ERR_INSUFFICIENT_TRUST',
      { toolId, trustScore, requiredScore, ...context },
    );
    this.trustScore = trustScore;
    this.requiredScore = requiredScore;
  }
}

/** Thrown when input fails a security validation (e.g. path traversal attempt). */
export class SecurityValidationError extends McpHubError {
  constructor(reason: string, context: Record<string, unknown> = {}) {
    super(`Security validation failed: ${reason}`, 'ERR_SECURITY_VALIDATION', context);
  }
}
