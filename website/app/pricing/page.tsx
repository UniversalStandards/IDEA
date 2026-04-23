import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Pricing',
  description: 'Universal MCP Hub pricing — free self-hosted tier, managed Pro at $49/mo, and Enterprise plans with SLAs.',
};

const tiers = [
  {
    name: 'Free',
    price: '$0',
    period: 'forever',
    description: 'Self-hosted. Full core functionality. Community support.',
    cta: 'Get started for free',
    ctaHref: '/docs',
    highlight: false,
    features: [
      'Full MCP Hub core',
      'All 6 protocol adapters',
      'Multi-provider routing',
      'Auto-discovery (GitHub + MCP registry)',
      'Policy engine',
      'Structured logging & metrics',
      'Community support (GitHub Issues)',
      'Apache-2.0 open source',
    ],
  },
  {
    name: 'Pro',
    price: '$49',
    period: 'per month',
    description: 'Managed cloud hosting, priority support, and advanced features.',
    cta: 'Start Pro trial',
    ctaHref: 'https://github.com/UniversalStandards/IDEA',
    highlight: true,
    features: [
      'Everything in Free',
      'Managed cloud hosting',
      'Enterprise catalog connector',
      'Cost monitoring dashboard',
      'Advanced approval workflows',
      'Daily cost budget alerts',
      'Priority email support (< 24h)',
      'SSO integration',
      '99.9% uptime SLA',
    ],
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    period: 'contact us',
    description: 'Dedicated deployment, enterprise SLAs, and white-glove support.',
    cta: 'Contact sales',
    ctaHref: 'https://github.com/UniversalStandards/IDEA/issues',
    highlight: false,
    features: [
      'Everything in Pro',
      'Dedicated cloud or on-prem deployment',
      'Custom SLA (99.99% uptime)',
      'Dedicated support engineer',
      'Custom policy pack development',
      'SAML/OIDC SSO',
      'Audit log export & SIEM integration',
      'Quarterly architecture review',
      'Volume licensing',
    ],
  },
];

const featureMatrix = [
  { feature: 'Protocol adapters (MCP, REST, GraphQL, etc.)', free: true, pro: true, enterprise: true },
  { feature: 'Auto-discovery (GitHub + MCP registry)', free: true, pro: true, enterprise: true },
  { feature: 'Multi-provider routing', free: true, pro: true, enterprise: true },
  { feature: 'Policy engine', free: true, pro: true, enterprise: true },
  { feature: 'Observability & metrics', free: true, pro: true, enterprise: true },
  { feature: 'Enterprise catalog connector', free: false, pro: true, enterprise: true },
  { feature: 'Cost monitoring dashboard', free: false, pro: true, enterprise: true },
  { feature: 'Managed cloud hosting', free: false, pro: true, enterprise: true },
  { feature: 'Priority support', free: false, pro: true, enterprise: true },
  { feature: 'Custom SLA', free: false, pro: false, enterprise: true },
  { feature: 'Dedicated deployment', free: false, pro: false, enterprise: true },
  { feature: 'SIEM integration', free: false, pro: false, enterprise: true },
];

const faqs = [
  {
    q: 'Is the free tier really free forever?',
    a: 'Yes. The free tier is the open-source version of MCP Hub. You self-host it, and it has no feature limits or expiry. The Apache-2.0 license allows commercial use.',
  },
  {
    q: 'What does "managed cloud" mean for Pro?',
    a: 'We host and operate your MCP Hub instance — updates, backups, scaling, and monitoring are all handled for you. You connect via the REST or MCP API.',
  },
  {
    q: 'Can I migrate from free (self-hosted) to Pro?',
    a: 'Yes. Your configuration, policies, and capability registry are fully portable. We provide a migration CLI that exports your local config and imports it into the managed cloud.',
  },
  {
    q: 'Do you offer academic or open-source discounts?',
    a: 'Yes. Academic institutions and qualifying open-source projects can apply for a 50% discount on the Pro tier. Contact us via GitHub Issues.',
  },
  {
    q: 'What is included in the Enterprise SLA?',
    a: 'Enterprise SLAs include 99.99% monthly uptime, < 1 hour response time for P1 incidents, a dedicated Slack channel, and a named support engineer.',
  },
];

export default function PricingPage() {
  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
      <div className="text-center mb-16">
        <h1 className="text-4xl sm:text-5xl font-bold text-gray-900 dark:text-white mb-4">
          Simple, transparent pricing
        </h1>
        <p className="text-xl text-gray-600 dark:text-gray-400 max-w-2xl mx-auto">
          Start free. Scale as you grow. No surprises.
        </p>
      </div>

      <div className="grid md:grid-cols-3 gap-8 mb-20">
        {tiers.map((tier) => (
          <div
            key={tier.name}
            className={`relative rounded-2xl p-8 flex flex-col ${
              tier.highlight
                ? 'bg-indigo-600 dark:bg-indigo-700 text-white shadow-2xl shadow-indigo-500/30 ring-2 ring-indigo-500'
                : 'bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800'
            }`}
          >
            {tier.highlight && (
              <div className="absolute -top-4 left-1/2 -translate-x-1/2">
                <span className="px-3 py-1 rounded-full bg-yellow-400 text-yellow-900 text-xs font-bold uppercase tracking-wide">
                  Most Popular
                </span>
              </div>
            )}
            <div className="mb-6">
              <h2 className={`text-xl font-bold mb-1 ${tier.highlight ? 'text-white' : 'text-gray-900 dark:text-white'}`}>
                {tier.name}
              </h2>
              <div className="flex items-baseline gap-1 mb-2">
                <span className={`text-4xl font-extrabold ${tier.highlight ? 'text-white' : 'text-gray-900 dark:text-white'}`}>
                  {tier.price}
                </span>
                <span className={`text-sm ${tier.highlight ? 'text-indigo-200' : 'text-gray-500 dark:text-gray-400'}`}>
                  / {tier.period}
                </span>
              </div>
              <p className={`text-sm ${tier.highlight ? 'text-indigo-200' : 'text-gray-500 dark:text-gray-400'}`}>
                {tier.description}
              </p>
            </div>

            <ul className="space-y-3 mb-8 flex-1">
              {tier.features.map((f) => (
                <li key={f} className="flex items-start gap-2 text-sm">
                  <svg className={`w-5 h-5 flex-shrink-0 mt-0.5 ${tier.highlight ? 'text-indigo-200' : 'text-green-500'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  <span className={tier.highlight ? 'text-indigo-100' : 'text-gray-600 dark:text-gray-400'}>{f}</span>
                </li>
              ))}
            </ul>

            <a
              href={tier.ctaHref}
              className={`block text-center px-6 py-3 rounded-lg font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${
                tier.highlight
                  ? 'bg-white text-indigo-700 hover:bg-indigo-50 focus-visible:ring-white focus-visible:ring-offset-indigo-600'
                  : 'bg-indigo-600 dark:bg-indigo-700 text-white hover:bg-indigo-700 dark:hover:bg-indigo-600 focus-visible:ring-indigo-500'
              }`}
            >
              {tier.cta}
            </a>
          </div>
        ))}
      </div>

      <section aria-labelledby="matrix-heading" className="mb-20">
        <h2 id="matrix-heading" className="text-2xl font-bold text-gray-900 dark:text-white text-center mb-8">
          Full feature comparison
        </h2>
        <div className="overflow-x-auto rounded-2xl border border-gray-200 dark:border-gray-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-900">
                <th className="text-left px-6 py-4 font-semibold text-gray-700 dark:text-gray-300">Feature</th>
                <th className="text-center px-6 py-4 font-semibold text-gray-700 dark:text-gray-300">Free</th>
                <th className="text-center px-6 py-4 font-semibold text-indigo-600 dark:text-indigo-400">Pro</th>
                <th className="text-center px-6 py-4 font-semibold text-gray-700 dark:text-gray-300">Enterprise</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {featureMatrix.map((row) => (
                <tr key={row.feature} className="bg-white dark:bg-gray-950 hover:bg-gray-50 dark:hover:bg-gray-900 transition-colors">
                  <td className="px-6 py-3 text-gray-700 dark:text-gray-300">{row.feature}</td>
                  {(['free', 'pro', 'enterprise'] as const).map((tier) => (
                    <td key={tier} className="px-6 py-3 text-center">
                      {row[tier] ? (
                        <svg className="w-5 h-5 text-green-500 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-label="Included" role="img"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                      ) : (
                        <svg className="w-5 h-5 text-gray-300 dark:text-gray-700 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-label="Not included" role="img"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="faq-heading">
        <h2 id="faq-heading" className="text-2xl font-bold text-gray-900 dark:text-white text-center mb-8">
          Frequently asked questions
        </h2>
        <div className="max-w-2xl mx-auto space-y-6">
          {faqs.map((faq, i) => (
            <div key={i} className="p-6 rounded-2xl bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800">
              <h3 className="font-semibold text-gray-900 dark:text-white mb-2">{faq.q}</h3>
              <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed">{faq.a}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
