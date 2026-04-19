/**
 * Tests for the schema reconciler.
 */
import { SchemaReconciler } from '../src/normalization/schema-reconciler';

jest.mock('../src/observability/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

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

  it('coerces string to integer (rounds)', () => {
    const schema = { properties: { n: { type: 'integer' } } };
    const result = reconciler.reconcile({ n: 3.7 }, schema);
    expect((result.coerced as Record<string, unknown>)['n']).toEqual(4);
  });

  it('coerces boolean to number', () => {
    const schema = { properties: { n: { type: 'number' } } };
    const r1 = reconciler.reconcile({ n: true }, schema);
    const r2 = reconciler.reconcile({ n: false }, schema);
    expect((r1.coerced as Record<string, unknown>)['n']).toEqual(1);
    expect((r2.coerced as Record<string, unknown>)['n']).toEqual(0);
  });

  it('reports issue when string cannot coerce to number', () => {
    const schema = { properties: { n: { type: 'number' } } };
    const result = reconciler.reconcile({ n: 'notanumber' }, schema);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('reports issue when non-string/bool cannot coerce to number', () => {
    const schema = { properties: { n: { type: 'number' } } };
    const result = reconciler.reconcile({ n: {} }, schema);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('coerces string "true"/"false" to boolean', () => {
    const schema = { properties: { flag: { type: 'boolean' } } };
    const trueResult = reconciler.reconcile({ flag: 'true' }, schema);
    const falseResult = reconciler.reconcile({ flag: 'false' }, schema);
    expect((trueResult.coerced as Record<string, unknown>)['flag']).toBe(true);
    expect((falseResult.coerced as Record<string, unknown>)['flag']).toBe(false);
  });

  it('coerces "yes"/"no"/"1"/"0" to boolean', () => {
    const schema = { properties: { flag: { type: 'boolean' } } };
    expect((reconciler.reconcile({ flag: 'yes' }, schema).coerced as Record<string, unknown>)['flag']).toBe(true);
    expect((reconciler.reconcile({ flag: 'no' }, schema).coerced as Record<string, unknown>)['flag']).toBe(false);
    expect((reconciler.reconcile({ flag: '1' }, schema).coerced as Record<string, unknown>)['flag']).toBe(true);
    expect((reconciler.reconcile({ flag: '0' }, schema).coerced as Record<string, unknown>)['flag']).toBe(false);
  });

  it('coerces number to boolean', () => {
    const schema = { properties: { flag: { type: 'boolean' } } };
    const r = reconciler.reconcile({ flag: 1 }, schema);
    expect((r.coerced as Record<string, unknown>)['flag']).toBe(true);
  });

  it('reports issue when string cannot coerce to boolean', () => {
    const schema = { properties: { flag: { type: 'boolean' } } };
    const result = reconciler.reconcile({ flag: 'maybe' }, schema);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('reports issue when object cannot coerce to boolean', () => {
    const schema = { properties: { flag: { type: 'boolean' } } };
    const result = reconciler.reconcile({ flag: {} }, schema);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('coerces JSON string to array', () => {
    const schema = { properties: { items: { type: 'array' } } };
    const result = reconciler.reconcile({ items: '["a","b"]' }, schema);
    expect(Array.isArray((result.coerced as Record<string, unknown>)['items'])).toBe(true);
  });

  it('coerces comma-separated string to array', () => {
    const schema = { properties: { items: { type: 'array' } } };
    const result = reconciler.reconcile({ items: 'a,b,c' }, schema);
    const arr = (result.coerced as Record<string, unknown>)['items'] as string[];
    expect(arr).toEqual(['a', 'b', 'c']);
  });

  it('wraps non-array value in array', () => {
    const schema = { properties: { items: { type: 'array' } } };
    const result = reconciler.reconcile({ items: 42 }, schema);
    expect(Array.isArray((result.coerced as Record<string, unknown>)['items'])).toBe(true);
  });

  it('coerces JSON string to object', () => {
    const schema = { properties: { cfg: { type: 'object' } } };
    const result = reconciler.reconcile({ cfg: '{"key":"val"}' }, schema);
    expect(typeof (result.coerced as Record<string, unknown>)['cfg']).toBe('object');
  });

  it('reports issue when string cannot coerce to object', () => {
    const schema = { properties: { cfg: { type: 'object' } } };
    const result = reconciler.reconcile({ cfg: 'not-json' }, schema);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('coerces to null when type is null', () => {
    const schema = { properties: { x: { type: 'null' } } };
    const result = reconciler.reconcile({ x: 'something' }, schema);
    expect((result.coerced as Record<string, unknown>)['x']).toBeNull();
  });

  it('passes through unknown type without coercion', () => {
    const schema = { properties: { x: { type: 'custom_type' } } };
    const result = reconciler.reconcile({ x: 'value' }, schema);
    expect((result.coerced as Record<string, unknown>)['x']).toBe('value');
  });

  it('handles nullable type array (type includes null)', () => {
    const schema = { properties: { x: { type: ['string', 'null'] } } };
    const result = reconciler.reconcile({ x: 123 }, schema);
    // Should coerce number to string since effective type is string
    expect(typeof (result.coerced as Record<string, unknown>)['x']).toBe('string');
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

  it('reports required field missing', () => {
    const schema = {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    };
    const result = reconciler.reconcile({}, schema);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes('name'))).toBe(true);
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

  it('reports an issue when string is below minLength', () => {
    const schema = { properties: { code: { type: 'string', minLength: 3 } } };
    const result = reconciler.reconcile({ code: 'ab' }, schema);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('reports an issue when string exceeds maxLength', () => {
    const schema = { properties: { code: { type: 'string', maxLength: 5 } } };
    const result = reconciler.reconcile({ code: 'toolongvalue' }, schema);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('handles null/undefined input gracefully', () => {
    const schema = { properties: { x: { type: 'string' } } };
    expect(() => reconciler.reconcile(null, schema)).not.toThrow();
    expect(() => reconciler.reconcile(undefined, schema)).not.toThrow();
  });

  it('returns default from top-level schema when input is null', () => {
    const schema = { default: 'fallback' };
    const result = reconciler.reconcile(null, schema);
    expect(result.coerced).toBe('fallback');
    expect(result.valid).toBe(true);
  });

  it('reports issue when input is null with no default', () => {
    const schema = { type: 'string' };
    const result = reconciler.reconcile(null, schema);
    expect(result.valid).toBe(false);
  });

  it('reconciles nested objects recursively', () => {
    const schema = {
      type: 'object',
      properties: {
        nested: {
          type: 'object',
          properties: {
            value: { type: 'number' },
          },
        },
      },
    };
    const result = reconciler.reconcile({ nested: { value: '42' } }, schema);
    const nested = (result.coerced as Record<string, unknown>)['nested'] as Record<string, unknown>;
    expect(nested['value']).toEqual(42);
  });

  it('handles schema without properties (pass-through)', () => {
    const schema = { type: 'object' };
    const input = { foo: 'bar' };
    const result = reconciler.reconcile(input, schema);
    expect(result.valid).toBe(true);
    expect(result.coerced).toEqual(input);
  });

  it('coerces JSON string input to object when schema type is object', () => {
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' } },
    };
    const result = reconciler.reconcile('{"name":"hello"}', schema);
    expect(result.valid).toBe(true);
    expect((result.coerced as Record<string, unknown>)['name']).toBe('hello');
  });

  it('reports invalid input type when schema is object but input is array', () => {
    const schema = { type: 'object', properties: { x: { type: 'string' } } };
    const result = reconciler.reconcile([1, 2, 3], schema);
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('reconciles top-level non-object type (string)', () => {
    const schema = { type: 'string' };
    const result = reconciler.reconcile(42, schema);
    expect(result.coerced).toBe('42');
    expect(result.valid).toBe(true);
  });

  it('reports issue for top-level coercion failure', () => {
    const schema = { type: 'number' };
    const result = reconciler.reconcile('notanumber', schema);
    expect(result.valid).toBe(false);
  });

  it('validates constraints on coerced top-level value', () => {
    const schema = { type: 'number', minimum: 10 };
    const result = reconciler.reconcile(5, schema);
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('returns valid when no type specified and input is not null', () => {
    const schema = {};
    const result = reconciler.reconcile('anything', schema);
    expect(result.valid).toBe(true);
  });
});

