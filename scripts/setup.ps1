<#
.SYNOPSIS
  Install Visual Impression into VS Code on Windows.

.DESCRIPTION
  Build from source and hand the result to the VS Code CLI. Re-running is
  safe: --force replaces what is installed rather than adding to it.

  On macOS and Linux use scripts/setup.sh instead.

.PARAMETER Check
  Report what is installed and run the tests. Changes nothing.

.PARAMETER Uninstall
  Remove the extension. Recorded history is left alone.
#>
param([switch]$Check, [switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$Root  = Split-Path $PSScriptRoot -Parent
$ExtId = 'geniuspudding.visual-impression'
$MinCode = [version]'1.93'

function Ok ([string]$m) { Write-Host "  OK    $m" -ForegroundColor Green }
function Bad([string]$m) { Write-Host "  MISS  $m" -ForegroundColor Red }

function Get-CodeCli {
  foreach ($c in 'code', 'code-insiders', 'codium', 'cursor') {
    $cmd = Get-Command $c -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
  }
  $null
}

$code = Get-CodeCli
if (-not $code) { Bad 'no VS Code CLI on PATH'; return }

if ($Uninstall) {
  & $code --uninstall-extension $ExtId 2>&1 | Out-Null
  Write-Host "Removed $ExtId. Your history in ~/.wt-tabs/vscode/ was left alone."
  return
}

if ($Check) {
  Write-Host ''
  Write-Host "Visual Impression  $Root" -ForegroundColor Cyan
  if (Get-Command node -ErrorAction SilentlyContinue) { Ok "node $(& node --version)" } else { Bad 'node not found (18 or newer)' }
  Ok "VS Code CLI: $code ($(@(& $code --version)[0]))"
  if (@(& $code --list-extensions 2>$null) -contains $ExtId) { Ok "$ExtId installed" }
  else { Bad "$ExtId not installed (run this script with no arguments)" }
  if (Test-Path (Join-Path $Root 'node_modules')) {
    Write-Host ''
    Write-Host 'tests' -ForegroundColor Cyan
    Push-Location $Root; try { & npm test } finally { Pop-Location }
  } else {
    Write-Host ''
    Write-Host 'run the installer first to fetch dependencies, then -Check runs the tests' -ForegroundColor DarkGray
  }
  return
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Bad 'npm not found; install Node 18 or newer first'; return }

$have = [version](@(& $code --version)[0] -replace '[^0-9.].*$', '')
if ($have -lt $MinCode) {
  Bad "VS Code $have is older than $MinCode; the shell integration API this needs is not there yet"
  return
}

Write-Host ''
Write-Host "Installing Visual Impression from $Root" -ForegroundColor Cyan
Push-Location $Root
try {
  & npm install --no-audit --no-fund --silent
  & npm test
  & npx --yes vsce package --no-dependencies
  $vsix = Get-ChildItem $Root -Filter '*.vsix' -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $vsix) { Bad 'the extension did not build'; return }
  & $code --install-extension $vsix.FullName --force 2>&1 | Out-Null
  Ok "installed $($vsix.Name)"
} finally { Pop-Location }

Write-Host ''
Write-Host 'Reload the window (Developer: Reload Window) and it starts recording.' -ForegroundColor Green
Write-Host 'Verify any time with:  .\scripts\setup.ps1 -Check' -ForegroundColor DarkGray
Write-Host ''
