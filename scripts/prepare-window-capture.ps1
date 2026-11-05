# Windows Graphics Capture support is required for game-window-only recording.
# Archive digest from the Microsoft WinGet Gyan.FFmpeg 9.0.2 x64 manifest.
$ErrorActionPreference = 'Stop'
$outDir = Join-Path $PSScriptRoot '../native/bin'
New-Item -ItemType Directory -Force $outDir | Out-Null
$expectedExe = '589E50B766D251AFDF181DD664D40BD94407E200B019989FD7468C7D118A28D0'
$found = Get-Command ffmpeg.exe -ErrorAction SilentlyContinue
if ($found -and (Get-FileHash -LiteralPath $found.Source).Hash -eq $expectedExe) {
  $license = Join-Path (Split-Path (Split-Path $found.Source)) 'LICENSE'
  if (Test-Path -LiteralPath $license) {
    Copy-Item -LiteralPath $found.Source -Destination (Join-Path $outDir 'ffmpeg.exe') -Force
    Copy-Item -LiteralPath $license -Destination (Join-Path $outDir 'ffmpeg-LICENSE.txt') -Force
    exit 0
  }
}
$archive = Join-Path ([IO.Path]::GetTempPath()) ('rivals-ffmpeg-' + [guid]::NewGuid() + '.zip')
try {
  Invoke-WebRequest -UseBasicParsing 'https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-full_build.zip' -OutFile $archive
  if ((Get-FileHash $archive).Hash -ne '759D0A9831C436A0EB331AD36F236C06CB04AAA0005DA46571F0E9D3D9206F6B') { throw 'FFmpeg archive checksum mismatch' }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($archive)
  try {
    foreach ($pair in @(@('bin/ffmpeg.exe','ffmpeg.exe'),@('LICENSE','ffmpeg-LICENSE.txt'))) {
      $entry = $zip.GetEntry('ffmpeg-9.0.2-full_build/' + $pair[0])
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,(Join-Path $outDir $pair[1]),$true)
    }
  } finally { $zip.Dispose() }
  if ((Get-FileHash (Join-Path $outDir 'ffmpeg.exe')).Hash -ne $expectedExe) { throw 'FFmpeg executable checksum mismatch' }
} finally { if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive } }
