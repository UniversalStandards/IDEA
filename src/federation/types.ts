/**
 * Federation Layer — Cross-Hub Capability Sharing
 *
 * NEW capability — not present in any prior system reviewed (IDEA, mcp,
 * Universal-Standard-MCP-Server, or the Hive Nexus design). Lets multiple
 * IDEA/MCP hub instances — different orgs, clouds, or air-gapped enclaves —
 * share capability manifests without sharing credentials or trusting a
 * central registry unconditionally.
 */

export interface CapabilityManifest {
  id: string;
  name: string;
  version: string;
  openapiRef?: string;       // e.g. adapters/github/main.yaml
  checksum: string;          // sha256 of the manifest content
  signature: string;         // detached signature, see TrustAnchor
  publishedBy: string;       // hub instance id
  publishedAt: string;
}

export interface TrustAnchor {
  hubId: string;
  publicKey: string;         // ed25519 public key, base64
  trustLevel: 'self' | 'verified_partner' | 'community' | 'untrusted';
}

export interface FederationPeer {
  hubId: string;
  endpoint: string;
  trust: TrustAnchor;
  lastSync?: string;
  capabilitiesShared: number;
}

/** A hub only imports a peer's capability if it can verify the signature
 *  against a known TrustAnchor AND the peer's trustLevel meets the local
 *  policy minimum for that capability's risk class. */
export interface FederationPolicy {
  minTrustLevel: TrustAnchor['trustLevel'];
  autoImport: boolean;       // false = require human/agent approval
  allowedRiskClasses: Array<'read_only' | 'write' | 'financial' | 'destructive'>;
}

export interface FederationSyncResult {
  peerId: string;
  imported: number;
  skipped: number;
  rejected: Array<{ manifestId: string; reason: string }>;
}
