# Builds the audio helper (native/bin/rc-audio.exe) that local mode uses to record game audio and the mic.
# Needs Visual Studio or the free "Build Tools for Visual Studio" with the "Desktop development with C++"
# workload. GitHub Actions builds it for the installer, so you only need this when running from source.
# Usage, from the repo folder in PowerShell:  powershell -ExecutionPolicy Bypass -File scripts\build-native.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$src = Join-Path $root 'native\rc-audio\rc-audio.cpp'
$out = Join-Path $root 'native\bin'
New-Item -ItemType Directory -Force -Path $out | Out-Null

if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
  # Not in a developer prompt: find Visual Studio and load its x64 build environment.
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (-not (Test-Path $vswhere)) {
    Write-Host 'Visual Studio Build Tools are not installed. Get them free from https://visualstudio.microsoft.com/visual-cpp-build-tools/ (pick "Desktop development with C++").'
    exit 1
  }
  $vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if (-not $vs) {
    Write-Host 'Visual Studio is installed without the C++ tools. Add "Desktop development with C++" in the Visual Studio Installer.'
    exit 1
  }
  $vcvars = Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat'
  cmd /c "`"$vcvars`" >nul && set" | ForEach-Object {
    if ($_ -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process') }
  }
}

Push-Location $out
try {
  cl.exe /nologo /O2 /EHsc /std:c++17 /utf-8 /W4 /DUNICODE /D_UNICODE $src /Fe:rc-audio.exe ole32.lib
  if ($LASTEXITCODE -ne 0) { throw "cl.exe failed with code $LASTEXITCODE" }
  Remove-Item -ErrorAction SilentlyContinue *.obj
} finally {
  Pop-Location
}
if (-not (Test-Path (Join-Path $out 'rc-audio.exe'))) { throw 'rc-audio.exe was not built' }
Write-Host "Built $out\rc-audio.exe"
