/**
 * src/types/index.ts
 * Shared TypeScript type definitions for the Universal MCP Orchestration Hub.
 * All modules should import shared types from here rather than defining duplicates.
 */

import type { ZodSchema } from 'zod';

// ─────────────────────────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────────────────────────

export enum TransportType {
  HTTP = 'http',
  STDIO = 'stdio',
  SSE = 'sse',
}

export enum RiskLevel {
  NONE = 'none',
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

export enum ApprovalStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  TIMED_OUT = 'timed_out',
  AUTO_APPROVED = 'auto_approved',
}

export enum ProviderType {
  OPENAI = 'openai',
  ANTHROPIC = 'anthropic',
  GOOGLE = 'google',
  AZURE = 'azure',
  LOCAL = 'local',
  HUGGINGFACE = 'huggingface',
  OLLAMA = 'ollama',
  CUSTOM = 'custom',
}

export enum RegistrySource {
  GITHUB = 'github',
  OFFICIAL_MCP = 'official-mcp',
  ENTERPRISE = 'enterprise',
  LOCAL = 'local',
  CUSTOM = 'custom',
}

export enum WorkflowStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  WAITING_APPROVAL = 'waiting_approval',
}

export enum CircuitBreakerState {
  CLOSED = 'closed',   // Normal operation
  OPEN = 'open',       // Failing; skip this provider
  HALF_OPEN = 'half_open', // Testing recovery
}

// ─────────────────────────────────────────────────────────────────
// Normalized Request / Response
// ─────────────────────────────────────────────────────────────────

export interface NormalizedRequest {
  readonly id: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly protocol: string;
  readonly version: string;
  readonly requestedAt: Date;
  readonly requestId: string;
  readonly correlationId?: string;
  readonly metadata: Record<string, unknown>;
}

export interface NormalizedResult {
  readonly requestId: string;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: NormalizedError;
  readonly durationMs: number;
  readonly respondedAt: Date;
  readonly metadata: Record<string, unknown>;
}

export interface NormalizedError {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
  readonly retryable: boolean;
}

// ─────────────────────────────────────────────────────────────────
// Capability
// ─────────────────────────────────────────────────────────────────

export interface CapabilityDescriptor {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly sources: RegistrySource[];
  readonly tags: string[];
  readonly trustScore: number;       // 0–1
  readonly riskLevel: RiskLevel;
  readonly providerType?: ProviderType;
  readonly installPath?: string;
  readonly configSchema?: Record<string, unknown>;
  readonly dependencies: string[];
  readonly registeredAt: Date;
  readonly lastVerifiedAt: Date;
}

// ─────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────

export interface ProviderConfig {
  readonly type: ProviderType;
  readonly name: string;
  readonly baseUrl?: string;
  readonly apiKeyEnvVar?: string;
  readonly defaultModel?: string;
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
  readonly priority: number;         // Lower = higher priority
  readonly enabled: boolean;
}

// ─────────────────────────────────────────────────────────────────
// Policy
// ─────────────────────────────────────────────────────────────────

export interface PolicyContext {
  readonly toolId: string;
  readonly toolName: string;
  readonly action: string;
  readonly actor?: string;
  readonly environment: string;
  readonly riskLevel: RiskLevel;
  readonly trustScore: number;
  readonly metadata: Record<string, unknown>;
}

export interface PolicyDecision {
  readonly allowed: boolean;
  readonly requiresApproval: boolean;
  readonly reason: string;
  readonly matchedRules: string[];
  readonly decidedAt: Date;
}

export interface TrustScore {
  readonly overall: number;          // 0–1
  readonly breakdown: {
    readonly provenance: number;
    readonly signature: number;
    readonly age: number;
    readonly downloads: number;
    readonly policy: number;
  };
  readonly evaluatedAt: Date;
}

// ─────────────────────────────────────────────────────────────────
// Audit
// ─────────────────────────────────────────────────────────────────

export interface AuditEntry {
  readonly id: string;
  readonly timestamp: Date;
  readonly action: string;
  readonly actor: string;
  readonly resource: string;
  readonly outcome: 'success' | 'failure' | 'pending';
  readonly correlationId: string;
  readonly requestId?: string;
  readonly metadata: Record<string, unknown>;
  hmac?: string;  // Populated by audit.ts after entry is constructed
}

// ─────────────────────────────────────────────────────────────────
// Health
// ─────────────────────────────────────────────────────────────────

export interface HealthStatus {
  readonly status: 'ok' | 'degraded' | 'unavailable';
  readonly version: string;
  readonly nodeVersion: string;
  readonly environment: string;
  readonly uptimeSeconds: number;
  readonly timestamp: Date;
  readonly checks: Record<string, HealthCheckResult>;
}

export interface HealthCheckResult {
  readonly status: 'ok' | 'degraded' | 'unavailable';
  readonly latencyMs?: number;
  readonly message?: string;
}

// ─────────────────────────────────────────────────────────────────
// Execution Context
// ─────────────────────────────────────────────────────────────────

export interface ExecutionContext {
  readonly requestId: string;
  readonly correlationId: string;
  readonly actor?: string;
  readonly environment: string;
  readonly startedAt: Date;
  readonly timeout?: number;
  readonly metadata: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────
// Cost Monitoring
// ─────────────────────────────────────────────────────────────────

export interface CostEvent {
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly requestId: string;
  readonly timestamp: Date;
}

export interface CostSummary {
  readonly totalCostUsd: number;
  readonly requestCount: number;
  readonly byProvider: Record<string, number>;
  readonly byModel: Record<string, number>;
  readonly windowMs: number;
  readonly from: Date;
  readonly to: Date;
}

// ─────────────────────────────────────────────────────────────────
// Adapter Interface
// ─────────────────────────────────────────────────────────────────

export interface IAdapter {
  readonly name: string;
  readonly protocol: string;
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────
// Protocol Adapter Interface
// ─────────────────────────────────────────────────────────────────

export interface IProtocolAdapter {
  readonly protocol: string;
  normalize(raw: unknown): NormalizedRequest;
  denormalize(result: NormalizedResult): unknown;
}

// ─────────────────────────────────────────────────────────────────
// Registry Connector Interface
// ─────────────────────────────────────────────────────────────────

export interface DiscoveredTool {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly source: RegistrySource;
  readonly packageName?: string;
  readonly repositoryUrl?: string;
  readonly tags: string[];
  readonly trustScore?: number;
  readonly metadata: Record<string, unknown>;
}

export interface IRegistryConnector {
  readonly source: RegistrySource;
  readonly name: string;
  isEnabled(): boolean;
  discover(query?: string): Promise<DiscoveredTool[]>;
}

// ─────────────────────────────────────────────────────────────────
// CLI Adapter
// ─────────────────────────────────────────────────────────────────

export interface CliToolDefinition {
  readonly id: string;
  readonly command: string;
  readonly args: string[];
  readonly description: string;
  readonly inputSchema: ZodSchema<Record<string, unknown>>;
  readonly timeoutMs?: number;         // Default: 30000
  readonly allowedEnvVars?: string[];  // Env vars to pass to the child process
}

export interface CliExecutionResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

// ─────────────────────────────────────────────────────────────────
// Workflow
// ─────────────────────────────────────────────────────────────────

export interface WorkflowStep {
  readonly id: string;
  readonly name: string;
  readonly toolId: string;
  readonly params: Record<string, unknown>;
  readonly dependsOn: string[];
  readonly retryPolicy?: RetryPolicy;
  readonly timeoutMs?: number;
}

export interface RetryPolicy {
  readonly maxRetries: number;
  readonly initialDelayMs: number;
  readonly backoffMultiplier: number;
  readonly maxDelayMs: number;
}

export interface WorkflowDefinition {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly steps: WorkflowStep[];
  readonly timeout?: number;
}

export interface WorkflowState {
  readonly workflowId: string;
  readonly status: WorkflowStatus;
  readonly currentStepId?: string;
  readonly completedSteps: string[];
  readonly failedSteps: string[];
  readonly results: Record<string, unknown>;
  readonly startedAt: Date;
  readonly updatedAt: Date;
  readonly error?: string;
}
