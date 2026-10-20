# Running the Universal Standard MCP Server in Docker

One image serves every deployment shape:

| Mode | Who connects | How |
|---|---|---|
| **stdio** | Docker Desktop MCP Toolkit, Claude Desktop, Claude Code, Cursor, any stdio MCP client | `docker run -i --rm -e MCP_TRANSPORT=stdio …` |
| **Streamable HTTP** | Network MCP clients, agents, other services | `docker compose up -d` → `http://127.0.0.1:3000/mcp` with a Bearer token |

---

## 1. Build the image

```bash
docker build -t universalstandards/universal-standard-mcp-server:0.1.0 .
```

### 1.1 Image contents

| Item | Detail |
|---|---|
| 1.1.1 Base | Node.js 24 LTS on Debian bookworm-slim, pinned by digest (Dependabot keeps it current) |
| 1.1.2 Runtimes for installed tools | `npx` (npm packages) and `uv`/`uvx` (PyPI packages; Python is downloaded on first use into `/data`) |
| 1.1.3 PID 1 | `tini` — forwards signals and reaps the MCP server processes the hub spawns |
| 1.1.4 User | `mcphub` (uid/gid 10001), no shell; application code is root-owned and read-only to it |
| 1.1.5 State | Everything mutable lives under `/data` (declared `VOLUME`) |
| 1.1.6 Health | `HEALTHCHECK` runs `node /app/dist/healthcheck.js` (probes `/health/live`; always passes in stdio-only mode) |

### 1.2 Building behind a TLS-inspecting proxy

Pass the proxy's CA bundle as a build secret (never baked into a layer):

```bash
docker build --secret id=build_ca,src=/path/to/corporate-ca.pem -t universalstandards/universal-standard-mcp-server:0.1.0 .
```

At runtime, mount the same bundle and point `NODE_EXTRA_CA_CERTS` / `SSL_CERT_FILE` at it; the hub forwards
proxy (`HTTPS_PROXY`, `NO_PROXY`) and trust-store variables to npm, `uvx` and every installed tool.

### 1.3 Registry mirrors

`NODE_IMAGE` and `UV_IMAGE` are build args, e.g.
`--build-arg NODE_IMAGE=mirror.gcr.io/library/node:24-slim@sha256:<digest>`.

---

## 2. Docker Desktop MCP Toolkit (stdio)

### 2.1 Add the server to a custom catalog

From the repository root, after building the image (§1):

```bash
docker mcp catalog create universalstandards/mcp-catalog:latest \
  --title "Universal Standards" \
  --server file://./docker/mcp-catalog/universal-standard.yaml
```

Then in Docker Desktop: **MCP Toolkit → Catalog → Universal Standards → Universal Standard MCP Server → Add**.
To share the catalog with your team, push it (`docker mcp catalog push universalstandards/mcp-catalog:latest`)
and have them use **Import catalog** with the same OCI reference.

### 2.2 What the gateway runs

`docker/mcp-catalog/universal-standard.yaml` launches the image with `MCP_TRANSPORT=stdio` and the named volume
`universal-standard-mcp-data:/data`, so installed tools, their data (e.g. the memory server's graph) and the
uv/Python cache persist across sessions. The server is `longLived`, so installed tools stay warm.

### 2.3 Settings

| Setting | Purpose |
|---|---|
| 2.3.1 `auto_approve_tools` | Comma-separated tool IDs pre-approved for install/execute, e.g. `official:memory,official:time` |

### 2.4 Behaviour in stdio mode

- 2.4.1 stdout carries only MCP JSON-RPC; every log line goes to stderr.
- 2.4.2 No port is opened (set `STDIO_ENABLE_HTTP=true` to also serve health/admin/REST).
- 2.4.3 The container exits as soon as the client closes stdin.
- 2.4.4 `JWT_SECRET` / `ENCRYPTION_KEY` may be omitted: with no network listener the hub generates per-process
  values (logged as a warning). Any mode with a listener refuses to start without real secrets.

---

## 3. Claude Desktop / other stdio clients

```json
{
  "mcpServers": {
    "universal-standard": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT=stdio",
        "-e", "AUTO_APPROVE_TOOLS=official:memory,official:time",
        "-v", "universal-standard-mcp-data:/data",
        "universalstandards/universal-standard-mcp-server:0.1.0"
      ]
    }
  }
}
```

---

## 4. Long-running HTTP service (Docker Compose)

### 4.1 Start

```bash
./scripts/generate-env.sh          # Windows: .\scripts\generate-env.ps1
docker compose up -d --build
docker compose ps                  # STATUS should read "healthy"
```

`scripts/generate-env.*` writes `.env` (owner-only permissions) with random `JWT_SECRET`, `ENCRYPTION_KEY`
and `MCP_AUTH_TOKEN`. Compose refuses to start if any of them is missing.

### 4.2 Connect a client

- Endpoint: `http://127.0.0.1:3000/mcp` (MCP Streamable HTTP, spec 2025-06-18)
- Header: `Authorization: Bearer <MCP_AUTH_TOKEN>` (a JWT signed with `JWT_SECRET` is also accepted)

### 4.3 Verify end to end

```bash
docker compose exec hub node /app/dist/cli/smoke.js \
  --http http://127.0.0.1:3000/mcp --install official:memory
```

Runs initialize → tools/list → discover → install → list actions → execute → uninstall and prints one JSON
line per step; exit code 0 means every step passed.

### 4.4 Hardening applied by the Compose file

| Control | Setting |
|---|---|
| 4.4.1 Network exposure | Port published on `127.0.0.1` only (`HUB_BIND=0.0.0.0` to change — put TLS in front) |
| 4.4.2 Filesystem | `read_only: true`; writable paths are `/data` (volume), `/tmp` and `$HOME` (tmpfs) |
| 4.4.3 Privileges | `cap_drop: [ALL]`, `no-new-privileges` |
| 4.4.4 Resources | 2 CPUs / 2 GiB limit; log rotation 5 × 10 MB |
| 4.4.5 MCP endpoint | Bearer auth required in production; optional `MCP_ALLOWED_HOSTS` for DNS-rebinding protection; `MCP_MAX_SESSIONS` and idle-session reaping |

---

## 5. Approvals for high-risk actions

Installing or uninstalling a tool, changing policy, and calling actions that are high-risk by policy
(`write_file`, `delete_file`, `execute_shell`, …) or that the tool declares destructive require human approval.

| Order | Mechanism | When it applies |
|---|---|---|
| 5.1 | `AUTO_APPROVE_TOOLS` operator allowlist | Tool ID is listed (audited as `approval.auto`) |
| 5.2 | In-client prompt (MCP elicitation) | The client supports elicitation — the user approves in the client UI |
| 5.3 | Out-of-band approval | Otherwise the call returns `approval_required` with an `approvalId` |

Approving an `approvalId` (HTTP mode):

```bash
docker exec mcp-hub node /app/dist/cli/admin.js approvals list
docker exec mcp-hub node /app/dist/cli/admin.js approvals approve <approvalId> "reviewed"
```

Then repeat the tool call with `approvalId`. Approvals are single-use and bound to one tool + action.

---

## 6. Credentials for installed tools

Installed tools never inherit the hub's environment (no `JWT_SECRET`, `MCP_AUTH_TOKEN`, provider keys, …).
Give a tool a variable with the `TOOL_<TOOLNAME>__<VAR>` convention:

```dotenv
TOOL_GITHUB__GITHUB_PERSONAL_ACCESS_TOKEN=ghp_…
TOOL_WEB_SEARCH__BRAVE_API_KEY=…
```

`<TOOLNAME>` is the tool's name upper-cased with non-alphanumerics replaced by `_`
(registry server `io.github.acme/widgets` → `TOOL_IO_GITHUB_ACME_WIDGETS__…`).
Credentials are never written to the install state file.

---

## 7. Data volume layout (`/data`)

| Path | Contents |
|---|---|
| 7.1 `.mcp/installed/<tool>/` | Per-tool npm install (isolated `package.json` + `node_modules`) |
| 7.2 `.mcp/state/installed-tools.json` | Install records restored at startup (mode 0600, no secrets) |
| 7.3 `runtime/audit.jsonl`, `runtime/policy-audit.jsonl` | Audit trail |
| 7.4 `logs/` | Rotated JSON logs (`LOG_FILE_ENABLED=false` to disable) |
| 7.5 `.cache/uv`, `.local/uv/` | uv cache and managed Python for PyPI-based tools |

Back up the volume with `docker run --rm -v universal-standard-mcp-data:/data -v "$PWD":/backup busybox tar czf /backup/hub-data.tgz -C /data .`

---

## 8. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| 8.1 `MCP_AUTH_TOKEN (min 32 chars) is required in production…` | HTTP mode without a token — run `scripts/generate-env.*` or set `MCP_ALLOW_UNAUTHENTICATED=true` only behind an authenticating proxy |
| 8.2 `Runtime 'uvx' is not available…` | Running outside the image without uv installed; install uv or use the image |
| 8.3 `install_tool` returns `startupWarning` | The server needs launch args (e.g. directories for `official:filesystem`) or credentials (§6) — reinstall with `args` |
| 8.4 `SELF_SIGNED_CERT_IN_CHAIN` during installs | TLS-inspecting proxy — see §1.2 |
| 8.5 `approval_required` on every call | Expected without elicitation support; use §5 or `AUTO_APPROVE_TOOLS` |
