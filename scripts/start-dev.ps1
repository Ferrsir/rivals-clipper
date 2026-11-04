# Runs Rivals Clipper from source in Overwolf dev mode, so game events and recording load
# without a signed build. Needs Node.js (LTS) and your Overwolf dev key.
# Usage, from the repo folder in PowerShell:  powershell -ExecutionPolicy Bypass -File scripts\start-dev.ps1

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js is not installed. Install the LTS version from https://nodejs.org and run this again.'
  exit 1
}

if (-not $env:OW_DEV_KEY -and -not ($env:OW_CLI_EMAIL -and $env:OW_CLI_API_KEY)) {
  Write-Host 'Paste your Overwolf dev key (dev.overwolf.com, your profile, once Developer status is Approved):'
  $env:OW_DEV_KEY = (Read-Host).Trim()
  $save = Read-Host 'Save it for next time in your Windows user settings? (y/n)'
  if ($save -eq 'y') { [Environment]::SetEnvironmentVariable('OW_DEV_KEY', $env:OW_DEV_KEY, 'User') }
}

if (-not (Test-Path node_modules)) { npm ci }
npm start
