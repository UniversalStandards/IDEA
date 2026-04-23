import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Documentation',
  description: 'Get started with the Universal MCP Orchestration Hub. Quick-start guide, API reference, security, and deployment documentation.',
};

const quickStart = [
  { step: 1, title: 'Clone the repository', code: 'git clone https://github.com/UniversalStandards/IDEA.git\ncd IDEA' },
  { step: 2, title: 'Install dependencies', code: 'npm ci' },
  { step: 3, title: 'Copy and configure environment', code: 'cp .env.example .env\n# Edit .env with your provider API keys' },
  { step: 4, title: 'Start the hub', code: 'npm run dev' },
  { step: 5, title: 'Verify it is running', code: 'curl http://localhost:3000/health' },
];

const docSections = [
  {
    title: 'Architecture',
    description: 'System overview, component map, request lifecycle, and deployment topologies.',
    href: 'https://github.com/UniversalStandards/IDEA/blob/main/docs/architecture.md',
    icon: '🏗️',
    internal: false,
  },
  {
    title: 'API Reference',
    description: 'Complete REST Admin API documentation with request/response schemas and examples.',
    href: 'https://github.com/UniversalStandards/IDEA/blob/main/docs/api.md',
    icon: '📡',
    internal: false,
  },
  {
    title: 'Security Guide',
    description: 'Trust pipeline, credential broker, audit logging, and key rotation procedures.',
    href: 'https://github.com/UniversalStandards/IDEA/blob/main/docs/security.md',
    icon: '🔒',
    internal: false,
  },
  {
    title: 'Deployment',
    description: 'Docker, Kubernetes, environment variables reference, and health check configuration.',
    href: 'https://github.com/UniversalStandards/IDEA/blob/main/docs/deployment.md',
    icon: '🚀',
    internal: false,
  },
  {
    title: 'Contributing',
    description: 'Local setup, branch conventions, testing, and how to add new adapters or modules.',
    href: 'https://github.com/UniversalStandards/IDEA/blob/main/CONTRIBUTING.md',
    icon: '🤝',
    internal: false,
  },
  {
    title: 'Changelog',
    description: 'Full release history, following the Keep a Changelog format.',
    href: '/changelog',
    icon: '📋',
    internal: true,
  },
];

export default function DocsPage() {
  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
      <div className="mb-12">
        <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-4">Documentation</h1>
        <p className="text-xl text-gray-600 dark:text-gray-400">
          Everything you need to deploy, configure, and extend the Universal MCP Orchestration Hub.
        </p>
      </div>

      <div className="mb-12 p-4 rounded-xl border border-dashed border-indigo-300 dark:border-indigo-700 bg-indigo-50/50 dark:bg-indigo-950/30">
        <div className="flex items-center gap-3">
          <svg className="w-5 h-5 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="8" strokeWidth="2" />
            <path d="m21 21-4.35-4.35" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <span className="text-indigo-600 dark:text-indigo-400 font-medium">Search documentation</span>
          <span className="ml-auto text-xs text-indigo-400 dark:text-indigo-600">Powered by search — coming soon</span>
        </div>
      </div>

      <section aria-labelledby="quickstart-heading" className="mb-16">
        <h2 id="quickstart-heading" className="text-2xl font-bold text-gray-900 dark:text-white mb-6">Quick Start</h2>
        <ol className="space-y-4" aria-label="Quick start steps">
          {quickStart.map((s) => (
            <li key={s.step} className="flex gap-4">
              <div className="flex-shrink-0 w-8 h-8 rounded-full bg-indigo-600 text-white text-sm font-bold flex items-center justify-center">
                {s.step}
              </div>
              <div className="flex-1">
                <p className="font-semibold text-gray-900 dark:text-white mb-2">{s.title}</p>
                <pre className="bg-gray-900 dark:bg-black text-gray-100 rounded-lg px-4 py-3 text-sm overflow-x-auto">
                  <code>{s.code}</code>
                </pre>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="docsections-heading">
        <h2 id="docsections-heading" className="text-2xl font-bold text-gray-900 dark:text-white mb-6">Documentation Sections</h2>
        <div className="grid sm:grid-cols-2 gap-4">
          {docSections.map((s) => (
            <div key={s.title}>
              {s.internal ? (
                <Link
                  href={s.href}
                  className="group flex gap-4 p-5 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 hover:border-indigo-300 dark:hover:border-indigo-700 hover:shadow-md transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                >
                  <span className="text-2xl" aria-hidden="true">{s.icon}</span>
                  <div>
                    <h3 className="font-semibold text-gray-900 dark:text-white group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
                      {s.title}
                    </h3>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{s.description}</p>
                  </div>
                </Link>
              ) : (
                <a
                  href={s.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex gap-4 p-5 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 hover:border-indigo-300 dark:hover:border-indigo-700 hover:shadow-md transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                >
                  <span className="text-2xl" aria-hidden="true">{s.icon}</span>
                  <div>
                    <h3 className="font-semibold text-gray-900 dark:text-white group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
                      {s.title} ↗
                    </h3>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{s.description}</p>
                  </div>
                </a>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
