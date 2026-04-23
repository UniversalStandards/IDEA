import type { Metadata } from 'next';
import { getChangelog } from '@/lib/changelog';

export const metadata: Metadata = {
  title: 'Changelog',
  description: 'Release history and change log for the Universal MCP Orchestration Hub.',
};

export default function ChangelogPage() {
  const html = getChangelog();

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-4xl font-bold text-gray-900 dark:text-white">Changelog</h1>
        <a
          href="/rss.xml"
          aria-label="RSS feed (coming soon)"
          className="flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400 hover:text-orange-500 dark:hover:text-orange-400 transition-colors"
        >
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6.18 15.64a2.18 2.18 0 0 1 2.18 2.18C8.36 19.01 7.38 20 6.18 20C4.98 20 4 19.01 4 17.82a2.18 2.18 0 0 1 2.18-2.18M4 4.44A15.56 15.56 0 0 1 19.56 20h-2.83A12.73 12.73 0 0 0 4 7.27V4.44m0 5.66a9.9 9.9 0 0 1 9.9 9.9h-2.83A7.07 7.07 0 0 0 4 12.93V10.1z" />
          </svg>
          RSS feed (coming soon)
        </a>
      </div>
      <div
        className="prose prose-gray dark:prose-invert max-w-none prose-headings:font-bold prose-h2:text-2xl prose-h2:border-b prose-h2:border-gray-200 prose-h2:dark:border-gray-800 prose-h2:pb-2 prose-h2:mt-10 prose-h3:text-lg prose-code:text-indigo-600 prose-code:dark:text-indigo-400 prose-code:bg-gray-100 prose-code:dark:bg-gray-800 prose-code:rounded prose-code:px-1 prose-a:text-indigo-600 prose-a:dark:text-indigo-400"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
