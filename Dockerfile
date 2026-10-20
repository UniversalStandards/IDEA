# =============================================================================
# Universal Standard MCP Server — production image
#
#   builder  → compiles TypeScript, prunes to production dependencies
#   runtime  → Node.js 24 LTS (Debian bookworm slim), non-root, tini as PID 1,
#              uv/uvx for Python-based MCP servers, all mutable state in /data
#
# One image, two modes:
#   HTTP (default)  docker run -p 3000:3000 -e MCP_AUTH_TOKEN=… -e JWT_SECRET=… \
#                     -e ENCRYPTION_KEY=… -v mcp-hub-data:/data <image>
#   stdio           docker run -i --rm -e MCP_TRANSPORT=stdio -v mcp-hub-data:/data <image>
#                   (Docker MCP Toolkit, Claude Desktop, any stdio MCP client)
#
# Base images are pinned by digest; Dependabot (docker ecosystem) keeps them
# current. Override NODE_IMAGE / UV_IMAGE to build through a registry mirror.
# No `# syntax=` directive: the BuildKit frontend built into Docker Engine
# 23+ supports every instruction used here, so builds do not depend on
# pulling docker/dockerfile from Docker Hub.
# =============================================================================

ARG NODE_IMAGE=node:24-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.9.5@sha256:f459f6f73a8c4ef5d69f4e6fbbdb8af751d6fa40ec34b39a1ab469acd6e289b7

# ── uv binaries (copied, not installed: static, ~40 MB) ──────────────────────
FROM ${UV_IMAGE} AS uv

# ── Stage 1: builder ─────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS builder

WORKDIR /build

COPY package.json package-lock.json ./
# --ignore-scripts: skips the `prepare` build hook until sources are present.
# Optional build secret `build_ca`: extra CA bundle for builds behind a
# TLS-inspecting proxy (docker build --secret id=build_ca,src=ca.pem …).
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=secret,id=build_ca,required=false \
    if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi \
 && npm ci --ignore-scripts --no-audit --no-fund

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build \
 && npm prune --omit=dev --ignore-scripts --no-audit --no-fund \
 && find dist \( -name '*.map' -o -name '*.d.ts' \) -delete

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime

ARG VERSION=0.1.0
ARG VCS_REF=unknown
ARG BUILD_DATE=unknown

LABEL org.opencontainers.image.title="Universal Standard MCP Server" \
      org.opencontainers.image.description="Self-provisioning, governed MCP hub: discovers, installs and runs MCP servers on demand over stdio or Streamable HTTP" \
      org.opencontainers.image.source="https://github.com/UniversalStandards/IDEA" \
      org.opencontainers.image.documentation="https://github.com/UniversalStandards/IDEA/blob/main/docs/deployment/docker.md" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.vendor="Universal Standards" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.created="${BUILD_DATE}"

# tini: correct signal forwarding and zombie reaping for the MCP servers the
# hub spawns. ca-certificates: TLS for npm/PyPI/registry traffic.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=uv /uv /uvx /usr/local/bin/

# Dedicated unprivileged user; application code stays root-owned (read-only
# to the service), all writable state lives under /data.
RUN groupadd --system --gid 10001 mcphub \
 && useradd --system --uid 10001 --gid mcphub --home-dir /home/mcphub --create-home \
      --shell /usr/sbin/nologin mcphub \
 && mkdir -p /data \
 && chown mcphub:mcphub /data

WORKDIR /app
COPY --from=builder /build/package.json ./package.json
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/dist ./dist

ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    PORT=3000 \
    HUB_DATA_DIR=/data/.mcp \
    LOG_DIR=/data/logs \
    UV_CACHE_DIR=/data/.cache/uv \
    UV_PYTHON_INSTALL_DIR=/data/.local/uv/python \
    UV_TOOL_DIR=/data/.local/uv/tools \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

# The process runs from /data so every cwd-relative path (runtime/ audit
# logs, policies/, plugins/, config/) lands on the persistent volume.
WORKDIR /data
VOLUME ["/data"]

USER mcphub
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD ["node", "/app/dist/healthcheck.js"]

ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/dist/index.js"]
