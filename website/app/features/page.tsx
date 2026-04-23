import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Features',
  description:
    'Explore all capabilities of the Universal MCP Orchestration Hub — auto-discovery, zero-touch provisioning, multi-provider routing, policy enforcement, protocol normalization, and full observability.',
};

const featureDetails = [
  {
    title: 'Auto-Discovery',
    summary: 'Find tools without lifting a finger.',
    details: [
      'Scans GitHub, official MCP registry, and enterprise catalogs on a configurable schedule.',
      'Validates tool schemas with Zod and caches results with configurable TTL.',
      'Deduplicates tools across registries — matching by name + version, merging metadata.',
      'Emits structured events on every discovery cycle for full observability.',
      'Enterprise catalog supports both JSON-over-HTTP and local file-based catalogs.',
    ],
  },
  {
    title: 'Zero-Touch Provisioning',
    summary: 'Install, verify, and roll back automatically.',
    details: [
      'Resolves transitive dependencies before installing any tool.',
      'Verifies SHA-256 checksum of every downloaded package.',
      'Install lock prevents concurrent installs of the same package.',
      'Full rollback: if installation fails mid-way, partial installs are cleaned up.',
      'Dry-run mode: validate all installation steps without executing them.',
    ],
  },
  {
    title: 'Multi-Provider Routing',
    summary: 'Always route to the best available provider.',
    details: [
      'Configurable primary → fallback → local escalation chain.',
      'Circuit breaker per provider: opens after N consecutive failures, half-opens after cooldown.',
      'Background health checks ping each provider every 60 seconds.',
      'Routing metrics: request count, failure count, p50/p95/p99 latency per provider.',
      'Cost-aware routing: prefer cheaper models when quality requirements are met.',
    ],
  },
  {
    title: 'Policy & Security',
    summary: 'Enterprise controls without slowing teams down.',
    details: [
      'JSON-based policy packs loaded from the policies/ directory at startup.',
      'Hot-reload: watches for policy file changes and reloads without restart.',
      'Synchronous and asynchronous approval gates with configurable timeouts.',
      'HMAC-signed audit log entries to detect tampering.',
      'JWT authentication for all admin API routes.',
      'Credential broker scopes, injects, and rotates provider credentials.',
    ],
  },
  {
    title: 'Protocol Normalization',
    summary: 'Unified interface for every protocol.',
    details: [
      'Normalizes MCP, REST, GraphQL, and JSON-RPC 2.0 to a single internal request format.',
      'CLI adapter spawns child processes safely using spawn() — never exec().',
      'GraphQL adapter performs schema introspection and maps queries to MCP tool definitions.',
      'Webhook receiver with Zod validation and event-id deduplication.',
      'SSE stream endpoint for real-time event routing.',
    ],
  },
  {
    title: 'Observability',
    summary: 'See everything, cost nothing extra.',
    details: [
      'Structured Winston logging with daily rotation, 30-day retention, and gzip compression.',
      'Sensitive field redaction: passwords, tokens, secrets never appear in logs.',
      'Cost tracking per provider, model, and time window (hourly/daily aggregates).',
      'Daily budget alerts when configurable spend threshold is approached.',
      'OpenMetrics-compatible metrics endpoint for Prometheus scraping.',
    ],
  },
];

const comparisonRows = [
  { feature: 'Tool Registration', traditional: 'Manual, per-tool', hub: 'Auto-discovered from registries' },
  { feature: 'Provider Support', traditional: 'Single provider', hub: 'Multi-provider with smart routing' },
  { feature: 'Installation', traditional: 'Manual npm/pip steps', hub: 'Zero-touch with rollback' },
  { feature: 'Protocol Support', traditional: 'One protocol', hub: 'MCP, REST, GraphQL, JSON-RPC, CLI, SSE' },
  { feature: 'Policy Enforcement', traditional: 'None or custom code', hub: 'Built-in policy engine with hot-reload' },
  { feature: 'Audit Trail', traditional: 'Application logs only', hub: 'HMAC-signed tamper-evident audit log' },
  { feature: 'Cost Tracking', traditional: 'Manual dashboards', hub: 'Per-provider, per-model cost monitor' },
  { feature: 'Failover', traditional: 'Manual retry code', hub: 'Circuit breaker + automatic escalation' },
];

const protocols = [
  { name: 'MCP (Model Context Protocol)', supported: true, notes: 'Stdio and SSE transports' },
  { name: 'REST / HTTP', supported: true, notes: 'Full Express 5 adapter' },
  { name: 'GraphQL', supported: true, notes: 'Introspection + variable injection' },
  { name: 'JSON-RPC 2.0', supported: true, notes: 'Request normalization included' },
  { name: 'CLI / Shell', supported: true, notes: 'spawn() only — no shell injection risk' },
  { name: 'Server-Sent Events', supported: true, notes: 'Real-time event streaming' },
  { name: 'Webhooks', supported: true, notes: 'Zod-validated, idempotent' },
  { name: 'gRPC', supported: false, notes: 'Planned for v0.3' },
  { name: 'WebSockets', supported: false, notes: 'Planned for v0.4' },
];

export default function FeaturesPage() {
  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
      <div className="text-center mb-16">
        <h1 className="text-4xl sm:text-5xl font-bold text-gray-900 dark:text-white mb-4">
          Built for production AI infrastructure
        </h1>
        <p className="text-xl text-gray-600 dark:text-gray-400 max-w-2xl mx-auto">
          Every feature designed around reliability, security, and zero operational overhead.
        </p>
      </div>

      <div className="space-y-16 mb-24">
        {featureDetails.map((f, i) => (
          <div key={f.title} className={`flex flex-col md:flex-row gap-8 ${i % 2 === 1 ? 'md:flex-row-reverse' : ''}`}>
            <div className="flex-1">
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">{f.title}</h2>
              <p className="text-indigo-600 dark:text-indigo-400 font-medium mb-4">{f.summary}</p>
              <ul className="space-y-2">
                {f.details.map((d, j) => (
                  <li key={j} className="flex items-start gap-2 text-gray-600 dark:text-gray-400 text-sm">
                    <svg className="w-5 h-5 text-green-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    {d}
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex-1 flex items-center justify-center">
              <div className="w-full max-w-sm h-48 rounded-2xl bg-gradient-to-br from-indigo-50 to-purple-50 dark:from-indigo-950/50 dark:to-purple-950/50 border border-indigo-100 dark:border-indigo-900 flex items-center justify-center">
                <span className="text-5xl font-bold text-indigo-200 dark:text-indigo-800">
                  {String(i + 1).padStart(2, '0')}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>

      <section aria-labelledby="comparison-heading" className="mb-24">
        <h2 id="comparison-heading" className="text-3xl font-bold text-gray-900 dark:text-white text-center mb-8">
          MCP Hub vs. Traditional MCP
        </h2>
        <div className="overflow-x-auto rounded-2xl border border-gray-200 dark:border-gray-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-900">
                <th className="text-left px-6 py-4 font-semibold text-gray-700 dark:text-gray-300">Feature</th>
                <th className="text-left px-6 py-4 font-semibold text-gray-500 dark:text-gray-400">Traditional MCP</th>
                <th className="text-left px-6 py-4 font-semibold text-indigo-600 dark:text-indigo-400">Universal MCP Hub</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {comparisonRows.map((row) => (
                <tr key={row.feature} className="bg-white dark:bg-gray-950 hover:bg-gray-50 dark:hover:bg-gray-900 transition-colors">
                  <td className="px-6 py-4 font-medium text-gray-900 dark:text-white">{row.feature}</td>
                  <td className="px-6 py-4 text-gray-500 dark:text-gray-400">{row.traditional}</td>
                  <td className="px-6 py-4 text-indigo-600 dark:text-indigo-400 font-medium">{row.hub}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="protocols-heading">
        <h2 id="protocols-heading" className="text-3xl font-bold text-gray-900 dark:text-white text-center mb-8">
          Protocol Support Matrix
        </h2>
        <div className="overflow-x-auto rounded-2xl border border-gray-200 dark:border-gray-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-900">
                <th className="text-left px-6 py-4 font-semibold text-gray-700 dark:text-gray-300">Protocol</th>
                <th className="text-left px-6 py-4 font-semibold text-gray-700 dark:text-gray-300">Status</th>
                <th className="text-left px-6 py-4 font-semibold text-gray-700 dark:text-gray-300">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {protocols.map((p) => (
                <tr key={p.name} className="bg-white dark:bg-gray-950 hover:bg-gray-50 dark:hover:bg-gray-900 transition-colors">
                  <td className="px-6 py-4 font-medium text-gray-900 dark:text-white">{p.name}</td>
                  <td className="px-6 py-4">
                    {p.supported ? (
                      <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400 font-semibold">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                        Supported
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-gray-400 dark:text-gray-600">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                        Planned
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-gray-500 dark:text-gray-400">{p.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
