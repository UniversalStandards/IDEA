import chalk from 'chalk';
import Table from 'cli-table3';

export interface CapabilitySearchResult {
  id: string;
  name: string;
  description: string;
  installCommand: string;
}

export function renderCapabilitiesTable(results: CapabilitySearchResult[]): string {
  if (results.length === 0) {
    return chalk.yellow('No capabilities found.');
  }

  const table = new Table({
    head: [chalk.cyan('ID'), chalk.cyan('Description'), chalk.cyan('Install')],
    wordWrap: true,
    colWidths: [34, 58, 48],
  });

  for (const result of results) {
    table.push([result.id, result.description, chalk.gray(result.installCommand)]);
  }

  return table.toString();
}

export function renderCapabilitiesJson(results: CapabilitySearchResult[]): string {
  return JSON.stringify(results, null, 2);
}
