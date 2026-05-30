import { z } from 'zod';
import { PluginPermission, PluginStatus } from '../plugin.types';

export const PluginHookSchema = z.enum([
  'onCapabilityInstalled',
  'onWorkflowComplete',
  'onRouteSelected',
  'onAuditEvent',
]);

export const PluginManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  permissions: z.array(z.nativeEnum(PluginPermission)),
  entrypoint: z.string().min(1),
  hooks: z.array(PluginHookSchema),
});

export const PluginSchema = z.object({
  manifest: PluginManifestSchema,
  status: z.nativeEnum(PluginStatus),
  loadedAt: z.string().min(1),
  instanceId: z.string().min(1),
});
