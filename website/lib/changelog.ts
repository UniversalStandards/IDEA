import fs from 'fs';
import path from 'path';
import { Marked } from 'marked';
import DOMPurify from 'isomorphic-dompurify';

const markedInstance = new Marked();

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
  const html = markedInstance.parse(content);
  // Sanitize to guard against XSS if CHANGELOG.md ever contains unsafe HTML
  // (defense in depth — content is a trusted local file but sanitization is cheap)
  return DOMPurify.sanitize(typeof html === 'string' ? html : '');
}
