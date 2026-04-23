import Link from 'next/link';

const links = {
  Product: [
    { href: '/features', label: 'Features' },
    { href: '/pricing', label: 'Pricing' },
    { href: '/changelog', label: 'Changelog' },
  ],
  Developers: [
    { href: '/docs', label: 'Documentation' },
    { href: 'https://github.com/UniversalStandards/IDEA', label: 'GitHub', external: true },
    { href: 'https://github.com/UniversalStandards/IDEA/issues', label: 'Issues', external: true },
  ],
  Company: [
    { href: '/about', label: 'About' },
    { href: '/about#license', label: 'License' },
    { href: 'https://github.com/UniversalStandards/IDEA/blob/main/SECURITY.md', label: 'Security', external: true },
  ],
};

export default function Footer() {
  return (
    <footer className="border-t border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
          <div className="col-span-2 md:col-span-1">
            <p className="font-bold text-lg text-indigo-600 dark:text-indigo-400 mb-2">MCP Hub</p>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              The universal orchestration layer for AI tools and providers.
            </p>
            <p className="text-sm text-gray-400 dark:text-gray-500 mt-4">
              Apache-2.0 License
            </p>
          </div>
          {Object.entries(links).map(([section, items]) => (
            <div key={section}>
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">{section}</h3>
              <ul className="space-y-2">
                {items.map((item) => (
                  <li key={item.href}>
                    {'external' in item && item.external ? (
                      <a
                        href={item.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
                      >
                        {item.label} ↗
                      </a>
                    ) : (
                      <Link
                        href={item.href}
                        className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
                      >
                        {item.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="mt-8 pt-8 border-t border-gray-200 dark:border-gray-800 flex flex-col sm:flex-row justify-between items-center gap-4">
          <p className="text-sm text-gray-400 dark:text-gray-500">
            © {new Date().getFullYear()} Universal Standards. All rights reserved.
          </p>
          <p className="text-sm text-gray-400 dark:text-gray-500">
            Built with Next.js &amp; Tailwind CSS
          </p>
        </div>
      </div>
    </footer>
  );
}
