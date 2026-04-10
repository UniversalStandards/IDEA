# syntax=docker/dockerfile:1.7
# =============================================================
# Universal MCP Orchestration Hub — Production Dockerfile
# Multi-stage build: builder → runtime (non-root, minimal)
# =============================================================

# ─────────────────────────────────────────────────────────────────
# Stage 1: Builder
# ─────────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /build

# Install only what is needed to build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Copy source and compile
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Prune to production dependencies only
RUN npm ci --omit=dev --ignore-scripts

# ─────────────────────────────────────────────────────────────────
# Stage 2: Runtime
# ─────────────────────────────────────────────────────────────────
FROM node:20-slim AS runtime

# OCI standard labels
LABEL org.opencontainers.image.title="Universal MCP Orchestration Hub"
LABEL org.opencontainers.image.description="Self-expanding, multi-provider, enterprise-ready MCP orchestration platform"
LABEL org.opencontainers.image.source="https://github.com/UniversalStandards/IDEA"
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.opencontainers.image.vendor="Universal Standards"

# Security hardening: run as non-root
RUN groupadd --gid 1001 mcphub \
  && useradd --uid 1001 --gid mcphub --shell /bin/sh --create-home mcphub

# Create runtime directories with correct ownership
RUN mkdir -p /app/runtime /app/cache /app/logs /app/policies \
  && chown -R mcphub:mcphub /app

WORKDIR /app

# Copy compiled output and production node_modules ONLY
COPY --from=builder --chown=mcphub:mcphub /build/dist ./dist
COPY --from=builder --chown=mcphub:mcphub /build/node_modules ./node_modules
COPY --from=builder --chown=mcphub:mcphub /build/package.json ./package.json

USER mcphub

EXPOSE 3000

# Health check using the /health/live endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health/live', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

ENV NODE_ENV=production
ENV MCP_TRANSPORT=http

CMD ["node", "dist/index.js"]
