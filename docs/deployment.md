# Deployment Guide

## 1. Environment Variables Reference

| Variable | Type | Default | Required | Description |
|---|---|---|---|---|
| `NODE_ENV` | enum | `development` | No | `development`, `production`, `test` |
| `PORT` | int | `3000` | No | HTTP server port (1–65535) |
| `LOG_LEVEL` | enum | `info` | No | `error`, `warn`, `info`, `debug`, `silly` (silly blocked in prod) |
| `MCP_TRANSPORT` | enum | `http` | No | `http`, `stdio`, `sse` |
| `JWT_SECRET` | string | insecure default | **Yes (prod)** | Min 32 chars. Signs admin API tokens. |
| `ENCRYPTION_KEY` | string | insecure default | **Yes (prod)** | Min 32 chars. AES-256-GCM key for secrets. |
| `CORS_ORIGIN` | string | `*` | No | `*` or comma-separated URL list. |
| `RATE_LIMIT_WINDOW_MS` | int | `60000` | No | Rate limit window in ms. |
| `RATE_LIMIT_MAX_REQUESTS` | int | `300` | No | Max requests per window. |
| `ENABLE_GITHUB_REGISTRY` | bool | `true` | No | Enable GitHub registry connector. |
| `ENABLE_OFFICIAL_MCP_REGISTRY` | bool | `true` | No | Enable official MCP registry. |
| `ENABLE_ENTERPRISE_CATALOG` | bool | `false` | No | Enable enterprise catalog connector. |
| `ENTERPRISE_CATALOG_URL` | URL | — | No | HTTP URL of the catalog JSON endpoint. |
| `ENTERPRISE_CATALOG_PATH` | path | — | No | Local file path to catalog JSON. |
| `GITHUB_TOKEN` | string | — | No | GitHub PAT for private registry access. |
| `GITHUB_REPO` | string | — | No | `owner/repo` for repo-scoped discovery. |
| `WEBHOOK_SECRET` | string | — | No | HMAC-SHA256 secret for webhook signature verification. |
| `EVENT_DEDUP_WINDOW_MS` | int | `300000` | No | Deduplication window for events (5 min default). |
| `COST_TRACKING_ENABLED` | bool | `true` | No | Enable per-request cost tracking. |
| `COST_BUDGET_DAILY_USD` | float | `0` | No | Daily budget alert threshold (0 = disabled). |
| `CACHE_TTL` | int | `300` | No | Discovery cache TTL in seconds. |
| `MAX_CONCURRENT_INSTALLS` | int | `5` | No | Max parallel package installations. |
| `ENABLE_AUDIT_LOGGING` | bool | `true` | No | Write HMAC-signed audit entries to `runtime/audit.jsonl`. |
| `REDIS_URL` | URL | — | No | Redis connection URL (for future distributed caching). |

---

## 2. Docker

### Build the image
```bash
docker build -t mcp-hub:latest .
```

### Run a single container
```bash
docker run -d \
  --name mcp-hub \
  -p 3000:3000 \
  --env-file .env \
  --restart unless-stopped \
  mcp-hub:latest
```

### Docker Compose (recommended for local + team use)
```bash
# Start all services
docker compose up -d

# View logs
docker compose logs -f hub

# Stop
docker compose down

# Stop and remove volumes
docker compose down -v
```

The compose stack starts: `hub` (the orchestration server) + `redis` (future distributed caching).

---

## 3. Health Checks

Configure your orchestrator to use these endpoints:

| Probe | Endpoint | Success | Failure |
|---|---|---|---|
| **Liveness** | `GET /health/live` | Always `200 OK` | Process is down |
| **Readiness** | `GET /health/ready` | `200 OK` when runtime initialized | `503` until ready |
| **Combined** | `GET /health` | `200` when ready | `503` during init |

**Start period**: Allow at least 20 seconds before the readiness probe begins checking.

---

## 4. Reverse Proxy

### Nginx example
```nginx
upstream mcp_hub {
    server 127.0.0.1:3000;
    keepalive 32;
}

server {
    listen 443 ssl http2;
    server_name mcp.example.com;

    ssl_certificate     /etc/ssl/certs/mcp.crt;
    ssl_certificate_key /etc/ssl/private/mcp.key;

    location / {
        proxy_pass         http://mcp_hub;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection keep-alive;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }

    # SSE requires buffering disabled
    location /mcp/sse {
        proxy_pass             http://mcp_hub;
        proxy_http_version     1.1;
        proxy_set_header       Connection '';
        proxy_buffering        off;
        proxy_read_timeout     3600s;
        chunked_transfer_encoding on;
    }

    location /adapters/events/stream {
        proxy_pass             http://mcp_hub;
        proxy_http_version     1.1;
        proxy_set_header       Connection '';
        proxy_buffering        off;
        proxy_read_timeout     3600s;
    }
}
```

### Cloudflare Tunnel
```bash
cloudflared tunnel create mcp-hub
cloudflared tunnel route dns mcp-hub mcp.example.com
cloudflared tunnel run --url http://localhost:3000 mcp-hub
```

---

## 5. Kubernetes Starter Templates

### ConfigMap
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: mcp-hub-config
data:
  NODE_ENV: production
  PORT: "3000"
  LOG_LEVEL: info
  MCP_TRANSPORT: http
  CORS_ORIGIN: "https://your-domain.com"
  ENABLE_METRICS: "true"
  ENABLE_AUDIT_LOGGING: "true"
```

### Secret
```yaml
apiVersion: v1
kind: Secret
metadata:
  name: mcp-hub-secrets
type: Opaque
stringData:
  JWT_SECRET: "your-strong-jwt-secret-at-least-32-chars"
  ENCRYPTION_KEY: "your-strong-encryption-key-32-chars!"
```

### Deployment
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mcp-hub
spec:
  replicas: 2
  selector:
    matchLabels:
      app: mcp-hub
  template:
    metadata:
      labels:
        app: mcp-hub
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 1001
      containers:
        - name: mcp-hub
          image: ghcr.io/universalstandards/idea:latest
          ports:
            - containerPort: 3000
          envFrom:
            - configMapRef:
                name: mcp-hub-config
            - secretRef:
                name: mcp-hub-secrets
          livenessProbe:
            httpGet:
              path: /health/live
              port: 3000
            initialDelaySeconds: 10
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /health/ready
              port: 3000
            initialDelaySeconds: 20
            periodSeconds: 10
          resources:
            requests:
              memory: 256Mi
              cpu: 250m
            limits:
              memory: 1Gi
              cpu: 1000m
```

### HorizontalPodAutoscaler
```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: mcp-hub-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: mcp-hub
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
```

---

## 6. Air-Gapped / Offline Mode

To run without external registry access:

1. Set `ENABLE_GITHUB_REGISTRY=false` and `ENABLE_OFFICIAL_MCP_REGISTRY=false`
2. Set `ENABLE_ENTERPRISE_CATALOG=true` and `ENTERPRISE_CATALOG_PATH=/app/policies/local-catalog.json`
3. Pre-populate `local-catalog.json` with approved tools in the catalog schema format
4. Set `ENABLE_LOCAL_WORKSPACE_SCAN=true` to discover tools from the local filesystem
5. Pre-install all required packages into the container image or a mounted volume
6. Set `ENABLE_AUTO_UPDATES=false` (default) to prevent any outbound package fetch attempts
