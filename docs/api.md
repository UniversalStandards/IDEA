# API Reference

All routes are served by the Express HTTP server. The server starts on the port defined by `PORT` (default: `3000`).

> **Interactive docs**: Visit `GET /docs` in development to browse this API in Swagger UI.
> The machine-readable spec is always available at `GET /openapi.json`.

---

## OpenAPI Specification

### `GET /openapi.json`
Returns the OpenAPI 3.1 specification document for this API as JSON.

- **Authentication**: none required
- **CORS**: `Access-Control-Allow-Origin: *` (always enabled on this endpoint so external tools can fetch it)
- **Cache-Control**: `public, max-age=3600`

```bash
curl http://localhost:3000/openapi.json | jq .info
```

The spec is generated at runtime from the Zod schemas defined in `src/api/`. The `servers[0].url`
field is populated from the incoming request's `Host` header and protocol.

---

### `GET /docs`
Interactive API documentation.

| Environment | Behaviour |
|-------------|-----------|
| `development` | Serves embedded Swagger UI (HTML + JS) |
| `production` | `301` redirect to `/openapi.json` |

```bash
# Open in browser (development only)
open http://localhost:3000/docs
```

---

## Health Endpoints

Health endpoints are unauthenticated and designed for use by load balancers and orchestrators.

### `GET /health`
Combined liveness + readiness check (backward compatible).

**Response 200** (ready):
```json
{
  "status": "ok",
  "version": "0.1.0",
  "nodeVersion": "v20.x.x",
  "environment": "production",
  "uptimeSeconds": 3600,
  "timestamp": "2026-04-09T12:00:00.000Z",
  "checks": {
    "runtime": { "status": "ok", "message": "Runtime manager initialized" },
    "memory": { "status": "ok", "message": "42MB heap used" }
  }
}
```

**Response 503** (not ready): Same schema, `status: "degraded"`, runtime check `status: "unavailable"`.

**Headers**: `X-Request-ID: <uuid>`

---

### `GET /health/live`
Liveness probe — always returns 200 if the process is running.

```json
{ "status": "ok", "timestamp": "2026-04-09T12:00:00.000Z" }
```

---

### `GET /health/ready`
Readiness probe — returns 200 only when the runtime manager is fully initialized.

**Response 200**: `{ "status": "ok", "uptimeSeconds": 120, "timestamp": "..." }`

**Response 503**: `{ "status": "unavailable", "message": "Runtime not yet initialized", "timestamp": "..." }`

---

## Admin API

All admin routes require a valid `Authorization: Bearer <token>` header.

### Authentication
Tokens are JWTs signed with `JWT_SECRET`. Generate a token:
```bash
node -e "console.log(require('jsonwebtoken').sign({ sub: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h' }))"
```

**401 Response** (missing or invalid token):
```json
{ "error": "Missing or invalid Authorization header. Expected: Bearer <token>" }
```

---

### `GET /admin/capabilities`
List all capabilities currently registered in the runtime.

```json
{
  "capabilities": [
    {
      "id": "my-tool",
      "name": "My Tool",
      "version": "1.0.0"
    }
  ],
  "count": 1
}
```

---

### `DELETE /admin/capabilities/:id`
Deregister a capability from the runtime.

**Path param**: `id` — capability ID (1–255 chars)

**Response 200**: `{ "message": "Capability 'my-tool' deregistered successfully" }`

**Response 404**: `{ "error": "Capability 'my-tool' not found or already removed" }`

**Response 400**: `{ "error": "Invalid capability ID" }`

---

### `GET /admin/policies`
List active policy rules from the policy engine.

```json
{
  "policies": [],
  "count": 0,
  "message": "Policy listing available after policy-engine is fully initialized"
}
```

---

### `GET /admin/costs`
Return cost summary for the specified time window.

**Query params**:
- `windowHours` (integer, 1–168, default: 24)

```json
{
  "window": "24h",
  "windowMs": 86400000,
  "totalCostUsd": 1.23,
  "requestCount": 450,
  "byProvider": { "openai": 0.80, "anthropic": 0.43 },
  "byModel": { "gpt-4": 0.60, "claude-3": 0.43, "gpt-3.5-turbo": 0.20 },
  "from": "2026-04-08T12:00:00.000Z",
  "to": "2026-04-09T12:00:00.000Z"
}
```

**Response 400**: `{ "error": "Invalid query parameters", "details": [...] }`

---

### `GET /admin/audit`
Return recent audit log entries (paginated).

**Query params**:
- `limit` (integer, 1–500, default: 50)
- `offset` (integer, >= 0, default: 0)
- `action` (string, optional — filter by action prefix)

```json
{
  "entries": [],
  "limit": 50,
  "offset": 0,
  "action": null,
  "total": 0
}
```

---

## Events Adapter Endpoints

### `POST /adapters/events/webhook`
Receive an external webhook event.

**Headers** (when `WEBHOOK_SECRET` is configured): `X-Webhook-Signature: <hmac-sha256-hex>`

**Request body**:
```json
{
  "type": "deploy.completed",
  "id": "evt-123",
  "payload": { "service": "api", "version": "1.2.3" }
}
```

**Response 202**: `{ "status": "accepted", "eventId": "evt-123" }`

**Response 200** (duplicate): `{ "status": "duplicate", "eventId": "evt-123" }`

**Response 401**: Missing or invalid signature.

---

### `GET /adapters/events/stream`
Server-Sent Events stream. Connect to receive real-time event delivery.

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive

: connected

data: {"type":"deploy.completed","id":"evt-123",...}

: heartbeat
```
