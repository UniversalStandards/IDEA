/**
 * Tests for the schema reconciler.
 */
import { SchemaReconciler } from '../src/normalization/schema-reconciler';

describe('SchemaReconciler', () => {
  let reconciler: SchemaReconciler;

  beforeEach(() => {
    reconciler = new SchemaReconciler();
  });

  it('returns valid=true when input already matches', () => {
    const schema = {
      properties: {
        name: { type: 'string' },
        count: { type: 'number' },
      },
    };
    const result = reconciler.reconcile({ name: 'test', count: 5 }, schema);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('coerces string to number', () => {
    const schema = { properties: { count: { type: 'number' } } };
    const result = reconciler.reconcile({ count: '42' }, schema);
    expect((result.coerced as Record<string, unknown>)['count']).toEqual(42);
  });

  it('coerces string "true"/"false" to boolean', () => {
    const schema = { properties: { flag: { type: 'boolean' } } };
    const trueResult = reconciler.reconcile({ flag: 'true' }, schema);
    const falseResult = reconciler.reconcile({ flag: 'false' }, schema);
    expect((trueResult.coerced as Record<string, unknown>)['flag']).toBe(true);
    expect((falseResult.coerced as Record<string, unknown>)['flag']).toBe(false);
  });

  it('fills in default values for missing fields', () => {
    const schema = {
      properties: {
        limit: { type: 'number', default: 10 },
      },
    };
    const result = reconciler.reconcile({}, schema);
    expect((result.coerced as Record<string, unknown>)['limit']).toEqual(10);
  });

  it('reports an issue for enum violation', () => {
    const schema = {
      properties: {
        status: { type: 'string', enum: ['active', 'inactive'] },
      },
    };
    const result = reconciler.reconcile({ status: 'deleted' }, schema);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('reports an issue when number is below minimum', () => {
    const schema = { properties: { age: { type: 'number', minimum: 0 } } };
    const result = reconciler.reconcile({ age: -1 }, schema);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('reports an issue when number is above maximum', () => {
    const schema = { properties: { score: { type: 'number', maximum: 100 } } };
    const result = reconciler.reconcile({ score: 200 }, schema);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('handles null/undefined input gracefully', () => {
    const schema = { properties: { x: { type: 'string' } } };
    expect(() => reconciler.reconcile(null, schema)).not.toThrow();
    expect(() => reconciler.reconcile(undefined, schema)).not.toThrow();
  });
});
