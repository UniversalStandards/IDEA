import { Command } from 'commander';
import { registerCapabilitiesSearchCommand } from './commands/capabilities/search';

export function buildProgram(): Command {
  const program = new Command();

  program.name('hub').description('Operator CLI for Universal MCP Hub').version('0.1.0');

  const caps = program.command('caps').description('Capability management commands');
  registerCapabilitiesSearchCommand(caps);

  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(process.argv);
}

void main();
