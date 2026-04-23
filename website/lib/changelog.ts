import fs from 'fs';
import path from 'path';
import { marked } from 'marked';

export function getChangelog(): string {
  const filePath = path.resolve(process.cwd(), '..', 'CHANGELOG.md');
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    content = '# Changelog\n\nNo changelog available.';
  }
  const result = marked.parse(content);
  return typeof result === 'string' ? result : 'No changelog available.';
}
