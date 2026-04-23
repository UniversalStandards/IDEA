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
        <span className="text-sm text-gray-500 dark:text-gray-400">
            RSS feed — coming soon
          </span>
      </div>
      <div
        className="prose prose-gray dark:prose-invert max-w-none prose-headings:font-bold prose-h2:text-2xl prose-h2:border-b prose-h2:border-gray-200 prose-h2:dark:border-gray-800 prose-h2:pb-2 prose-h2:mt-10 prose-h3:text-lg prose-code:text-indigo-600 prose-code:dark:text-indigo-400 prose-code:bg-gray-100 prose-code:dark:bg-gray-800 prose-code:rounded prose-code:px-1 prose-a:text-indigo-600 prose-a:dark:text-indigo-400"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
