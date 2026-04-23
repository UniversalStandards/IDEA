export interface Capability {
  id: string;
  name: string;
  version: string;
  status: 'active' | 'disabled' | 'error';
  description: string;
  source?: string;
}

export interface Workflow {
  id: string;
  name: string;
  status: 'active' | 'paused' | 'failed';
  steps: number;
  lastRun: string;
  duration: string;
}

export interface Policy {
  id: string;
  name: string;
  type: string;
  action: 'allow' | 'deny';
  priority: number;
  active: boolean;
}

export interface Provider {
  id: string;
  name: string;
  type: string;
  models: number;
  health: 'healthy' | 'degraded' | 'down';
  circuitBreaker: 'closed' | 'open' | 'half-open';
  costToday: number;
}

export interface User {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'operator' | 'viewer';
  lastLogin: string;
  status: 'active' | 'suspended';
}

export interface ApiKey {
  id: string;
  name: string;
  key: string;
  created: string;
  lastUsed: string;
}

export interface AuditEntry {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  resource: string;
  status: 'success' | 'failure' | 'warning';
  details: string;
}

export interface CostEntry {
  provider: string;
  model: string;
  costUsd: number;
  requests: number;
}

export interface HealthStatus {
  status: 'ok' | 'degraded' | 'error';
  uptime?: number;
  version?: string;
  environment?: string;
  nodeVersion?: string;
}

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
}
