jest.mock('sigstore', () => ({
  verify: jest.fn(async () => ({ subject: 'ok' })),
}));

jest.mock('../src/observability/logger', () => ({
  createLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { SignatureVerifier } from '../src/provisioning/SignatureVerifier';

describe('SignatureVerifier', () => {
  it('accepts npm packages with registry provenance metadata and pins the resolved version', async () => {
    const http = {
      get: jest.fn(async () => ({
        data: {
          versions: {
            '1.0.0': { dist: { integrity: 'sha512-old', signatures: [{}] } },
            '1.2.0': { dist: { integrity: 'sha512-new', signatures: [{}] } },
          },
          'dist-tags': { latest: '1.2.0' },
        },
      })),
    };

    const verifier = new SignatureVerifier(http as never);
    const result = await verifier.verifyPackages([
      { name: 'example-tool', version: '^1.0.0', manager: 'npm' },
    ]);

    expect(result.verified).toBe(true);
    expect(result.packages[0]?.resolvedVersion).toBe('1.2.0');
    expect(result.packages[0]?.method).toBe('npm-provenance');
  });

  it('rejects npm packages without provenance or sigstore data', async () => {
    const http = {
      get: jest.fn(async () => ({
        data: {
          versions: {
            '2.0.0': { dist: { integrity: 'sha512-no-proof' } },
          },
          'dist-tags': { latest: '2.0.0' },
        },
      })),
    };

    const verifier = new SignatureVerifier(http as never);
    const result = await verifier.verifyPackages([
      { name: 'unsigned-tool', version: '2.0.0', manager: 'npm' },
    ]);

    expect(result.verified).toBe(false);
    expect(result.reason).toContain('No npm provenance');
  });
});
