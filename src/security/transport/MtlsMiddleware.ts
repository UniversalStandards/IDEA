import type { NextFunction, Request, Response } from 'express';
import { X509Certificate } from 'crypto';
import { auditLog } from '../audit';
import { extractChainFromPeerCertificate, splitPemBundle, validateCertificateChain } from '../auth/x509-utils';

interface PeerCertificateLike {
  raw?: Buffer;
  issuerCertificate?: unknown;
  subject?: { CN?: string };
}

interface TlsSocketLike {
  encrypted?: boolean;
  authorized?: boolean;
  authorizationError?: string;
  getPeerCertificate?: (detailed?: boolean) => PeerCertificateLike;
}

export interface MtlsMiddlewareOptions {
  caBundlePem: string;
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

export class MtlsMiddleware {
  private readonly trustStore: X509Certificate[];
  private readonly logger: AuditRecorder;

  constructor(options: MtlsMiddlewareOptions) {
    this.trustStore = splitPemBundle(options.caBundlePem).map((pem) => new X509Certificate(pem));
    this.logger = options.logger ?? auditLog;
  }

  handler = (req: Request, res: Response, next: NextFunction): void => {
    const socket = req.socket as unknown as TlsSocketLike;
    if (!socket.encrypted || typeof socket.getPeerCertificate !== 'function') {
      this.fail('mtls.authenticate', 'transport_not_tls');
      res.status(401).json({ error: 'mTLS required' });
      return;
    }

    const peer = socket.getPeerCertificate(true);
    if (!peer?.raw) {
      this.fail('mtls.authenticate', 'missing_client_certificate');
      res.status(401).json({ error: 'Client certificate required' });
      return;
    }

    if (socket.authorized === false) {
      this.fail('mtls.authenticate', socket.authorizationError ?? 'socket_not_authorized');
      res.status(401).json({ error: 'Client certificate unauthorized' });
      return;
    }

    const chain = extractChainFromPeerCertificate(peer);
    const validation = validateCertificateChain(chain, this.trustStore);
    if (!validation.valid) {
      this.fail('mtls.authenticate', validation.reason ?? 'invalid_chain');
      res.status(401).json({ error: 'Invalid client certificate chain' });
      return;
    }

    this.logger.record('mtls.authenticate', chain[0]?.subject ?? 'unknown', req.path, 'success', undefined, {
      fingerprint: chain[0]?.fingerprint256,
    });

    next();
  };

  private fail(action: string, reason: string): void {
    this.logger.record(action, 'system', 'mtls', 'failure', undefined, { reason });
  }
}
