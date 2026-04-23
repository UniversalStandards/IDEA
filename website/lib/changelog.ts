import fs from 'fs';
import path from 'path';
import { Marked } from 'marked';

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
  // Source is a trusted local file — synchronous parse via Marked instance
  const result = markedInstance.parse(content);
  return typeof result === 'string' ? result : '# Changelog\n\nNo changelog available.';
}
