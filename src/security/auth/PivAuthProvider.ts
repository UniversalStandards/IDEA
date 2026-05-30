import { X509Certificate } from 'crypto';
import { auditLog } from '../audit';
import { splitPemBundle, validateCertificateChain } from './x509-utils';

export interface PivAuthResult {
  subject: string;
  issuer: string;
  serialNumber: string;
  validFrom: string;
  validTo: string;
}

export interface PivAuthProviderOptions {
  federalTrustStorePem: string;
  logger?: AuditRecorder;
}

interface AuditRecorder {
  record: (
    action: string,
    actor: string,
    resource: string,
    outcome: 'success' | 'failure' | 'pending',
    correlationId?: string,
    meta?: Record<string, unknown>
  ) => void;
}

export class PivAuthProvider {
  private readonly trustStore: X509Certificate[];
  private readonly logger: AuditRecorder;

  constructor(options: PivAuthProviderOptions) {
    this.trustStore = splitPemBundle(options.federalTrustStorePem).map((pem) => new X509Certificate(pem));
    this.logger = options.logger ?? auditLog;
  }

  validateCertificateChain(chainPem: string[]): PivAuthResult {
    const chain = chainPem.map((pem) => new X509Certificate(pem));
    const validity = validateCertificateChain(chain, this.trustStore);
    if (!validity.valid) {
      this.logger.record('piv.authenticate', 'system', 'federal-pki', 'failure', undefined, {
        reason: validity.reason,
      });
      throw new Error(`Invalid PIV/CAC certificate chain: ${validity.reason}`);
    }

    const leaf = chain[0]!;
    const result: PivAuthResult = {
      subject: leaf.subject,
      issuer: leaf.issuer,
      serialNumber: leaf.serialNumber,
      validFrom: leaf.validFrom,
      validTo: leaf.validTo,
    };

    this.logger.record('piv.authenticate', leaf.subject, 'federal-pki', 'success', undefined, {
      issuer: leaf.issuer,
      serialNumber: leaf.serialNumber,
    });

    return result;
  }
}
