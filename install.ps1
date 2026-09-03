$ErrorActionPreference = "Stop"

if (
  $env:OS -ne "Windows_NT" -or
  ($env:PROCESSOR_ARCHITECTURE -ne "AMD64" -and $env:PROCESSOR_ARCHITEW6432 -ne "AMD64")
) {
  throw "Unsupported platform: Colleague Line Preview requires Windows x64"
}

$repo = "JinJieBeWater/colleague-line"
$installDir = if ($env:COLL_INSTALL_DIR) { $env:COLL_INSTALL_DIR } else { "$HOME\.local\bin" }
$version = $env:COLL_VERSION
if (-not $version) {
  $version = (Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest").tag_name
}
if (-not $version.StartsWith("v")) { $version = "v$version" }

$asset = "colleague-line-$version-windows-x64.zip"
$base = "https://github.com/$repo/releases/download/$version"
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("colleague-line-" + [guid]::NewGuid())

try {
  New-Item -ItemType Directory -Force $tmp | Out-Null
  Invoke-WebRequest "$base/$asset" -OutFile "$tmp\$asset"
  Invoke-WebRequest "$base/SHA256SUMS" -OutFile "$tmp\SHA256SUMS"
  $line = Get-Content "$tmp\SHA256SUMS" | Where-Object { $_ -match "\s+$([regex]::Escape($asset))$" }
  if (-not $line) { throw "Missing checksum for $asset" }
  $expected = ($line -split "\s+")[0]
  $actual = (Get-FileHash "$tmp\$asset" -Algorithm SHA256).Hash
  if ($actual -ne $expected) { throw "Checksum mismatch for $asset" }

  Expand-Archive "$tmp\$asset" -DestinationPath $tmp
  $bundle = "$tmp\colleague-line-$($version.TrimStart('v'))-windows-x64"
  New-Item -ItemType Directory -Force $installDir | Out-Null
  Copy-Item "$bundle\coll.exe", "$bundle\colleague-line-transport.exe" $installDir -Force
  Write-Host "Installed Colleague Line $version to $installDir"
  Write-Host "Add $installDir to PATH, then run: coll --version"
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
