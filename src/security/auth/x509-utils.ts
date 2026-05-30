import { X509Certificate, createHash, randomUUID } from 'crypto';

export interface ParsedCertificate {
  raw: Buffer;
  cert: X509Certificate;
}

export function parsePemCertificate(pem: string): ParsedCertificate {
  const cert = new X509Certificate(pem);
  return { raw: cert.raw, cert };
}

export function buildCertificateChainFromRaw(chain: Buffer[]): X509Certificate[] {
  return chain.map((raw) => new X509Certificate(raw));
}

export function extractChainFromPeerCertificate(peer: { raw?: Buffer; issuerCertificate?: unknown } | undefined): X509Certificate[] {
  if (!peer?.raw) return [];

  const chain: X509Certificate[] = [];
  let cursor: { raw?: Buffer; issuerCertificate?: unknown } | undefined = peer;
  const seen = new Set<string>();

  while (cursor?.raw) {
    const cert = new X509Certificate(cursor.raw);
    const fingerprint = cert.fingerprint256;
    if (seen.has(fingerprint)) {
      break;
    }
    seen.add(fingerprint);
    chain.push(cert);

    const issuer = cursor.issuerCertificate as { raw?: Buffer; issuerCertificate?: unknown } | undefined;
    if (!issuer?.raw) break;
    cursor = issuer;
  }

  return chain;
}

export function validateCertificateChain(chain: X509Certificate[], trustStore: X509Certificate[], now: Date = new Date()): { valid: boolean; reason?: string } {
  if (chain.length === 0) {
    return { valid: false, reason: 'empty_chain' };
  }

  for (const cert of chain) {
    const validFrom = new Date(cert.validFrom);
    const validTo = new Date(cert.validTo);
    if (now < validFrom || now > validTo) {
      return { valid: false, reason: 'certificate_expired_or_not_yet_valid' };
    }
  }

  for (let i = 0; i < chain.length - 1; i++) {
    const cert = chain[i]!;
    const issuer = chain[i + 1]!;
    if (!cert.checkIssued(issuer)) {
      return { valid: false, reason: 'invalid_issuer_chain' };
    }
    if (!cert.verify(issuer.publicKey)) {
      return { valid: false, reason: 'invalid_certificate_signature' };
    }
  }

  const root = chain[chain.length - 1]!;
  const trusted = trustStore.some((trustedCert) => trustedCert.fingerprint256 === root.fingerprint256);
  if (!trusted) {
    return { valid: false, reason: 'untrusted_root_ca' };
  }

  return { valid: true };
}

export function splitPemBundle(bundle: string): string[] {
  return bundle
    .split('-----END CERTIFICATE-----')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => `${part}\n-----END CERTIFICATE-----\n`);
}

export function randomOpaqueToken(prefix: string): string {
  const id = randomUUID();
  const digest = createHash('sha256').update(`${prefix}:${id}:${Date.now().toString(36)}`).digest('hex');
  return `${prefix}_${digest}`;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
