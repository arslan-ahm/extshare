# Installs the extshare CLI on Windows from GitHub Releases.
#
#   irm https://extshare.vercel.app/install.ps1 | iex
#
# Environment:
#   EXTSHARE_VERSION         release tag to install, e.g. v0.1.0 (default: latest)
#   EXTSHARE_INSTALL_DIR     where to put extshare.exe (default: %LOCALAPPDATA%\extshare\bin)
#   EXTSHARE_DOWNLOAD_BASE   override the download URL (used by tests and mirrors)
#   EXTSHARE_NO_MODIFY_PATH  set to 1 to leave your user PATH unchanged
#
# The binary is checked against the release's SHA256SUMS before it is installed.
# Everything runs inside one script block so a partially downloaded script does nothing.

& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $repo = 'arslan-ahm/extshare'
  $asset = 'extshare-windows-x64.exe'
  $version = if ($env:EXTSHARE_VERSION) { $env:EXTSHARE_VERSION } else { 'latest' }
  if ($env:EXTSHARE_DOWNLOAD_BASE) {
    $base = $env:EXTSHARE_DOWNLOAD_BASE
  } elseif ($version -eq 'latest') {
    $base = "https://github.com/$repo/releases/latest/download"
  } else {
    $base = "https://github.com/$repo/releases/download/$version"
  }
  $dir = if ($env:EXTSHARE_INSTALL_DIR) { $env:EXTSHARE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'extshare\bin' }

  if (-not [Environment]::Is64BitOperatingSystem) {
    throw 'extshare install: a 64-bit version of Windows is required.'
  }

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("extshare-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    Write-Host "Downloading $asset ($version)..."
    $exe = Join-Path $tmp $asset
    $sums = Join-Path $tmp 'SHA256SUMS'
    try {
      Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile $exe
      Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile $sums
    } catch {
      throw "extshare install: could not download from $base ($($_.Exception.Message))"
    }

    $expected = $null
    foreach ($line in Get-Content $sums) {
      $parts = $line -split '\s+', 2
      if ($parts.Count -eq 2 -and $parts[1].TrimStart('*') -eq $asset) { $expected = $parts[0] }
    }
    if (-not $expected) { throw "extshare install: SHA256SUMS has no entry for $asset" }
    $actual = (Get-FileHash -Algorithm SHA256 $exe).Hash
    if ($actual -ne $expected) {
      throw "extshare install: checksum mismatch for $asset (expected $expected, got $actual). Nothing was installed."
    }

    $installed = & $exe --version
    if ($LASTEXITCODE -ne 0) { throw 'extshare install: the downloaded binary does not run on this machine' }

    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $target = Join-Path $dir 'extshare.exe'
    Move-Item -Force $exe $target
    Write-Host "Installed $installed to $target"

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $onPath = ($userPath -split ';') -contains $dir
    if (-not $onPath -and $env:EXTSHARE_NO_MODIFY_PATH -ne '1') {
      [Environment]::SetEnvironmentVariable('Path', (@($userPath, $dir) | Where-Object { $_ }) -join ';', 'User')
      Write-Host "Added $dir to your user PATH. Open a new terminal to use 'extshare'."
    } elseif (-not $onPath) {
      Write-Host "Add $dir to your PATH to run 'extshare' from anywhere."
    }
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}
