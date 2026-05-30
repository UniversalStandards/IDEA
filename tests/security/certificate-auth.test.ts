import { X509Certificate } from 'crypto';

process.env['JWT_SECRET'] = process.env['JWT_SECRET'] ?? 'test-jwt-secret-min-32-characters!!!';
process.env['ENCRYPTION_KEY'] = process.env['ENCRYPTION_KEY'] ?? 'test-encryption-key-min-32-characters';
process.env['ENABLE_AUDIT_LOGGING'] = 'false';

jest.mock('../../src/observability/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const ROOT_CERT = `-----BEGIN CERTIFICATE-----
MIIDDzCCAfegAwIBAgIUNdXp2CK4v8w37n+Iw9gh/gMr1HIwDQYJKoZIhvcNAQEL
BQAwFzEVMBMGA1UEAwwMSURFQSBSb290IENBMB4XDTI2MDUzMDE0NTkwOFoXDTM2
MDUyNzE0NTkwOFowFzEVMBMGA1UEAwwMSURFQSBSb290IENBMIIBIjANBgkqhkiG
9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsfz8yyWoNGmgEdC+BA2OHGAXH0er5lVVfBim
igVVe0m5eKIC1x9x319IPoUv4f1HWVM1AIJICq0OfEdmYaR/F2ppHqpMDcEwRDhb
gT/eiIq/5r+VNu3s7/pv2QCtpksoxCG21JunnJZqDWhumIOfPfKo2lGFyva5UVXy
EBJIHuTl2UWyzu4AHOWJyo865vETgmsJ9MdzaMmRh3k+EAn5Con27adOEReb2VI+
wskd2fC64tPGAARcV5YpzMy/xDFkEp7RTH3tefFn+WNLoe/inPac8uotNcdFlCuB
kwJGer3b/YQYMiU1rMXoQFopLV7RKIO3f6Qn/hj4LP5mHEYthwIDAQABo1MwUTAd
BgNVHQ4EFgQUcD3k6Dq0ezjmsvf5lXpszwF5nGIwHwYDVR0jBBgwFoAUcD3k6Dq0
ezjmsvf5lXpszwF5nGIwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOC
AQEAkpxNBM4hjR++M6qM+PtVF/wW0pmp0B00FusdoexKITLhgDDxx6W3UkO2RpNv
VnOUuoaVHSptmY0dD11p2CYp9gS17KmNP80eQDH4uzkSPipX7t+8wIiqrkhmHB7P
FEUnjoj5iXT7P41MFgyCIiCaOl9/AYu7jiyvXWnEe8sRSaefWNt+5ZAVTzcH6M+W
uIswdSYlGMCUZWbcsw1cJmsEPJo6GtDpWMtVdo4ebD4UGttcmPz+Ujv0goQFldW7
Lh7ZPzLtaRCUU9AwSWWEGB11Z++0RiozK0OnQYiCGA8gyNwNQmDszXu2m5eVr+mj
Eg2ZpuetFzM1kQmuTTxsNFnk1A==
-----END CERTIFICATE-----`;

const LEAF_CERT = `-----BEGIN CERTIFICATE-----
MIICtDCCAZwCFEgtWQ3N4MFjpTHQcL/wTDwhSJw/MA0GCSqGSIb3DQEBCwUAMBcx
FTATBgNVBAMMDElERUEgUm9vdCBDQTAeFw0yNjA1MzAxNDU5MDlaFw0yNzA1MzAx
NDU5MDlaMBYxFDASBgNVBAMMC0lERUEgQ2xpZW50MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEA2iyJQZRaVw0waYIf5g9DPd6Cly5k91+I3D2qtJdA7x3L
wZUbHk1QXI4GiCZ0VljC5VdRRknVThp3rdFaiD9qAOHI6v66ep7s4WC/SrBNdoSw
i0WzHuwzinmbV0vN/u2JadlNo6FuBzuP2snLwgPcJZmMPjIPD4xbZaLIZH3AqmFv
UuYcIYbOpng9J3hezlyWjY7R4v83OJBY6FckGpKDi8T/9UQSJyX8aL16VxGhatRI
jNIwdADyNclHGHFAv860UqfbL1WCiwOIrFTBb7oTLNOxKf431Hrcy9XBURSL1rNi
4b0f2aLRhZUgW3QGms9+DqGbHBXsXiUehzfQ80CcbwIDAQABMA0GCSqGSIb3DQEB
CwUAA4IBAQAjwzJPzg/lFjsOsP1JJKOt4sAQjARG+dLYdiAcpTb+o+IEQyK4LfRX
GkrYQa5yWr0e+ti4n0zR3g905kDqowoUVrdWbADMJ3kXrHLleyMPEaDJpZ+aIlUC
X3DN4KZws5MxiIoFJw1TyyfP44UGzgaSUoPmTS3YNfHxK22VDWsNfpLDbb4BNLZr
0+u8u5veGvtuWQ7ev6iYN/O/GR6RMOmLRaESup1YEkL2NN32y+5nGU9a6yXfV2sx
5pYZmFrphp0dZgMk5zGJZ0PCls90+DmDe8a/LLbUWZCiJSiylF7iQPyZbiqJ4tsc
WURxsXqPnmt6Cnctab0Uq+0xTBNmLjal
-----END CERTIFICATE-----`;

describe('PivAuthProvider', () => {
  it('validates PIV/CAC certificate chain against federal trust store', async () => {
    const { PivAuthProvider } = await import('../../src/security/auth/PivAuthProvider');
    const provider = new PivAuthProvider({ federalTrustStorePem: ROOT_CERT, logger: { record: jest.fn() } });

    const result = provider.validateCertificateChain([LEAF_CERT, ROOT_CERT]);
    expect(result.subject).toContain('IDEA Client');
    expect(result.issuer).toContain('IDEA Root CA');
  });
});

describe('MtlsMiddleware', () => {
  it('allows requests with valid client cert chain signed by trusted CA', async () => {
    const { MtlsMiddleware } = await import('../../src/security/transport/MtlsMiddleware');

    const middleware = new MtlsMiddleware({ caBundlePem: ROOT_CERT, logger: { record: jest.fn() } });

    const leaf = new X509Certificate(LEAF_CERT);
    const root = new X509Certificate(ROOT_CERT);

    const req = {
      path: '/m2m',
      socket: {
        encrypted: true,
        authorized: true,
        getPeerCertificate: () => ({ raw: leaf.raw, issuerCertificate: { raw: root.raw } }),
      },
    } as never;

    const status = jest.fn().mockReturnThis();
    const json = jest.fn();
    const res = { status, json } as never;
    const next = jest.fn();

    middleware.handler(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });

  it('rejects requests without mTLS client cert', async () => {
    const { MtlsMiddleware } = await import('../../src/security/transport/MtlsMiddleware');
    const middleware = new MtlsMiddleware({ caBundlePem: ROOT_CERT, logger: { record: jest.fn() } });

    const status = jest.fn().mockReturnThis();
    const json = jest.fn();
    const res = { status, json } as never;

    middleware.handler(
      {
        path: '/m2m',
        socket: { encrypted: true, authorized: true, getPeerCertificate: () => ({}) },
      } as never,
      res,
      jest.fn()
    );

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: 'Client certificate required' });
  });
});
