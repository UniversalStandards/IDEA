import axios, { type AxiosInstance } from 'axios';
import semver from 'semver';
import { verify, type Bundle } from 'sigstore';
import { createLogger } from '../observability/logger';
import type { ToolMetadata } from '../discovery/types';

const logger = createLogger('signature-verifier');
const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org';

export type PackageManager = 'npm' | 'pip';
export type VerificationMethod = 'sigstore-bundle' | 'npm-provenance' | 'pypi-sigstore' | 'local-trust';

export interface PackageVerificationRequest {
  name: string;
  version: string;
  manager: PackageManager;
  registryUrl?: string;
  integrity?: string;
  signature?: string;
  sigstoreBundle?: Bundle;
  sigstorePayload?: string;
  provenance?: Record<string, unknown>;
}

export interface VerifiedPackage {
  name: string;
  requestedVersion: string;
  resolvedVersion: string;
  spec: string;
  manager: PackageManager;
  verified: boolean;
  method?: VerificationMethod;
  integrity?: string;
  reason?: string;
  metadata: Record<string, unknown>;
}

export interface VerificationSummary {
  verified: boolean;
  packages: VerifiedPackage[];
  reason?: string;
}

interface NpmPackumentVersion {
  dist?: {
    integrity?: string;
    shasum?: string;
    signatures?: unknown[];
    attestations?: unknown;
    provenance?: unknown;
  };
}

interface NpmPackument {
  versions?: Record<string, NpmPackumentVersion>;
  'dist-tags'?: Record<string, string>;
}

export class SignatureVerifier {
  private readonly http: AxiosInstance;

  constructor(httpClient?: AxiosInstance) {
    this.http = httpClient ?? axios.create({ timeout: 10_000 });
  }

  async verifyTool(tool: ToolMetadata, dependencySpecs: string[]): Promise<VerificationSummary> {
    const requests = await this.buildRequests(tool, dependencySpecs);
    return this.verifyPackages(requests);
  }

  async verifyPackages(requests: PackageVerificationRequest[]): Promise<VerificationSummary> {
    const packages = await Promise.all(requests.map((request) => this.verifyPackage(request)));
    const failed = packages.find((entry) => !entry.verified);

    if (failed) {
      return {
        verified: false,
        packages,
        reason: failed.reason ?? `Signature verification failed for ${failed.name}@${failed.resolvedVersion}`,
      };
    }

    return { verified: true, packages };
  }

  async verifyPackage(request: PackageVerificationRequest): Promise<VerifiedPackage> {
    return request.manager === 'pip'
      ? this.verifyPipPackage(request)
      : this.verifyNpmPackage(request);
  }

  private async verifyNpmPackage(request: PackageVerificationRequest): Promise<VerifiedPackage> {
    const packument = await this.fetchNpmPackument(request.name, request.registryUrl);
    const resolvedVersion = this.resolveNpmVersion(request.version, packument);
    const versionMetadata = packument.versions?.[resolvedVersion];

    if (!versionMetadata) {
      return this.fail(request, resolvedVersion, `Unable to resolve npm version ${request.version} for ${request.name}`);
    }

    const integrity = request.integrity ?? versionMetadata.dist?.integrity ?? versionMetadata.dist?.shasum;
    if (!integrity) {
      return this.fail(request, resolvedVersion, `No integrity metadata published for ${request.name}@${resolvedVersion}`);
    }

    if (request.sigstoreBundle) {
      try {
        const payload = Buffer.from(
          request.sigstorePayload ?? `${request.name}@${resolvedVersion}:${integrity}`,
          'utf8',
        );
        await verify(request.sigstoreBundle, payload);
        return this.pass(request, resolvedVersion, 'sigstore-bundle', integrity, {
          registryUrl: request.registryUrl ?? DEFAULT_NPM_REGISTRY,
        });
      } catch (error) {
        return this.fail(
          request,
          resolvedVersion,
          `Sigstore verification failed for ${request.name}@${resolvedVersion}: ${error instanceof Error ? error.message : String(error)}`,
          integrity,
        );
      }
    }

    const hasRegistryProvenance =
      Array.isArray(versionMetadata.dist?.signatures) && versionMetadata.dist?.signatures.length > 0
        ? true
        : Boolean(versionMetadata.dist?.attestations ?? versionMetadata.dist?.provenance ?? request.provenance);

    if (!hasRegistryProvenance) {
      return this.fail(
        request,
        resolvedVersion,
        `No npm provenance or sigstore bundle available for ${request.name}@${resolvedVersion}`,
        integrity,
      );
    }

    return this.pass(request, resolvedVersion, 'npm-provenance', integrity, {
      registryUrl: request.registryUrl ?? DEFAULT_NPM_REGISTRY,
    });
  }

  private async verifyPipPackage(request: PackageVerificationRequest): Promise<VerifiedPackage> {
    if (request.sigstoreBundle) {
      try {
        const payload = Buffer.from(request.sigstorePayload ?? `${request.name}==${request.version}`, 'utf8');
        await verify(request.sigstoreBundle, payload);
        return this.pass(request, request.version, 'pypi-sigstore', request.integrity, {});
      } catch (error) {
        return this.fail(
          request,
          request.version,
          `PyPI sigstore verification failed for ${request.name}==${request.version}: ${error instanceof Error ? error.message : String(error)}`,
          request.integrity,
        );
      }
    }

    if (request.integrity && request.signature) {
      return this.pass(request, request.version, 'pypi-sigstore', request.integrity, {});
    }

    return this.fail(
      request,
      request.version,
      `No PyPI sigstore verification material available for ${request.name}==${request.version}`,
      request.integrity,
    );
  }

  private async buildRequests(
    tool: ToolMetadata,
    dependencySpecs: string[],
  ): Promise<PackageVerificationRequest[]> {
    const manager = this.inferPackageManager(tool);
    const requests: PackageVerificationRequest[] = [];

    if (tool.source !== 'local') {
      const bundle = this.readBundle(tool.metadata?.['sigstoreBundle']);
      const payload = this.readString(tool.metadata?.['sigstorePayload']);
      const provenance = this.readRecord(tool.metadata?.['provenance']);
      requests.push(
        this.buildRequest({
          name: this.primaryPackageName(tool),
          version: tool.version,
          manager,
          ...(tool.registryUrl ? { registryUrl: tool.registryUrl } : {}),
          ...(tool.signature ? { signature: tool.signature } : {}),
          ...(bundle ? { sigstoreBundle: bundle } : {}),
          ...(payload ? { sigstorePayload: payload } : {}),
          ...(provenance ? { provenance } : {}),
        }),
      );
    }

    for (const spec of dependencySpecs) {
      requests.push(this.parsePackageSpec(spec, manager));
    }

    return requests;
  }

  private primaryPackageName(tool: ToolMetadata): string {
    const packageName = tool.metadata?.['packageName'];
    return typeof packageName === 'string' && packageName.length > 0 ? packageName : tool.name;
  }

  private inferPackageManager(tool: ToolMetadata): PackageManager {
    return tool.metadata?.['packageManager'] === 'pip' ? 'pip' : 'npm';
  }

  private parsePackageSpec(spec: string, manager: PackageManager): PackageVerificationRequest {
    const trimmed = spec.trim();
    if (manager === 'pip') {
      const [namePart, versionPart] = trimmed.split('==');
      return this.buildRequest({
        name: namePart?.trim() ?? trimmed,
        version: versionPart?.trim() ?? 'latest',
        manager,
      });
    }

    const scopedMatch = /^(@[^@/]+\/[^@]+)(?:@(.+))?$/.exec(trimmed);
    if (scopedMatch?.[1]) {
      return this.buildRequest({
        name: scopedMatch[1],
        version: scopedMatch[2] ?? '*',
        manager,
      });
    }

    const atIndex = trimmed.indexOf('@');
    if (atIndex > 0) {
      return this.buildRequest({
        name: trimmed.slice(0, atIndex),
        version: trimmed.slice(atIndex + 1),
        manager,
      });
    }

    return this.buildRequest({ name: trimmed, version: '*', manager });
  }

  private async fetchNpmPackument(name: string, registryUrl?: string): Promise<NpmPackument> {
    const base = (registryUrl ?? DEFAULT_NPM_REGISTRY).replace(/\/$/, '');
    const encodedName = name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
    const response = await this.http.get<NpmPackument>(`${base}/${encodedName}`);
    return response.data;
  }

  private resolveNpmVersion(versionSpec: string, packument: NpmPackument): string {
    const available = Object.keys(packument.versions ?? {});
    if (available.length === 0) {
      throw new Error('No published versions available');
    }

    if (versionSpec === '*' || versionSpec === 'latest') {
      const latest = packument['dist-tags']?.['latest'];
      const sorted = available.sort(semver.rcompare);
      const fallback = sorted[0] ?? available[0];
      if (!fallback) {
        throw new Error('No published versions available');
      }
      return latest ?? fallback;
    }

    if (packument.versions?.[versionSpec]) {
      return versionSpec;
    }

    const resolved = semver.maxSatisfying(available, versionSpec);
    if (!resolved) {
      throw new Error(`Unable to satisfy version range ${versionSpec}`);
    }
    return resolved;
  }

  private pass(
    request: PackageVerificationRequest,
    resolvedVersion: string,
    method: VerificationMethod,
    integrity: string | undefined,
    metadata: Record<string, unknown>,
  ): VerifiedPackage {
    return this.buildVerifiedPackage(
      {
        name: request.name,
        requestedVersion: request.version,
        resolvedVersion,
        spec: request.manager === 'pip' ? `${request.name}==${resolvedVersion}` : `${request.name}@${resolvedVersion}`,
        manager: request.manager,
        verified: true,
        method,
        metadata,
      },
      integrity,
    );
  }

  private fail(
    request: PackageVerificationRequest,
    resolvedVersion: string,
    reason: string,
    integrity?: string,
  ): VerifiedPackage {
    logger.warn('Package signature verification failed', {
      packageName: request.name,
      requestedVersion: request.version,
      resolvedVersion,
      reason,
    });

    return this.buildVerifiedPackage(
      {
        name: request.name,
        requestedVersion: request.version,
        resolvedVersion,
        spec: request.manager === 'pip' ? `${request.name}==${resolvedVersion}` : `${request.name}@${resolvedVersion}`,
        manager: request.manager,
        verified: false,
        reason,
        metadata: {},
      },
      integrity,
    );
  }

  private buildRequest(base: {
    name: string;
    version: string;
    manager: PackageManager;
    registryUrl?: string;
    integrity?: string;
    signature?: string;
    sigstoreBundle?: Bundle;
    sigstorePayload?: string;
    provenance?: Record<string, unknown>;
  }): PackageVerificationRequest {
    return {
      name: base.name,
      version: base.version,
      manager: base.manager,
      ...(base.registryUrl ? { registryUrl: base.registryUrl } : {}),
      ...(base.integrity ? { integrity: base.integrity } : {}),
      ...(base.signature ? { signature: base.signature } : {}),
      ...(base.sigstoreBundle ? { sigstoreBundle: base.sigstoreBundle } : {}),
      ...(base.sigstorePayload ? { sigstorePayload: base.sigstorePayload } : {}),
      ...(base.provenance ? { provenance: base.provenance } : {}),
    };
  }

  private buildVerifiedPackage(
    base: Omit<VerifiedPackage, 'integrity'>,
    integrity?: string,
  ): VerifiedPackage {
    return {
      ...base,
      ...(integrity ? { integrity } : {}),
    };
  }

  private isBundle(value: unknown): value is Bundle {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const record = value as Record<string, unknown>;
    return 'mediaType' in record && 'content' in record && 'verificationMaterial' in record;
  }

  private readBundle(value: unknown): Bundle | undefined {
    return this.isBundle(value) ? value : undefined;
  }

  private readRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
  }

  private readString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
  }
}

export const signatureVerifier = new SignatureVerifier();
