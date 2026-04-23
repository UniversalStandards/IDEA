import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Universal MCP Orchestration Hub — AI Tool Orchestration Platform',
  description:
    'Auto-discover, provision, route, and secure any MCP-compatible tool or AI provider. The universal orchestration layer for AI tools.',
};

const features = [
  {
    title: 'Auto-Discovery',
    description:
      'Automatically finds and catalogues tools from multiple registries — GitHub, official MCP registry, and enterprise catalogs. Zero manual tool registration.',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="11" cy="11" r="8" strokeWidth="2" />
        <path d="m21 21-4.35-4.35" strokeWidth="2" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    title: 'Zero-Touch Provisioning',
    description:
      'Installs and configures tools on demand with no manual steps. Automatic dependency resolution, checksum verification, and rollback on failure.',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
      </svg>
    ),
  },
  {
    title: 'Multi-Provider Routing',
    description:
      'Intelligently routes requests to the best AI provider based on cost, latency, and capability. Circuit breakers and automatic failover keep you running.',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
      </svg>
    ),
  },
  {
    title: 'Policy & Security',
    description:
      'Enterprise-grade policy enforcement with full audit trails, HMAC-signed log entries, JWT authentication, approval gates, and credential brokering.',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
      </svg>
    ),
  },
  {
    title: 'Protocol Normalization',
    description:
      'Speaks every protocol — MCP, REST, GraphQL, JSON-RPC, CLI, Webhooks, and Server-Sent Events. One interface, any backend.',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
    ),
  },
  {
    title: 'Observability',
    description:
      'Full metrics, cost tracking per provider and model, structured logging with Winston, and OpenTelemetry-ready instrumentation built in from day one.',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
      </svg>
    ),
  },
];

const stats = [
  { label: 'Protocols Supported', value: '10+' },
  { label: 'Tool Registry Sources', value: '100+' },
  { label: 'Security', value: 'Enterprise-Grade' },
  { label: 'Provisioning', value: 'Zero-Touch' },
];

const providers = ['OpenAI', 'Anthropic', 'Google', 'Azure', 'Cohere', 'Mistral', 'Ollama'];

const testimonials = [
  {
    quote: 'MCP Hub cut our AI integration time from weeks to hours. Auto-discovery alone is worth the switch.',
    author: 'Engineering Lead',
    company: 'Platform Team',
  },
  {
    quote: 'The policy engine gives our security team the control they need without slowing down developers.',
    author: 'Security Architect',
    company: 'Enterprise',
  },
  {
    quote: 'Cost monitoring per model changed how we budget AI spend. We reduced waste by 40% in the first month.',
    author: 'CTO',
    company: 'AI-first Startup',
  },
];

export default function HomePage() {
  return (
    <>
      {/* Hero */}
      <section className="relative overflow-hidden bg-gradient-to-br from-white via-indigo-50 to-white dark:from-gray-950 dark:via-indigo-950/30 dark:to-gray-950 py-20 md:py-32">
        <div className="absolute inset-0 bg-grid-pattern opacity-5 dark:opacity-10" aria-hidden="true" />
        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 mb-6 border border-indigo-200 dark:border-indigo-800">
            <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse" aria-hidden="true" />
            Open Source · Apache-2.0
          </div>
          <h1 className="text-4xl sm:text-5xl md:text-6xl font-extrabold tracking-tight text-gray-900 dark:text-white mb-6">
            The Universal<br />
            <span className="text-indigo-600 dark:text-indigo-400">MCP Orchestration Hub</span>
          </h1>
          <p className="max-w-2xl mx-auto text-lg sm:text-xl text-gray-600 dark:text-gray-400 mb-10">
            Auto-discover, provision, route, and secure any MCP-compatible tool or AI provider.
            One platform. Every protocol. Enterprise-grade from day one.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-4">
            <Link
              href="/docs"
              className="px-6 py-3 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 shadow-lg shadow-indigo-500/25"
            >
              Get Started →
            </Link>
            <a
              href="https://github.com/UniversalStandards/IDEA"
              target="_blank"
              rel="noopener noreferrer"
              className="px-6 py-3 rounded-lg border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 font-semibold hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
            >
              View on GitHub
            </a>
            <Link
              href="/features"
              className="px-6 py-3 rounded-lg text-indigo-600 dark:text-indigo-400 font-semibold hover:bg-indigo-50 dark:hover:bg-indigo-950/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
            >
              View Demo ↗
            </Link>
          </div>
        </div>
      </section>

      {/* Stats */}
      <section className="bg-indigo-600 dark:bg-indigo-900" aria-label="Key statistics">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
          <dl className="grid grid-cols-2 md:grid-cols-4 gap-8 text-center">
            {stats.map((s) => (
              <div key={s.label}>
                <dt className="text-sm font-medium text-indigo-200 dark:text-indigo-400 mb-1">{s.label}</dt>
                <dd className="text-2xl sm:text-3xl font-bold text-white">{s.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* Features grid */}
      <section className="py-20 md:py-28 bg-white dark:bg-gray-950" aria-labelledby="features-heading">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <h2 id="features-heading" className="text-3xl sm:text-4xl font-bold text-gray-900 dark:text-white mb-4">
              Everything you need to orchestrate AI
            </h2>
            <p className="text-lg text-gray-600 dark:text-gray-400 max-w-2xl mx-auto">
              Built for engineering teams that need reliability, security, and speed at every layer of the AI stack.
            </p>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-8">
            {features.map((f) => (
              <div
                key={f.title}
                className="group p-6 rounded-2xl border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 hover:border-indigo-300 dark:hover:border-indigo-700 hover:shadow-md transition-all"
              >
                <div className="w-12 h-12 rounded-xl bg-indigo-100 dark:bg-indigo-900/40 flex items-center justify-center text-indigo-600 dark:text-indigo-400 mb-4 group-hover:bg-indigo-600 group-hover:text-white dark:group-hover:bg-indigo-600 transition-colors">
                  {f.icon}
                </div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">{f.title}</h3>
                <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed">{f.description}</p>
              </div>
            ))}
          </div>
          <div className="mt-10 text-center">
            <Link
              href="/features"
              className="inline-flex items-center gap-2 text-indigo-600 dark:text-indigo-400 font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded"
            >
              Explore all features →
            </Link>
          </div>
        </div>
      </section>

      {/* Architecture Diagram */}
      <section className="py-20 bg-gray-50 dark:bg-gray-900" aria-labelledby="arch-heading">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 id="arch-heading" className="text-3xl sm:text-4xl font-bold text-gray-900 dark:text-white mb-4">
              How it works
            </h2>
            <p className="text-lg text-gray-600 dark:text-gray-400">A clean separation of concerns at every layer.</p>
          </div>
          <div className="bg-white dark:bg-gray-950 rounded-2xl border border-gray-200 dark:border-gray-800 p-8 overflow-x-auto">
            <svg
              viewBox="0 0 720 340"
              xmlns="http://www.w3.org/2000/svg"
              role="img"
              aria-label="Architecture diagram: Clients connect to the Universal MCP Hub which routes through Discovery, Policy, Routing, Provisioning, and Observability modules to reach AI Providers and Tools"
              className="w-full max-w-3xl mx-auto"
            >
              <rect x="10" y="120" width="110" height="100" rx="10" className="fill-blue-50 dark:fill-blue-950 stroke-blue-300 dark:stroke-blue-700" strokeWidth="1.5" />
              <text x="65" y="145" textAnchor="middle" className="fill-blue-700 dark:fill-blue-300" fontSize="11" fontWeight="600">Clients</text>
              <text x="65" y="163" textAnchor="middle" className="fill-blue-500 dark:fill-blue-400" fontSize="9">REST / MCP</text>
              <text x="65" y="178" textAnchor="middle" className="fill-blue-500 dark:fill-blue-400" fontSize="9">GraphQL</text>
              <text x="65" y="193" textAnchor="middle" className="fill-blue-500 dark:fill-blue-400" fontSize="9">JSON-RPC</text>
              <text x="65" y="208" textAnchor="middle" className="fill-blue-500 dark:fill-blue-400" fontSize="9">CLI</text>
              <path d="M120 170 L185 170" className="stroke-gray-400 dark:stroke-gray-600" strokeWidth="2" markerEnd="url(#arrow)" />
              <rect x="185" y="80" width="150" height="180" rx="12" className="fill-indigo-100 dark:fill-indigo-950 stroke-indigo-400 dark:stroke-indigo-600" strokeWidth="2" />
              <text x="260" y="108" textAnchor="middle" className="fill-indigo-700 dark:fill-indigo-300" fontSize="12" fontWeight="700">MCP Hub</text>
              <text x="260" y="126" textAnchor="middle" className="fill-indigo-500 dark:fill-indigo-400" fontSize="9">Universal</text>
              <text x="260" y="141" textAnchor="middle" className="fill-indigo-500 dark:fill-indigo-400" fontSize="9">Orchestration</text>
              <line x1="200" y1="155" x2="320" y2="155" className="stroke-indigo-300 dark:stroke-indigo-700" strokeWidth="1" strokeDasharray="4 2" />
              <text x="260" y="172" textAnchor="middle" className="fill-indigo-600 dark:fill-indigo-400" fontSize="9">• Normalization</text>
              <text x="260" y="188" textAnchor="middle" className="fill-indigo-600 dark:fill-indigo-400" fontSize="9">• Policy Engine</text>
              <text x="260" y="204" textAnchor="middle" className="fill-indigo-600 dark:fill-indigo-400" fontSize="9">• Router</text>
              <text x="260" y="220" textAnchor="middle" className="fill-indigo-600 dark:fill-indigo-400" fontSize="9">• Provisioner</text>
              <text x="260" y="236" textAnchor="middle" className="fill-indigo-600 dark:fill-indigo-400" fontSize="9">• Observability</text>
              <path d="M335 130 L400 100" className="stroke-gray-400 dark:stroke-gray-600" strokeWidth="2" markerEnd="url(#arrow)" />
              <path d="M335 170 L400 170" className="stroke-gray-400 dark:stroke-gray-600" strokeWidth="2" markerEnd="url(#arrow)" />
              <path d="M335 210 L400 240" className="stroke-gray-400 dark:stroke-gray-600" strokeWidth="2" markerEnd="url(#arrow)" />
              <rect x="400" y="60" width="140" height="70" rx="10" className="fill-green-50 dark:fill-green-950 stroke-green-300 dark:stroke-green-700" strokeWidth="1.5" />
              <text x="470" y="84" textAnchor="middle" className="fill-green-700 dark:fill-green-300" fontSize="11" fontWeight="600">AI Providers</text>
              <text x="470" y="100" textAnchor="middle" className="fill-green-500 dark:fill-green-400" fontSize="9">OpenAI · Anthropic</text>
              <text x="470" y="115" textAnchor="middle" className="fill-green-500 dark:fill-green-400" fontSize="9">Google · Azure · Ollama</text>
              <rect x="400" y="145" width="140" height="50" rx="10" className="fill-purple-50 dark:fill-purple-950 stroke-purple-300 dark:stroke-purple-700" strokeWidth="1.5" />
              <text x="470" y="167" textAnchor="middle" className="fill-purple-700 dark:fill-purple-300" fontSize="11" fontWeight="600">Discovery</text>
              <text x="470" y="183" textAnchor="middle" className="fill-purple-500 dark:fill-purple-400" fontSize="9">GitHub · MCP Registry</text>
              <rect x="400" y="210" width="140" height="70" rx="10" className="fill-orange-50 dark:fill-orange-950 stroke-orange-300 dark:stroke-orange-700" strokeWidth="1.5" />
              <text x="470" y="234" textAnchor="middle" className="fill-orange-700 dark:fill-orange-300" fontSize="11" fontWeight="600">Tools</text>
              <text x="470" y="250" textAnchor="middle" className="fill-orange-500 dark:fill-orange-400" fontSize="9">MCP · REST · GraphQL</text>
              <text x="470" y="265" textAnchor="middle" className="fill-orange-500 dark:fill-orange-400" fontSize="9">CLI · Webhooks · SSE</text>
              <defs>
                <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                  <path d="M0,0 L0,6 L8,3 z" className="fill-gray-400 dark:fill-gray-600" />
                </marker>
              </defs>
            </svg>
          </div>
        </div>
      </section>

      {/* Providers */}
      <section className="py-16 bg-white dark:bg-gray-950" aria-labelledby="providers-heading">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 id="providers-heading" className="text-center text-sm font-semibold uppercase tracking-widest text-gray-500 dark:text-gray-400 mb-8">
            Works with every major AI provider
          </h2>
          <div className="flex flex-wrap justify-center gap-4 md:gap-8">
            {providers.map((p) => (
              <span
                key={p}
                className="px-5 py-2.5 rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 font-semibold text-sm border border-gray-200 dark:border-gray-700"
              >
                {p}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* Testimonials */}
      <section className="py-20 bg-gray-50 dark:bg-gray-900" aria-labelledby="testimonials-heading">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 id="testimonials-heading" className="text-3xl font-bold text-gray-900 dark:text-white text-center mb-12">
            Trusted by engineering teams
          </h2>
          <div className="grid md:grid-cols-3 gap-6">
            {testimonials.map((t, i) => (
              <blockquote
                key={i}
                className="p-6 rounded-2xl bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 shadow-sm"
              >
                <p className="text-gray-700 dark:text-gray-300 italic mb-4">&ldquo;{t.quote}&rdquo;</p>
                <footer>
                  <cite className="not-italic">
                    <span className="block font-semibold text-gray-900 dark:text-white text-sm">{t.author}</span>
                    <span className="text-gray-500 dark:text-gray-400 text-xs">{t.company}</span>
                  </cite>
                </footer>
              </blockquote>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-20 bg-indigo-600 dark:bg-indigo-900" aria-labelledby="cta-heading">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h2 id="cta-heading" className="text-3xl sm:text-4xl font-bold text-white mb-4">
            Ready to orchestrate your AI stack?
          </h2>
          <p className="text-indigo-200 mb-8 text-lg">
            Open source, Apache-2.0 licensed, and ready for production. Get started in minutes.
          </p>
          <div className="flex flex-wrap justify-center gap-4">
            <Link
              href="/docs"
              className="px-6 py-3 rounded-lg bg-white text-indigo-700 font-semibold hover:bg-indigo-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-indigo-600"
            >
              Read the Docs →
            </Link>
            <a
              href="https://github.com/UniversalStandards/IDEA"
              target="_blank"
              rel="noopener noreferrer"
              className="px-6 py-3 rounded-lg border border-indigo-300 text-white font-semibold hover:bg-indigo-500 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-indigo-600"
            >
              Star on GitHub ★
            </a>
          </div>
        </div>
      </section>
    </>
  );
}
