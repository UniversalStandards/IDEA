# Contributing to Universal MCP Orchestration Hub

Thank you for your interest in contributing. This guide covers everything you need to get started, submit high-quality contributions, and work within the project's standards.

## Prerequisites

- **Node.js** >= 20.0.0 ([nvm](https://github.com/nvm-sh/nvm) recommended; `.nvmrc` included)
- **npm** >= 10.0.0
- **Git** >= 2.40

## Local Setup

```bash
git clone https://github.com/UniversalStandards/IDEA.git
cd IDEA
nvm use
npm ci
cp .env.example .env
# Edit .env with your values
npm run dev
```

## Project Structure

| Directory | Responsibility |
|---|---|
| `src/core/` | HTTP server, MCP transport, lifecycle |
| `src/types/` | Shared TypeScript interfaces and enums |
| `src/normalization/` | Request normalization + protocol adapters |
| `src/discovery/` | Registry connectors and discovery manager |
| `src/provisioning/` | Package installer, dependency resolver, registrar |
| `src/routing/` | Provider router, scheduler, capability selector |
| `src/policy/` | Policy engine, trust evaluator, approval gates |
| `src/security/` | Cryptography, audit logging, credential broker |
| `src/orchestration/` | Task graph, workflow engine, agent router |
| `src/observability/` | Logger, metrics, tracing, cost monitor |
| `src/adapters/` | MCP, REST, GraphQL, CLI, Events adapters |
| `src/api/` | Admin API, health, status endpoints |
| `tests/` | Jest test suite |
| `docs/` | Architecture, security, API, deployment guides |
| `policies/` | JSON policy pack definitions |

## Branch Naming

```
feat/<scope>     New features
fix/<scope>      Bug fixes
chore/<scope>    Maintenance
docs/<scope>     Documentation only
test/<scope>     Test coverage
refactor/<scope> Refactoring
```

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):
```
<type>(<scope>): <description>

Closes #123
```

Types: `feat`, `fix`, `chore`, `docs`, `test`, `refactor`, `perf`, `ci`, `build`

## Running Tests

```bash
npm test                 # Run all tests
npm run test:watch       # Watch mode
npm run test:coverage    # With coverage report
npm run test:ci          # CI mode (used in GitHub Actions)
```

## Code Standards

- **TypeScript strict mode** — all `tsconfig.json` strict flags enabled
- **No `any` type** — use `unknown` and narrow explicitly; ESLint error
- **No `console.*`** — use `src/observability/logger.ts`
- **No `eval()` or `new Function()`**
- **Explicit return types** on all exported functions
- **`unknown` in catch blocks**, never `any`
- **`import type`** for type-only imports
- Run `npm run lint:fix` to auto-fix issues

## Adding a New Module

1. Create `src/<module>/` directory
2. Add `index.ts` barrel with public API exports
3. Add `types.ts` for module-local types if needed
4. Create `tests/<module-name>.test.ts` (>= 70% coverage required)
5. If stateful, register in `src/core/runtime-manager.ts`
6. Add lifecycle hook in `src/core/lifecycle.ts` for graceful shutdown
7. Add env vars to `src/config.ts` and `.env.example`

## Adding a New Adapter

1. Create `src/adapters/<protocol>/index.ts`
2. Implement the `IAdapter` interface from `src/types/index.ts`
3. Register in `src/core/server.ts`
4. Add env vars to `src/config.ts` and `.env.example`
5. Write tests in `tests/<protocol>-adapter.test.ts`
6. Document in `docs/api.md`

## Security

- Never commit secrets — `.env` is gitignored
- All secrets through `src/config.ts` via Zod-validated env vars
- Never use `child_process.exec` — always `spawn` with explicit arg arrays
- Sanitize all filesystem paths with `path.resolve()` and boundary checks
- Report vulnerabilities privately — see [SECURITY.md](SECURITY.md)

## Questions?

Open a [GitHub Discussion](https://github.com/UniversalStandards/IDEA/discussions).
