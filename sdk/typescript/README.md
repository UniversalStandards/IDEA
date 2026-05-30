# @universalstandards/hub-sdk

TypeScript client SDK for the Universal MCP Orchestration Hub.

## Install

```bash
npm install @universalstandards/hub-sdk
```

## Quickstart

```ts
import { HubClient } from '@universalstandards/hub-sdk';

const hub = new HubClient({
  baseUrl: 'https://hub.spurs.gov',
  apiKey: process.env.HUB_KEY,
});

const capabilities = await hub.capabilities.search('filesystem');
console.log(capabilities);
```

## Authentication setup

### API key

```ts
const hub = new HubClient({
  baseUrl: 'https://hub.spurs.gov',
  apiKey: process.env.HUB_KEY,
});
```

### OAuth/JWT (auto refresh)

```ts
const hub = new HubClient({
  baseUrl: 'https://hub.spurs.gov',
  oauth: {
    accessToken: process.env.HUB_ACCESS_TOKEN!,
    refreshToken: process.env.HUB_REFRESH_TOKEN!,
    expiresAt: Date.now() + 30 * 60 * 1000,
    tokenEndpoint: 'https://hub.spurs.gov/auth/token',
  },
});
```

## Common examples

### 1) Connect

```ts
const hub = new HubClient({ baseUrl: 'https://hub.spurs.gov', apiKey: process.env.HUB_KEY });
```

### 2) Discover capabilities

```ts
const caps = await hub.capabilities.search('filesystem');
```

### 3) Run workflow

```ts
const run = await hub.workflows.run('analyze-docs', { path: '/data' });
```

### 4) Stream results

```ts
for await (const event of hub.stream(run.streamId!)) {
  console.log(event);
}
```

### 5) Admin operations

```ts
const tenants = await hub.admin.listTenants();
const health = await hub.admin.health();
console.log({ tenants, health });
```

## API surface

- `HubClient` with `auth`, `capabilities`, `workflows`, `streaming`, and `admin` clients
- `CapabilityClient`: `search`, `install`, `list`, `invoke`
- `WorkflowClient`: `run`, `list`, `cancel`, `getStatus`
- `StreamClient`: `subscribe` with SSE reconnect and `Last-Event-ID`
- `AdminClient`: tenant CRUD, quota get/set, health
- Re-exported hub types from `src/types`
