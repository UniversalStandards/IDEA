import fs from 'fs';
import path from 'path';
import { marked } from 'marked';
import DOMPurify from 'isomorphic-dompurify';

function readChangelogContent(): string {
  // Try several candidate paths to handle different working directories (dev, build, CI)
  const candidates = [
    path.resolve(process.cwd(), '..', 'CHANGELOG.md'),
    path.resolve(process.cwd(), 'CHANGELOG.md'),
    path.resolve(__dirname, '..', '..', 'CHANGELOG.md'),
  ];
  for (const candidate of candidates) {
    try {
      return fs.readFileSync(candidate, 'utf-8');
    } catch {
      // Try next candidate
    }
  }
  return '# Changelog\n\nNo changelog available.';
}

export function getChangelog(): string {
  const content = readChangelogContent();
  const raw = marked.parse(content);
  const html = typeof raw === 'string' ? raw : 'No changelog available.';
  // Sanitize to prevent XSS in case the source file is ever modified to include unsafe HTML
  return DOMPurify.sanitize(html);
}
