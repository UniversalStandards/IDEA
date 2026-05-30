import { readFile } from 'fs/promises';
import { z } from 'zod';
import { ALLOWED_PLUGIN_PERMISSIONS } from './PluginPermissions';

export const PLUGIN_HOOKS = [
  'onCapabilityInstalled',
  'onWorkflowComplete',
  'onRouteSelected',
  'onAuditEvent',
  'onHealthChange',
] as const;

export type PluginHookName = (typeof PLUGIN_HOOKS)[number];

const PermissionSchema = z.enum(ALLOWED_PLUGIN_PERMISSIONS);
const HookSchema = z.enum(PLUGIN_HOOKS);

export const PluginManifestSchema = z.object({
  name: z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9-_.]*$/i),
  version: z.string().min(1).max(64),
  description: z.string().min(1).max(500).optional(),
  author: z.string().min(1).max(200).optional(),
  permissions: z.array(PermissionSchema).default([]),
  entrypoint: z.string().min(1).max(1024),
  hooks: z.array(HookSchema).default([]),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export function validatePluginManifest(manifest: unknown): PluginManifest {
  return PluginManifestSchema.parse(manifest);
}

export async function readPluginManifest(manifestPath: string): Promise<PluginManifest> {
  const raw = await readFile(manifestPath, 'utf8');
  return validatePluginManifest(JSON.parse(raw));
}
