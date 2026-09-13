/**
 * Evolution Engine — Self-Improving Capability Pipeline
 *
 * Consolidated from:
 *   - Universal-Standard-MCP-Server (src/evolution/) — auto-evolution engine
 *   - "MCP Hive Nexus" design (chat-only, never repo'd) — 9-stage agent pipeline
 *
 * Governs how IDEA acquires, builds, and improves capabilities it does not
 * yet have, instead of failing a request outright. Wired into discovery/,
 * provisioning/, and adapters/ rather than living as a separate app.
 */

export type EvolutionStage =
  | 'intake'           // normalize the incoming capability request
  | 'internal_search'  // check the local capability registry first
  | 'respond'          // capability found — serve immediately
  | 'notify'           // capability missing — ack + kick off build, non-blocking
  | 'external_search'  // search GitHub/NPM/OpenAPI/MCP registries
  | 'design'           // architect the integration (schema, auth, rate limits)
  | 'build'            // generate the adapter (OpenAPI module or native code)
  | 'test'             // validate against a sandboxed call
  | 'deploy';          // register into the live capability registry

export interface EvolutionRequest {
  id: string;
  rawInput: string;
  normalizedIntent?: CapabilityIntent;
  stage: EvolutionStage;
  createdAt: string;
  updatedAt: string;
}

export interface CapabilityIntent {
  action: string;
  service?: string;
  parameters?: Record<string, unknown>;
  confidence: number; // 0-1, from the normalization model
}

export interface EvolutionResult {
  requestId: string;
  outcome: 'served_existing' | 'built_new' | 'failed';
  capabilityId?: string;
  durationMs: number;
  errors?: string[];
}

/** One stage handler in the pipeline. Each stage is independently retryable. */
export interface EvolutionAgent<In = unknown, Out = unknown> {
  stage: EvolutionStage;
  run(input: In, ctx: EvolutionContext): Promise<Out>;
}

export interface EvolutionContext {
  requestId: string;
  registry: CapabilityRegistryPort;
  emit(event: EvolutionEvent): void;
}

export type EvolutionEvent =
  | { type: 'stage_started'; stage: EvolutionStage; requestId: string }
  | { type: 'stage_completed'; stage: EvolutionStage; requestId: string; ms: number }
  | { type: 'capability_served'; requestId: string; capabilityId: string }
  | { type: 'capability_building'; requestId: string; estimateMs?: number }
  | { type: 'capability_deployed'; requestId: string; capabilityId: string }
  | { type: 'stage_failed'; stage: EvolutionStage; requestId: string; error: string };

/** Minimal port the evolution engine needs from discovery/ and provisioning/. */
export interface CapabilityRegistryPort {
  find(intent: CapabilityIntent): Promise<string | null>;
  register(capabilityId: string, manifest: unknown): Promise<void>;
}
