/**
 * src/env.ts
 * Loads `.env` into process.env. Imported first by the entry point (before
 * any module that reads the environment at import time, e.g. the logger).
 *
 * `quiet: true` matters: dotenv >= 16.6 prints an "injecting env" banner to
 * stdout by default, and in stdio mode stdout is the MCP JSON-RPC channel —
 * a single stray line there breaks every MCP client.
 */

import { config as loadDotenv } from 'dotenv';

export function loadEnvironment(): void {
  loadDotenv({ quiet: true });
}

loadEnvironment();
