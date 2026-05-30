export interface ToolMetadata {
  id: string;
  name: string;
  version: string;
  description: string;
  source:
    | 'github'
    | 'official'
    | 'enterprise'
    | 'local'
    | 'npm'
    | 'pypi'
    | 'dockerhub'
    | 'smithery'
    | 'mcprun'
    | 'unknown';
  registryUrl?: string | undefined;
  repository?: string | undefined;
  installCommand?: string | undefined;
  entryPoint?: string | undefined;
  capabilities: string[];
  tags: string[];
  author?: string | undefined;
  license?: string | undefined;
  downloadCount?: number | undefined;
  lastUpdated?: Date | undefined;
  signature?: string | undefined;
  verified?: boolean | undefined;
  riskLevel?: 'low' | 'medium' | 'high' | undefined;
  dependencies?: string[] | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface RegistrySearchOptions {
  query: string;
  limit?: number;
  tags?: string[];
  source?: ToolMetadata['source'];
}

export interface Registry {
  name: string;
  search(options: RegistrySearchOptions): Promise<ToolMetadata[]>;
  getById(id: string): Promise<ToolMetadata | null>;
  list(): Promise<ToolMetadata[]>;
  isAvailable(): Promise<boolean>;
}
