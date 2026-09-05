$ErrorActionPreference = "Stop"

if (
  $env:OS -ne "Windows_NT" -or
  ($env:PROCESSOR_ARCHITECTURE -ne "AMD64" -and $env:PROCESSOR_ARCHITEW6432 -ne "AMD64")
) {
  throw "Unsupported platform: Qujing Preview requires Windows x64"
}

$repo = "JinJieBeWater/qujing"
$installDir = if ($env:QUJING_INSTALL_DIR) { $env:QUJING_INSTALL_DIR } else { "$HOME\.local\bin" }
$version = $env:QUJING_VERSION
if (-not $version) {
  $version = (Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest").tag_name
}
if (-not $version.StartsWith("v")) { $version = "v$version" }

$asset = "qujing-$version-windows-x64.zip"
$base = "https://github.com/$repo/releases/download/$version"
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("qujing-" + [guid]::NewGuid())

try {
  New-Item -ItemType Directory -Force $tmp | Out-Null
  Invoke-WebRequest "$base/$asset" -OutFile "$tmp\$asset"
  Invoke-WebRequest "$base/SHA256SUMS" -OutFile "$tmp\SHA256SUMS"
  $entry = Get-Content "$tmp\SHA256SUMS" | Where-Object { $_ -match "\s+$([regex]::Escape($asset))$" }
  if (-not $entry) { throw "Missing checksum for $asset" }
  $expected = ($entry -split "\s+")[0]
  $actual = (Get-FileHash "$tmp\$asset" -Algorithm SHA256).Hash
  if ($actual -ne $expected) { throw "Checksum mismatch for $asset" }

  Expand-Archive "$tmp\$asset" -DestinationPath $tmp
  $bundle = "$tmp\qujing-$($version.TrimStart('v'))-windows-x64"
  New-Item -ItemType Directory -Force $installDir | Out-Null
  Copy-Item "$bundle\qj.exe", "$bundle\qujing-transport.exe" $installDir -Force
  Write-Host "Installed Qujing $version to $installDir"
  Write-Host "Add $installDir to PATH, then run: qj --version"
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
