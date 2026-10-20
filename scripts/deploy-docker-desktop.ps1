<#
.SYNOPSIS
  Build the Universal Standard MCP Server image and wire it into Docker Desktop:
  MCP Toolkit catalog + profile (stdio), and optionally the Compose HTTP service.

.DESCRIPTION
  Steps (each verified before moving on):
    1. Docker engine reachable
    2. docker build  -> universalstandards/universal-standard-mcp-server:<Tag>
    3. stdio self-test: stdout carries only JSON-RPC, 9 hub tools, container exits on EOF
    4. MCP Toolkit: copy the server definition into ~/.docker/mcp/catalogs, (re)create the
       catalog <CatalogRef>, (re)create the profile <ProfileId>, optionally connect clients
    5. -Compose: generate .env if missing, start the hardened Compose service, wait for
       "healthy", run the end-to-end smoke test over Streamable HTTP

.EXAMPLE
  .\scripts\deploy-docker-desktop.ps1
.EXAMPLE
  .\scripts\deploy-docker-desktop.ps1 -AutoApprove "official:memory,official:time" -Connect claude-desktop -Compose
#>
[CmdletBinding()]
param(
  [string]$Tag = "0.1.0",
  [string]$CatalogRef = "universalstandards/mcp-catalog:latest",
  [string]$ProfileId = "universal-standard",
  [string]$AutoApprove = "",
  [string[]]$Connect = @(),
  [switch]$Compose,
  [switch]$SkipBuild
)

# Native commands report failure through $LASTEXITCODE (checked explicitly
# below). "Continue" keeps Windows PowerShell 5.1 from turning redirected
# stderr output (e.g. docker build progress) into terminating errors.
$ErrorActionPreference = "Continue"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$image = "universalstandards/universal-standard-mcp-server:$Tag"

function Step([string]$msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Ok([string]$msg) { Write-Host "    OK  $msg" -ForegroundColor Green }
function Invoke-Checked([string]$what, [scriptblock]$block) {
  & $block
  if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" }
}

# 1 ─ engine
Step "Checking Docker engine"
$server = docker version --format "{{.Server.Version}}" 2>$null
if ($LASTEXITCODE -ne 0 -or -not $server) { throw "Docker engine is not reachable. Start Docker Desktop and retry." }
Ok "Docker engine $server"

# 2 ─ build
if (-not $SkipBuild) {
  Step "Building $image"
  $rev = (git rev-parse --short HEAD 2>$null)
  if (-not $rev) { $rev = "unknown" }
  Invoke-Checked "docker build" { docker build -t $image --build-arg VERSION=$Tag --build-arg VCS_REF=$rev . }
  Ok "Image built"
}

# 3 ─ stdio self-test
Step "stdio self-test"
$requests = @(
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"deploy-check","version":"1"}}}',
  '{"jsonrpc":"2.0","method":"notifications/initialized"}',
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
)
$started = Get-Date
$lines = @($requests | docker run -i --rm -e MCP_TRANSPORT=stdio $image 2>$null | Where-Object { $_.Trim() -ne "" })
$elapsed = [int]((Get-Date) - $started).TotalSeconds
if ($lines.Count -ne 2) { throw "Expected exactly 2 JSON-RPC lines on stdout, got $($lines.Count)" }
$toolCount = (($lines[1] | ConvertFrom-Json).result.tools).Count
if ($toolCount -ne 9) { throw "Expected 9 hub tools, got $toolCount" }
Ok "Clean stdout, $toolCount tools, container exited after ${elapsed}s"

# 4 ─ MCP Toolkit catalog + profile
Step "Registering with Docker Desktop MCP Toolkit"
$catalogDir = Join-Path $HOME ".docker\mcp\catalogs"
New-Item -ItemType Directory -Force -Path $catalogDir | Out-Null
$definition = Get-Content -Raw "docker\mcp-catalog\universal-standard.yaml"
$definition = $definition -replace "universalstandards/universal-standard-mcp-server:[^\s]+", $image
[System.IO.File]::WriteAllText((Join-Path $catalogDir "universal-standard.yaml"), $definition, (New-Object System.Text.UTF8Encoding $false))

docker mcp catalog remove $CatalogRef 2>$null | Out-Null
Invoke-Checked "catalog create" { docker mcp catalog create $CatalogRef --title "Universal Standards" --server "file://universal-standard.yaml" }
Ok "Catalog $CatalogRef"

docker mcp profile remove $ProfileId 2>$null | Out-Null
$profileArgs = @("mcp", "profile", "create", "--name", "Universal Standard", "--id", $ProfileId,
  "--server", "catalog://$CatalogRef/universal-standard")
foreach ($c in $Connect) { $profileArgs += @("--connect", $c) }
Invoke-Checked "profile create" { docker @profileArgs }
if ($AutoApprove) {
  Invoke-Checked "profile config" { docker mcp profile config $ProfileId --set "universal-standard.auto_approve_tools=$AutoApprove" }
}
Ok "Profile $ProfileId$(if ($Connect.Count) { " (connected: $($Connect -join ', '))" })"

# 5 ─ Compose HTTP service
if ($Compose) {
  Step "Starting the Compose HTTP service"
  if (-not (Test-Path ".env")) { & "$PSScriptRoot\generate-env.ps1" }
  $env:HUB_VERSION = $Tag
  Invoke-Checked "docker compose up" { docker compose up -d }
  $health = ""
  for ($i = 0; $i -lt 45; $i++) {
    $health = docker inspect -f "{{.State.Health.Status}}" mcp-hub 2>$null
    if ($health -eq "healthy") { break }
    Start-Sleep -Seconds 2
  }
  if ($health -ne "healthy") { docker logs --tail 50 mcp-hub; throw "mcp-hub did not become healthy (status: $health)" }
  Ok "mcp-hub healthy"
  Invoke-Checked "HTTP smoke test" { docker compose exec -T hub node /app/dist/cli/smoke.js --http http://127.0.0.1:3000/mcp }
  $port = if ($env:HUB_PORT) { $env:HUB_PORT } else { "3000" }
  Ok "MCP endpoint http://127.0.0.1:$port/mcp (Authorization: Bearer <MCP_AUTH_TOKEN from .env>)"
}

Step "Done"
Write-Host "    Docker Desktop -> MCP Toolkit -> Profiles -> 'Universal Standard'"
Write-Host "    Gateway (any stdio client): docker mcp gateway run --profile $ProfileId"
