/**
 * Marketplace Layer — Tiered / Metered Capability Access
 *
 * Formalizes the "API marketplace" pattern explored during the GitHub
 * adapter work into a general mechanism any adapter in IDEA can opt into.
 * NEW — no prior system reviewed had usage/entitlement tracking.
 */

export type PricingModel = 'free' | 'per_call' | 'subscription' | 'included';

export interface CapabilityListing {
  capabilityId: string;
  tier: 'basic' | 'premium' | 'enterprise';
  pricing: PricingModel;
  rateLimitPerHour?: number;
  requiresApproval: boolean;
}

export interface UsageRecord {
  tenantId: string;
  capabilityId: string;
  calls: number;
  windowStart: string;
  windowEnd: string;
}

export interface EntitlementCheck {
  tenantId: string;
  capabilityId: string;
  allowed: boolean;
  reason?: 'over_quota' | 'tier_insufficient' | 'not_entitled' | 'ok';
}
