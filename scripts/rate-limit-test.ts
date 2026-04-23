/**
 * scripts/rate-limit-test.ts
 *
 * Rate-limit stress test.
 *
 * Fires N concurrent requests against a running MCP Hub instance and
 * verifies that the rate limiter kicks in once RATE_LIMIT_MAX_REQUESTS
 * requests have been served within the configured window.
 *
 * Usage:
 *   # Start the server first, then:
 *   npx tsx scripts/rate-limit-test.ts
 *
 * Environment variables (all optional):
 *   BASE_URL          — default: http://localhost:3000
 *   REQUESTS          — total requests to fire    (default: 320)
 *   CONCURRENCY       — parallel in-flight limit  (default: 50)
 *   EXPECTED_LIMIT    — when to expect 429s        (default: 300)
 */

const BASE_URL = process.env['BASE_URL'] ?? 'http://localhost:3000';
const TOTAL_REQUESTS = parseInt(process.env['REQUESTS'] ?? '320', 10);
const CONCURRENCY = parseInt(process.env['CONCURRENCY'] ?? '50', 10);
const EXPECTED_LIMIT = parseInt(process.env['EXPECTED_LIMIT'] ?? '300', 10);

interface Result {
  index: number;
  status: number;
  durationMs: number;
}

async function fireRequest(index: number): Promise<Result> {
  const start = Date.now();
  const res = await fetch(`${BASE_URL}/health/live`);
  return { index, status: res.status, durationMs: Date.now() - start };
}

async function runBatch(indices: number[]): Promise<Result[]> {
  return Promise.all(indices.map((i) => fireRequest(i)));
}

async function main(): Promise<void> {
  console.log(`\nRate-limit stress test`);
  console.log(`  Target:          ${BASE_URL}/health/live`);
  console.log(`  Total requests:  ${String(TOTAL_REQUESTS)}`);
  console.log(`  Concurrency:     ${String(CONCURRENCY)}`);
  console.log(`  Expected limit:  ${String(EXPECTED_LIMIT)} req/window\n`);

  const allResults: Result[] = [];
  const indices = Array.from({ length: TOTAL_REQUESTS }, (_, i) => i);

  // Process in batches to control concurrency
  for (let i = 0; i < indices.length; i += CONCURRENCY) {
    const batch = indices.slice(i, i + CONCURRENCY);
    const batchResults = await runBatch(batch);
    allResults.push(...batchResults);
    process.stdout.write(`  Completed ${String(Math.min(i + CONCURRENCY, TOTAL_REQUESTS))}/${String(TOTAL_REQUESTS)}\r`);
  }

  console.log('\n');

  const successCount = allResults.filter((r) => r.status === 200).length;
  const rateLimitedCount = allResults.filter((r) => r.status === 429).length;
  const otherCount = allResults.filter((r) => r.status !== 200 && r.status !== 429).length;

  console.log('Results:');
  console.log(`  200 OK:            ${String(successCount)}`);
  console.log(`  429 Too Many:      ${String(rateLimitedCount)}`);
  console.log(`  Other:             ${String(otherCount)}`);

  // Validation
  let passed = true;

  if (rateLimitedCount === 0 && TOTAL_REQUESTS > EXPECTED_LIMIT) {
    console.error(`\n  FAIL — expected at least one 429 after ${String(EXPECTED_LIMIT)} requests, got none.`);
    passed = false;
  }

  if (successCount < EXPECTED_LIMIT && TOTAL_REQUESTS >= EXPECTED_LIMIT) {
    console.error(
      `\n  FAIL — fewer than ${String(EXPECTED_LIMIT)} requests succeeded (got ${String(successCount)}).`,
    );
    passed = false;
  }

  if (passed) {
    console.log(`\n  PASS — rate limiter engaged after ~${String(successCount)} successful requests. ✓`);
    process.exit(0);
  } else {
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('Rate-limit test error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
