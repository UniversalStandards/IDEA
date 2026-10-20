#!/usr/bin/env node
/**
 * src/index.ts
 * Entry point: load .env, validate configuration, then start the hub.
 */

// Must stay first: loads .env before any module reads process.env.
import './env';
import { validateConfig } from './config';

try {
  validateConfig();
} catch (err) {
  // Plain stderr on purpose: the logger is not loaded yet, and stdout may be
  // an MCP stdio channel.
  process.stderr.write(
    `[universal-standard-mcp-server] ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}

import('./main')
  .then(({ main, reportFatal }) =>
    main().catch((err: unknown) => {
      reportFatal(err);
      process.exit(1);
    }),
  )
  .catch((err: unknown) => {
    process.stderr.write(
      `[universal-standard-mcp-server] Fatal startup error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
