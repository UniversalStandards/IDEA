<#
.SYNOPSIS
  Create .env with strong random secrets for docker compose (Windows).
.EXAMPLE
  .\scripts\generate-env.ps1            # writes .\.env
  .\scripts\generate-env.ps1 -Path C:\secure\hub.env
#>
param([string]$Path = ".env")
$ErrorActionPreference = "Stop"

if (Test-Path -LiteralPath $Path) {
  Write-Error "refusing to overwrite existing $Path"
}

function New-Secret {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  -join ($bytes | ForEach-Object { $_.ToString("x2") })
}

$stamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$content = @(
  "# Generated $stamp by scripts/generate-env.ps1 - keep private.",
  "JWT_SECRET=$(New-Secret)",
  "ENCRYPTION_KEY=$(New-Secret)",
  "MCP_AUTH_TOKEN=$(New-Secret)",
  "# Pre-approved tool IDs (comma-separated), e.g. official:memory,official:time",
  "AUTO_APPROVE_TOOLS=",
  "# Tool credentials: TOOL_<TOOLNAME>__<VAR>=value"
)
# UTF-8 without BOM so docker compose parses the first line correctly
[System.IO.File]::WriteAllLines((Join-Path (Get-Location) $Path), $content, (New-Object System.Text.UTF8Encoding $false))

# Restrict to the current user
$acl = Get-Acl -LiteralPath $Path
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
  [System.Security.Principal.WindowsIdentity]::GetCurrent().Name, "FullControl", "Allow")
$acl.SetAccessRule($rule)
Set-Acl -LiteralPath $Path -AclObject $acl

Write-Host "wrote $Path (MCP clients authenticate with: Authorization: Bearer <MCP_AUTH_TOKEN>)"
