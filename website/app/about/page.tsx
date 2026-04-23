import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'About',
  description: 'Learn about the Universal MCP Orchestration Hub — mission, team, contributing, and license.',
};

export default function AboutPage() {
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
      <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-6">About</h1>

      <section className="mb-12" aria-labelledby="mission-heading">
        <h2 id="mission-heading" className="text-2xl font-bold text-gray-900 dark:text-white mb-4">Our Mission</h2>
        <p className="text-gray-600 dark:text-gray-400 leading-relaxed mb-4">
          AI tooling is fragmented. Every provider has a different API. Every tool has a different installation process.
          Every team builds the same integration glue from scratch — auth, retry logic, cost tracking, policy enforcement.
        </p>
        <p className="text-gray-600 dark:text-gray-400 leading-relaxed mb-4">
          The Universal MCP Orchestration Hub exists to fix that. We believe the orchestration layer — discovery,
          provisioning, routing, normalization, security — should be solved <em>once</em>, open sourced, and shared by
          the entire ecosystem.
        </p>
        <p className="text-gray-600 dark:text-gray-400 leading-relaxed">
          When the plumbing is handled, teams can focus on building the things that actually matter.
        </p>
      </section>

      <section className="mb-12" aria-labelledby="project-heading">
        <h2 id="project-heading" className="text-2xl font-bold text-gray-900 dark:text-white mb-4">The Project</h2>
        <div className="grid sm:grid-cols-2 gap-4">
          {[
            { label: 'Repository', value: 'UniversalStandards/IDEA', href: 'https://github.com/UniversalStandards/IDEA' },
            { label: 'Language', value: 'TypeScript (strict)' },
            { label: 'Runtime', value: 'Node.js ≥ 20.0.0' },
            { label: 'License', value: 'Apache-2.0', href: 'https://github.com/UniversalStandards/IDEA/blob/main/LICENSE' },
          ].map((item) => (
            <div key={item.label} className="p-4 rounded-xl bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800">
              <dt className="text-xs font-semibold uppercase tracking-widest text-gray-500 dark:text-gray-400 mb-1">
                {item.label}
              </dt>
              <dd className="font-mono text-sm text-gray-900 dark:text-white">
                {'href' in item && item.href ? (
                  <a href={item.href} target="_blank" rel="noopener noreferrer" className="text-indigo-600 dark:text-indigo-400 hover:underline">
                    {item.value}
                  </a>
                ) : (
                  item.value
                )}
              </dd>
            </div>
          ))}
        </div>
      </section>

      <section className="mb-12" aria-labelledby="contributing-heading">
        <h2 id="contributing-heading" className="text-2xl font-bold text-gray-900 dark:text-white mb-4">Contributing</h2>
        <p className="text-gray-600 dark:text-gray-400 leading-relaxed mb-4">
          MCP Hub is built in the open. All contributions — bug reports, documentation improvements, new protocol
          adapters, policy packs, and feature ideas — are welcome.
        </p>
        <div className="flex flex-wrap gap-3">
          <a
            href="https://github.com/UniversalStandards/IDEA/blob/main/CONTRIBUTING.md"
            target="_blank"
            rel="noopener noreferrer"
            className="px-4 py-2 rounded-lg bg-indigo-600 text-white font-medium text-sm hover:bg-indigo-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            Contribution Guide →
          </a>
          <a
            href="https://github.com/UniversalStandards/IDEA/issues"
            target="_blank"
            rel="noopener noreferrer"
            className="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 font-medium text-sm hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            Open an Issue
          </a>
          <a
            href="https://github.com/UniversalStandards/IDEA/discussions"
            target="_blank"
            rel="noopener noreferrer"
            className="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 font-medium text-sm hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            Discussions
          </a>
        </div>
      </section>

      <section id="license" aria-labelledby="license-heading" className="p-6 rounded-2xl bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800">
        <h2 id="license-heading" className="text-xl font-bold text-gray-900 dark:text-white mb-3">License</h2>
        <p className="text-gray-600 dark:text-gray-400 text-sm leading-relaxed mb-3">
          Universal MCP Orchestration Hub is released under the{' '}
          <strong className="text-gray-900 dark:text-white">Apache License, Version 2.0</strong>.
          You are free to use, modify, and distribute this software for any purpose, including commercial use,
          provided you include the required attribution and license notices.
        </p>
        <a
          href="https://github.com/UniversalStandards/IDEA/blob/main/LICENSE"
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded"
        >
          View full license text ↗
        </a>
      </section>
    </div>
  );
}
