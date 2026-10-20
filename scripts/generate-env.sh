#!/usr/bin/env sh
# Create .env with strong random secrets for docker compose.
# Usage: ./scripts/generate-env.sh [path]   (default: ./.env)
# Refuses to overwrite an existing file.
set -eu

TARGET="${1:-.env}"
if [ -e "$TARGET" ]; then
  echo "refusing to overwrite existing $TARGET" >&2
  exit 1
fi

rand() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

umask 077
cat > "$TARGET" <<ENV
# Generated $(date -u +%Y-%m-%dT%H:%M:%SZ) by scripts/generate-env.sh — keep private.
JWT_SECRET=$(rand)
ENCRYPTION_KEY=$(rand)
MCP_AUTH_TOKEN=$(rand)
# Pre-approved tool IDs (comma-separated), e.g. official:memory,official:time
AUTO_APPROVE_TOOLS=
# Tool credentials: TOOL_<TOOLNAME>__<VAR>=value
ENV
echo "wrote $TARGET (MCP clients authenticate with: Authorization: Bearer <MCP_AUTH_TOKEN>)"
