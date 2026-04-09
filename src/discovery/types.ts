export interface ToolMetadata {
  id: string;
  name: string;
  version: string;
  description: string;
  source: 'github' | 'official' | 'enterprise' | 'local' | 'unknown';
  registryUrl?: string;
  repository?: string;
  installCommand?: string;
  entryPoint?: string;
  capabilities: string[];
  tags: string[];
  author?: string;
  license?: string;
  downloadCount?: number;
  lastUpdated?: Date;
  signature?: string;
  verified?: boolean;
  riskLevel?: 'low' | 'medium' | 'high';
  dependencies?: string[];
  metadata?: Record<string, unknown>;
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
