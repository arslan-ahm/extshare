# Installs extshare on Windows from https://extshare.vercel.app.
#
#   irm https://extshare.vercel.app/install.ps1 | iex                                  # the CLI: extshare
#   $env:EXTSHARE_COMPONENT='server'; irm https://extshare.vercel.app/install.ps1 | iex  # the server: extshare-server
#
# extshare runs on Bun (https://bun.sh). If Bun 1.3 or newer is not installed, this script installs it
# with Bun's official installer first.
#
# Environment:
#   EXTSHARE_COMPONENT       cli (default) or server
#   EXTSHARE_HOME            install location (default: %LOCALAPPDATA%\extshare; commands go in its bin folder)
#   EXTSHARE_BUN             path of bun.exe to use
#   EXTSHARE_NO_BUN_INSTALL  set to 1 to fail instead of installing Bun
#   EXTSHARE_NO_MODIFY_PATH  set to 1 to leave your user PATH unchanged
#   EXTSHARE_DOWNLOAD_BASE   download URL override (used by tests and mirrors)
#
# Downloads are checked against SHA256SUMS before anything is installed.
# Everything runs inside one script block so a partially downloaded script does nothing.

& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $component = if ($env:EXTSHARE_COMPONENT) { $env:EXTSHARE_COMPONENT } else { 'cli' }
  switch ($component) {
    'cli' { $tool = 'extshare' }
    'server' { $tool = 'extshare-server' }
    default { throw "extshare install: unknown component '$component'. Use cli (default) or server." }
  }
  $file = "$tool.js"
  $base = if ($env:EXTSHARE_DOWNLOAD_BASE) { $env:EXTSHARE_DOWNLOAD_BASE } else { 'https://extshare.vercel.app/download' }
  $root = if ($env:EXTSHARE_HOME) { $env:EXTSHARE_HOME } else { Join-Path $env:LOCALAPPDATA 'extshare' }
  $binDir = Join-Path $root 'bin'
  $libDir = Join-Path $root 'lib'

  # Find Bun 1.3+, installing it if needed.
  $bunHome = Join-Path $env:USERPROFILE '.bun\bin\bun.exe'
  if ($env:EXTSHARE_BUN) {
    $bun = $env:EXTSHARE_BUN
  } elseif (Get-Command bun -ErrorAction SilentlyContinue) {
    $bun = (Get-Command bun).Source
  } elseif (Test-Path $bunHome) {
    $bun = $bunHome
  } elseif ($env:EXTSHARE_NO_BUN_INSTALL -eq '1') {
    throw 'extshare install: Bun 1.3 or newer is required. Install it from https://bun.sh and run this again.'
  } else {
    Write-Host 'extshare runs on Bun, which is not installed. Installing it from https://bun.sh ...'
    # In a child process, so nothing Bun's installer does (exit, preference changes) affects this script.
    & powershell -NoProfile -ExecutionPolicy Bypass -Command 'irm https://bun.sh/install.ps1 | iex'
    if ($LASTEXITCODE -ne 0) { throw 'extshare install: installing Bun failed; install it from https://bun.sh and run this again.' }
    $bun = $bunHome
  }
  if (-not (Test-Path $bun)) { throw "extshare install: bun not found at $bun" }
  $bunVersion = (& $bun --version).Trim()
  $parts = $bunVersion.Split('.')
  if ([int]$parts[0] -lt 1 -or ([int]$parts[0] -eq 1 -and [int]$parts[1] -lt 3)) {
    throw "extshare install: Bun $bunVersion is too old; extshare needs 1.3 or newer. Run: bun upgrade"
  }

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("extshare-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    Write-Host "Downloading $file..."
    $js = Join-Path $tmp $file
    $sums = Join-Path $tmp 'SHA256SUMS'
    try {
      Invoke-WebRequest -UseBasicParsing -Uri "$base/$file" -OutFile $js
      Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile $sums
    } catch {
      throw "extshare install: could not download from $base ($($_.Exception.Message))"
    }

    $expected = $null
    foreach ($line in Get-Content $sums) {
      $p = $line -split '\s+', 2
      if ($p.Count -eq 2 -and $p[1].TrimStart('*') -eq $file) { $expected = $p[0] }
    }
    if (-not $expected) { throw "extshare install: SHA256SUMS has no entry for $file" }
    $actual = (Get-FileHash -Algorithm SHA256 $js).Hash
    if ($actual -ne $expected) {
      throw "extshare install: checksum mismatch for $file (expected $expected, got $actual). Nothing was installed."
    }

    $version = & $bun $js --version
    if ($LASTEXITCODE -ne 0) { throw "extshare install: the downloaded $file does not run with $bun" }

    New-Item -ItemType Directory -Force -Path $binDir, $libDir | Out-Null
    $target = Join-Path $libDir $file
    Move-Item -Force $js $target
    $launcher = Join-Path $binDir "$tool.cmd"
    Set-Content -Path $launcher -Encoding ASCII -Value "@`"$bun`" `"$target`" %*"
    Write-Host "Installed ${version}: $launcher"

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $onPath = ($userPath -split ';') -contains $binDir
    if (-not $onPath -and $env:EXTSHARE_NO_MODIFY_PATH -ne '1') {
      [Environment]::SetEnvironmentVariable('Path', (@($userPath, $binDir) | Where-Object { $_ }) -join ';', 'User')
      Write-Host "Added $binDir to your user PATH. Open a new terminal to use '$tool'."
    } elseif (-not $onPath) {
      Write-Host "Add $binDir to your PATH to run '$tool' from anywhere."
    }
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}
