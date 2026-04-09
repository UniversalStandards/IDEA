import { createLogger } from '../observability/logger';

const logger = createLogger('schema-reconciler');

export interface ReconcileResult {
  valid: boolean;
  coerced: unknown;
  issues: string[];
}

type SchemaProperty = {
  type?: string | string[];
  default?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  items?: Record<string, unknown>;
  properties?: Record<string, unknown>;
  required?: string[];
};

function coerceToType(value: unknown, targetType: string, fieldPath: string): { value: unknown; issue?: string } {
  if (value === null || value === undefined) {
    return { value };
  }

  switch (targetType) {
    case 'string': {
      if (typeof value === 'string') return { value };
      return { value: String(value) };
    }

    case 'number':
    case 'integer': {
      if (typeof value === 'number') {
        if (targetType === 'integer' && !Number.isInteger(value)) {
          return { value: Math.round(value) };
        }
        return { value };
      }
      if (typeof value === 'string') {
        const parsed = targetType === 'integer' ? parseInt(value, 10) : parseFloat(value);
        if (!isNaN(parsed)) return { value: parsed };
        return { value, issue: `Cannot coerce "${value}" to ${targetType} at ${fieldPath}` };
      }
      if (typeof value === 'boolean') {
        return { value: value ? 1 : 0 };
      }
      return { value, issue: `Cannot coerce ${typeof value} to ${targetType} at ${fieldPath}` };
    }

    case 'boolean': {
      if (typeof value === 'boolean') return { value };
      if (typeof value === 'string') {
        const lower = value.toLowerCase().trim();
        if (['true', 'yes', '1', 'on'].includes(lower)) return { value: true };
        if (['false', 'no', '0', 'off', ''].includes(lower)) return { value: false };
        return { value, issue: `Cannot coerce string "${value}" to boolean at ${fieldPath}` };
      }
      if (typeof value === 'number') return { value: value !== 0 };
      return { value, issue: `Cannot coerce ${typeof value} to boolean at ${fieldPath}` };
    }

    case 'array': {
      if (Array.isArray(value)) return { value };
      if (typeof value === 'string') {
        try {
          const parsed = JSON.parse(value);
          if (Array.isArray(parsed)) return { value: parsed };
        } catch {
          // Try comma-split as fallback
          return { value: value.split(',').map((s) => s.trim()) };
        }
      }
      return { value: [value] };
    }

    case 'object': {
      if (typeof value === 'object' && !Array.isArray(value)) return { value };
      if (typeof value === 'string') {
        try {
          const parsed = JSON.parse(value) as unknown;
          if (typeof parsed === 'object' && !Array.isArray(parsed) && parsed !== null) {
            return { value: parsed };
          }
        } catch {
          // ignore
        }
      }
      return { value, issue: `Cannot coerce ${typeof value} to object at ${fieldPath}` };
    }

    case 'null': {
      return { value: null };
    }

    default:
      return { value };
  }
}

function getEffectiveType(prop: SchemaProperty): string | null {
  if (!prop.type) return null;
  if (typeof prop.type === 'string') return prop.type;
  if (Array.isArray(prop.type)) {
    const nonNull = prop.type.filter((t) => t !== 'null');
    return nonNull[0] ?? null;
  }
  return null;
}

function validateConstraints(value: unknown, prop: SchemaProperty, fieldPath: string): string[] {
  const issues: string[] = [];

  if (prop.enum !== undefined) {
    if (!prop.enum.includes(value)) {
      issues.push(`Value "${String(value)}" is not in enum [${prop.enum.map(String).join(', ')}] at ${fieldPath}`);
    }
  }

  if (typeof value === 'number') {
    if (prop.minimum !== undefined && value < prop.minimum) {
      issues.push(`Value ${value} is below minimum ${prop.minimum} at ${fieldPath}`);
    }
    if (prop.maximum !== undefined && value > prop.maximum) {
      issues.push(`Value ${value} exceeds maximum ${prop.maximum} at ${fieldPath}`);
    }
  }

  if (typeof value === 'string') {
    if (prop.minLength !== undefined && value.length < prop.minLength) {
      issues.push(`String length ${value.length} is below minLength ${prop.minLength} at ${fieldPath}`);
    }
    if (prop.maxLength !== undefined && value.length > prop.maxLength) {
      issues.push(`String length ${value.length} exceeds maxLength ${prop.maxLength} at ${fieldPath}`);
    }
  }

  return issues;
}

function reconcileObject(
  input: Record<string, unknown>,
  schema: Record<string, unknown>,
  path: string,
): { result: Record<string, unknown>; issues: string[] } {
  const issues: string[] = [];
  const result: Record<string, unknown> = { ...input };

  const properties = schema['properties'] as Record<string, Record<string, unknown>> | undefined;
  const required = (schema['required'] as string[] | undefined) ?? [];

  if (!properties) {
    return { result, issues };
  }

  for (const [fieldName, rawProp] of Object.entries(properties)) {
    const prop = rawProp as SchemaProperty;
    const fieldPath = path ? `${path}.${fieldName}` : fieldName;
    const currentValue = result[fieldName];

    if (currentValue === undefined || currentValue === null) {
      if (prop.default !== undefined) {
        result[fieldName] = prop.default;
        logger.debug('Applied default value', { fieldPath, default: prop.default });
      } else if (required.includes(fieldName)) {
        issues.push(`Required field "${fieldPath}" is missing`);
      }
      continue;
    }

    const targetType = getEffectiveType(prop);
    if (targetType) {
      const actualType = Array.isArray(currentValue) ? 'array' : typeof currentValue;
      const isNullable = Array.isArray(prop.type) && prop.type.includes('null');

      if (actualType !== targetType && !(isNullable && currentValue === null)) {
        const coerced = coerceToType(currentValue, targetType, fieldPath);
        if (coerced.issue) {
          issues.push(coerced.issue);
        } else {
          result[fieldName] = coerced.value;
        }
      }
    }

    const constraintIssues = validateConstraints(result[fieldName], prop, fieldPath);
    issues.push(...constraintIssues);

    // Recursively reconcile nested objects
    if (prop.type === 'object' && prop.properties && typeof result[fieldName] === 'object' && result[fieldName] !== null) {
      const nested = reconcileObject(
        result[fieldName] as Record<string, unknown>,
        prop as Record<string, unknown>,
        fieldPath,
      );
      result[fieldName] = nested.result;
      issues.push(...nested.issues);
    }
  }

  return { result, issues };
}

export class SchemaReconciler {
  reconcile(input: unknown, targetSchema: Record<string, unknown>): ReconcileResult {
    const issues: string[] = [];

    if (input === null || input === undefined) {
      const hasDefault = 'default' in targetSchema;
      const coerced = hasDefault ? targetSchema['default'] : input;
      if (!hasDefault) {
        issues.push('Input is null or undefined and no default is specified');
      }
      return { valid: issues.length === 0, coerced, issues };
    }

    const schemaType = targetSchema['type'] as string | string[] | undefined;
    const topType = Array.isArray(schemaType)
      ? (schemaType.find((t) => t !== 'null') ?? null)
      : (schemaType ?? null);

    if (topType === 'object' || (topType === null && targetSchema['properties'])) {
      if (typeof input !== 'object' || Array.isArray(input)) {
        if (typeof input === 'string') {
          try {
            const parsed = JSON.parse(input) as unknown;
            if (typeof parsed === 'object' && !Array.isArray(parsed) && parsed !== null) {
              const { result, issues: nested } = reconcileObject(
                parsed as Record<string, unknown>,
                targetSchema,
                '',
              );
              issues.push(...nested);
              const valid = issues.filter((i) => i.startsWith('Required')).length === 0;
              return { valid, coerced: result, issues };
            }
          } catch {
            // fall through
          }
        }
        issues.push(`Expected object but received ${Array.isArray(input) ? 'array' : typeof input}`);
        return { valid: false, coerced: input, issues };
      }

      const { result, issues: nested } = reconcileObject(
        input as Record<string, unknown>,
        targetSchema,
        '',
      );
      issues.push(...nested);

      const hasMissingRequired = issues.some((i) => i.startsWith('Required'));
      const hasUnresolvable = issues.some((i) => i.includes('Cannot coerce'));
      const valid = !hasMissingRequired && !hasUnresolvable;

      logger.debug('Schema reconciliation complete', {
        valid,
        issueCount: issues.length,
      });

      return { valid, coerced: result, issues };
    }

    if (topType && topType !== 'object') {
      const coerced = coerceToType(input, topType, '');
      if (coerced.issue) {
        issues.push(coerced.issue);
        return { valid: false, coerced: input, issues };
      }

      const propIssues = validateConstraints(coerced.value, targetSchema as SchemaProperty, '');
      issues.push(...propIssues);

      return { valid: issues.length === 0, coerced: coerced.value, issues };
    }

    return { valid: true, coerced: input, issues };
  }
}

export const schemaReconciler = new SchemaReconciler();
