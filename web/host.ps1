#requires -Version 5.1
<#
.SYNOPSIS
    WiiCompiled for the Web - drop-in host entry point (Windows PowerShell 5.1 or PowerShell 7; Windows / Linux / macOS).

.DESCRIPTION
    1. Put your own game files into web/game/ (see web/game/README.md).
    2. Run: pwsh web/host.ps1

    It finds your disc image (or extracted DATA tree) and an optional Retro Rewind folder, builds
    the site once with web/build.ps1 (translate + compile; slow the first time), remembers what it
    built, and serves web/dist on http://0.0.0.0:8080/. Next runs skip the build until the game
    files or this repository change.

    Same behaviour and options as web/host.sh.

.PARAMETER Game
    Folder with your game files (default: web/game, or $env:MKW_GAME_DIR).

.PARAMETER Port
    Port to serve on (default: 8080, or $env:PORT).

.PARAMETER Bind
    Address to bind (default: 0.0.0.0, all interfaces).

.PARAMETER Lan
    Listen on all interfaces (already the default here; same as -Bind 0.0.0.0).

.PARAMETER Https
    Serve HTTPS with a self-signed certificate (generated once, cached in web/.certs/). Other
    devices need HTTPS for WebGPU; their browsers show a one-time certificate warning.

.PARAMETER Cert
    Serve HTTPS with your own certificate (PEM) instead; implies -Https. Use with -Key.

.PARAMETER Key
    Private key (PEM) for -Cert.

.PARAMETER San
    Extra host name or IP address the generated certificate must be valid for (repeatable).

.PARAMETER BuildOnly
    Build (if needed) and exit; do not start the server.

.PARAMETER ServeOnly
    Serve the existing web/dist; never build.

.PARAMETER Rebuild
    Build again even if nothing changed (compile caches are still reused).

.PARAMETER Jobs
    Limit build parallelism to N (use this on machines with little RAM).

.PARAMETER Out
    Site output directory (default: web/dist).

.NOTES
    The game folder must contain EITHER one disc image (.iso .gcm .gcz .ciso .wbfs .wia .rvz) OR an
    extracted DATA partition (a folder with sys/main.dol and files/), and OPTIONALLY the Retro Rewind
    folder (RetroRewind6/, which contains Binaries/Code.pul) to also offer Retro Rewind.
    The bash-style spellings (--game DIR, --port N, --build-only, ...) are accepted too.

.EXAMPLE
    pwsh web/host.ps1
    pwsh web/host.ps1 -Game D:\mkw -Port 9000
    pwsh web/host.ps1 -BuildOnly -Jobs 2
#>
[CmdletBinding()]
param(
    [string]$Game,
    [int]$Port = 0,
    [string]$Bind,
    [switch]$Lan,
    [switch]$Https,
    [string]$Cert,
    [string]$Key,
    [string[]]$San = @(),
    [switch]$BuildOnly,
    [switch]$ServeOnly,
    [switch]$Rebuild,
    [int]$Jobs = 0,
    [string]$Out,
    [Alias('h')][switch]$Help,
    # Bash-style spellings (--game DIR, --port N, --bind ADDR, --build-only, --serve-only, --rebuild,
    # --jobs N, --out DIR, --help) land here and are re-parsed below.
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # no progress bars (slow in Windows PowerShell 5.1, noise when output is captured)

$DiscExtensions = @('.iso', '.gcm', '.gcz', '.ciso', '.wbfs', '.wia', '.rvz')
$FingerprintFile = '.build-fingerprint'
$EmscriptenRecommended = '6.0.12'
$NodToolVersion = 'v2.0.0-alpha.10'   # keep in step with web/build.ps1

# Windows PowerShell 5.1 has no $IsWindows variable.
$onWindows = ($env:OS -eq 'Windows_NT')
$workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path

function Write-Say([string]$Text) { Write-Host $Text }
function Stop-Host([string]$Text) {
    [Console]::Error.WriteLine("host.ps1: error: $Text")
    exit 1
}
function Stop-WithHelp([string]$Text, [int]$Code = 2) {
    [Console]::Error.WriteLine($Text)
    exit $Code
}

function Show-Usage {
    @'
Usage: pwsh web/host.ps1 [options]

Builds (once) and serves WiiCompiled in the browser from the game files you drop in web/game/.

  -Game DIR       Folder with your game files (default: web/game, or $env:MKW_GAME_DIR)
  -Port N         Port to serve on (default: 8080, or $env:PORT)
  -Bind ADDR      Address to bind (default: 0.0.0.0, all interfaces)
  -Lan            Listen on all interfaces (already the default here; same as -Bind 0.0.0.0)
  -Https          Serve HTTPS with a self-signed certificate (generated once, cached in web/.certs/);
                  other devices need HTTPS for WebGPU and see a one-time browser warning
  -Cert FILE -Key FILE
                  Serve HTTPS with your own certificate instead (implies -Https)
  -San NAME       Extra host name or IP for the generated certificate (repeatable)
  -BuildOnly      Build (if needed) and exit; do not start the server
  -ServeOnly      Serve the existing web/dist; never build
  -Rebuild        Build again even if nothing changed (compile caches are still reused)
  -Jobs N         Limit build parallelism to N (use this on machines with little RAM)
  -Out DIR        Site output directory (default: web/dist)
  -Help           Show this help (also: -h, --help)
  (bash-style --game/--port/--bind/--lan/--https/--cert/--key/--san/--build-only/--serve-only/--rebuild/--jobs/--out also work)

The game folder must contain EITHER one disc image (.iso .gcm .gcz .ciso .wbfs .wia .rvz) OR an
extracted DATA partition (a folder with sys/main.dol and files/), and OPTIONALLY the Retro Rewind
folder (RetroRewind6/, which contains Binaries/Code.pul) to also offer Retro Rewind.
'@ | Write-Host
}

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------
if ($Help) { Show-Usage; exit 0 }
$restArgs = @($Rest | Where-Object { $null -ne $_ })
$i = 0
while ($i -lt $restArgs.Count) {
    $a = [string]$restArgs[$i]
    switch -Regex ($a) {
        '^--?(h|help|\?)$' { Show-Usage; exit 0 }
        '^--game$' { $i++; $Game = [string]$restArgs[$i] }
        '^--port$' { $i++; $Port = [int]$restArgs[$i] }
        '^--bind$' { $i++; $Bind = [string]$restArgs[$i] }
        '^--lan$' { $Lan = [switch]$true }
        '^--https$' { $Https = [switch]$true }
        '^--cert$' { $i++; $Cert = [string]$restArgs[$i] }
        '^--key$' { $i++; $Key = [string]$restArgs[$i] }
        '^--san$' { $i++; $San += [string]$restArgs[$i] }
        '^--out$' { $i++; $Out = [string]$restArgs[$i] }
        '^--jobs$' { $i++; $Jobs = [int]$restArgs[$i] }
        '^--build-only$' { $BuildOnly = [switch]$true }
        '^--serve-only$' { $ServeOnly = [switch]$true }
        '^--rebuild$' { $Rebuild = [switch]$true }
        default { Show-Usage; Stop-Host "unknown option: $a" }
    }
    $i++
}
if ($BuildOnly -and $ServeOnly) { Stop-Host '-BuildOnly and -ServeOnly cannot be combined' }

if (-not $Game) { $Game = if ($env:MKW_GAME_DIR) { $env:MKW_GAME_DIR } else { Join-Path $workspace 'web/game' } }
if ($Port -le 0) { $Port = if ($env:PORT) { [int]$env:PORT } else { 8080 } }
if (-not $Bind) { $Bind = '0.0.0.0' }
if ($Lan) { $Bind = '0.0.0.0' }
if ($Cert) { $Https = [switch]$true }
$serveExtra = @()
if ($Https) { $serveExtra += '--https' }
if ($Cert) { $serveExtra += @('--cert', $Cert) }
if ($Key) { $serveExtra += @('--key', $Key) }
foreach ($name in $San) { if ($name) { $serveExtra += @('--san', $name) } }
if ($Jobs -le 0 -and $env:MKW_JOBS) { $Jobs = [int]$env:MKW_JOBS }

$outDir = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine((Get-Location).ProviderPath, $(if ($Out) { $Out } else { Join-Path $workspace 'web/dist' })))
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
function Test-Command([string]$Name) { return [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

function Get-StringSha256([string]$Text) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return ([System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Text))) -replace '-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}
function Get-FileSha256([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

# $pythonCmd is an array: executable followed by fixed leading arguments (e.g. py -3).
function Find-Python {
    # Built in a list: an if-expression unrolls one level, so a lone @(, @(path)) would become the
    # path string itself and $cand[0] its first character ("C"), hiding a valid $env:PYTHON.
    $candidates = New-Object System.Collections.Generic.List[object]
    if ($env:PYTHON) { $candidates.Add(@($env:PYTHON)) } else { $candidates.Add(@('python3')); $candidates.Add(@('python')); $candidates.Add(@('py', '-3')) }
    foreach ($cand in $candidates) {
        if (-not (Test-Command $cand[0])) { continue }
        $leading = @($cand | Select-Object -Skip 1)
        # Relax $ErrorActionPreference: Windows PowerShell 5.1 can turn native stderr into a terminating error.
        $saved = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try { & $cand[0] @leading -c 'import sys; sys.exit(0 if sys.version_info[0] >= 3 else 1)' 2>$null } catch { $global:LASTEXITCODE = 1 } finally { $ErrorActionPreference = $saved }
        if ($LASTEXITCODE -eq 0) { return , $cand }
    }
    return $null
}

# ---------------------------------------------------------------------------
# Serve
# ---------------------------------------------------------------------------
function Start-Serving {
    if (-not (Test-Path -LiteralPath (Join-Path $outDir 'index.html') -PathType Leaf)) {
        Stop-Host "nothing to serve in $outDir yet. Run web/host.ps1 without -ServeOnly to build first."
    }
    $py = Find-Python
    if (-not $py) { Stop-Host 'Python 3 is needed to serve the site (https://www.python.org/downloads/)' }
    $shown = if ($Bind -in @('0.0.0.0', '::')) { 'localhost' } else { $Bind }
    Write-Say ''
    if ($Https) {
        Write-Say 'Serving over HTTPS (the addresses to open are listed below).'
    } else {
        Write-Say "Serving the game at  http://${shown}:$Port/"
        Write-Say 'Players need Chrome or Edge 137+ (WebGPU). Other computers need HTTPS to use WebGPU:'
        Write-Say 'run again with -Https (self-signed certificate, see docs/web-hosting.md) or put this behind'
        Write-Say 'a TLS proxy (Caddy, nginx, a tunnel); http://localhost works as is.'
    }
    Write-Say ''
    $lead = @($py | Select-Object -Skip 1)
    & $py[0] @lead (Join-Path $workspace 'web/serve.py') --dir $outDir --bind $Bind --port "$Port" @serveExtra
    exit $LASTEXITCODE
}

if ($ServeOnly) { Start-Serving }

# ---------------------------------------------------------------------------
# Find the game files
# ---------------------------------------------------------------------------
if (-not (Test-Path -LiteralPath $Game -PathType Container)) {
    try { New-Item -ItemType Directory -Force -Path $Game | Out-Null } catch { }
}
if (-not (Test-Path -LiteralPath $Game -PathType Container)) { Stop-Host "game folder does not exist and could not be created: $Game" }
$gameDir = (Resolve-Path -LiteralPath $Game).Path

# Disc images (up to two levels deep, so a games/ subfolder works).
$images = @(Get-ChildItem -LiteralPath $gameDir -Recurse -Depth 1 -File -ErrorAction SilentlyContinue |
    Where-Object { $DiscExtensions -contains $_.Extension.ToLowerInvariant() -and -not $_.Name.StartsWith('._') } |
    Sort-Object FullName | ForEach-Object { $_.FullName })

# Extracted DATA trees: game/sys/main.dol, or one folder deeper (game/DATA/sys/main.dol).
$trees = @()
if (Test-Path -LiteralPath (Join-Path $gameDir 'sys/main.dol') -PathType Leaf) {
    $trees = @($gameDir)
} else {
    $trees = @(Get-ChildItem -LiteralPath $gameDir -Recurse -Depth 2 -File -Filter 'main.dol' -ErrorAction SilentlyContinue |
        Where-Object { $_.Directory.Name -eq 'sys' } | Sort-Object FullName | ForEach-Object { $_.Directory.Parent.FullName })
}

# Retro Rewind: RetroRewind6/Binaries/Code.pul, directly or inside a parent folder.
$pulFiles = @(Get-ChildItem -LiteralPath $gameDir -Recurse -Depth 3 -File -Filter 'Code.pul' -ErrorAction SilentlyContinue |
    Where-Object { $_.Directory.Name -eq 'Binaries' } | Sort-Object FullName | ForEach-Object { $_.FullName })

if ($images.Count -gt 0 -and $trees.Count -gt 0) {
    Stop-WithHelp @"

Found both a disc image and an extracted game folder in ${gameDir}:
    $($images[0])
    $($trees[0])
Keep only one of them (move the other out of the folder) and run web/host.ps1 again.
"@
}
if ($images.Count -gt 1) {
    Stop-WithHelp @"

Found $($images.Count) disc images in ${gameDir}, but exactly one is wanted:
$(($images | ForEach-Object { "    $_" }) -join "`n")
Move the extra ones out of the folder and run web/host.ps1 again.
"@
}
if ($trees.Count -gt 1) {
    Stop-WithHelp @"

Found $($trees.Count) extracted game folders (with sys/main.dol) in ${gameDir}:
$(($trees | ForEach-Object { "    $_" }) -join "`n")
Keep only one and run web/host.ps1 again.
"@
}
if ($pulFiles.Count -gt 1) {
    Stop-WithHelp @"

Found $($pulFiles.Count) Retro Rewind Code.pul files in ${gameDir}:
$(($pulFiles | ForEach-Object { "    $_" }) -join "`n")
Keep only one Retro Rewind folder and run web/host.ps1 again.
"@
}

if ($images.Count -eq 1) {
    $gameInput = $images[0]; $inputKind = 'image'
} elseif ($trees.Count -eq 1) {
    $gameInput = $trees[0]; $inputKind = 'tree'
} else {
    Stop-WithHelp @"

No game files found in:
    $gameDir

  1. Put ONE of these into that folder:
       - your own PAL (RMCP01) Mario Kart Wii disc image:
         .iso .gcm .gcz .ciso .wbfs .wia or .rvz
       - or an already extracted DATA partition: a folder that contains
         sys/main.dol and files/
  2. Optional, for Retro Rewind: also drop the RetroRewind6 folder there
     (the one that contains Binaries/Code.pul).
  3. Run web/host.ps1 again.

The files stay on your machine; nothing is ever uploaded or committed.
"@
}

$retroRoot = $null
if ($pulFiles.Count -eq 1) { $retroRoot = (Get-Item -LiteralPath $pulFiles[0]).Directory.Parent.FullName }

Write-Say 'Game files:'
Write-Say "    base game:     $gameInput ($inputKind)"
Write-Say $(if ($retroRoot) { "    Retro Rewind:  $retroRoot" } else { '    Retro Rewind:  not found (optional)' })

# ---------------------------------------------------------------------------
# Fingerprint = game inputs + repository version
# ---------------------------------------------------------------------------
function Get-RepoVersion {
    if ($env:MKW_REPO_COMMIT) { return $env:MKW_REPO_COMMIT }
    if (Test-Command 'git') {
        $head = (& git -C $workspace rev-parse HEAD 2>$null)
        if ($LASTEXITCODE -eq 0 -and $head) {
            # Uncommitted edits to tracked files change the build too.
            $diff = (& git -C $workspace diff HEAD 2>$null | Out-String)
            return "$head+$(Get-StringSha256 $diff)"
        }
    }
    $stampFile = Join-Path $workspace '.repo-commit'
    if (Test-Path -LiteralPath $stampFile -PathType Leaf) { return (Get-Content -LiteralPath $stampFile -Raw).Trim() }
    return 'unknown'
}

function Get-Fingerprint {
    $lines = @("repo=$(Get-RepoVersion)")
    if ($inputKind -eq 'image') {
        $info = Get-Item -LiteralPath $gameInput
        $mtime = ([DateTimeOffset]$info.LastWriteTimeUtc).ToUnixTimeSeconds()
        $lines += "image=$gameInput|$($info.Length)-$mtime"
    } else {
        $lines += "dol=$(Get-FileSha256 (Join-Path $gameInput 'sys/main.dol'))"
        $rel = Join-Path $gameInput 'files/rel/StaticR.rel'
        if (Test-Path -LiteralPath $rel -PathType Leaf) { $lines += "rel=$(Get-FileSha256 $rel)" }
    }
    if ($retroRoot) {
        $rrFiles = @(Get-ChildItem -LiteralPath $retroRoot -Recurse -File -Force)
        $rrBytes = ($rrFiles | Measure-Object -Property Length -Sum).Sum
        $lines += "rr-pul=$(Get-FileSha256 (Join-Path $retroRoot 'Binaries/Code.pul'))"
        $lines += "rr-tree=$($rrFiles.Count)|$rrBytes"
    } else {
        $lines += 'rr=none'
    }
    return Get-StringSha256 ($lines -join "`n")
}

$fingerprint = Get-Fingerprint
$fingerprintPath = Join-Path $outDir $FingerprintFile
$builtFingerprint = ''
if (Test-Path -LiteralPath $fingerprintPath -PathType Leaf) { $builtFingerprint = (Get-Content -LiteralPath $fingerprintPath -Raw).Trim() }

$siteComplete = (Test-Path -LiteralPath (Join-Path $outDir 'index.html') -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $outDir 'products.json') -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $outDir 'disc-manifest.json') -PathType Leaf)

if ((-not $Rebuild) -and ($builtFingerprint -eq $fingerprint) -and $siteComplete) {
    Write-Say ''
    Write-Say 'web/dist is up to date for these game files and this version; skipping the build.'
    Write-Say '(Use -Rebuild to build again.)'
    if ($BuildOnly) { exit 0 }
    Start-Serving
}

# ---------------------------------------------------------------------------
# Prerequisites (only needed to build)
# ---------------------------------------------------------------------------
$missing = @()

if (-not (Test-Command 'emcc') -and $env:EMSDK) {
    $envScript = Join-Path $env:EMSDK 'emsdk_env.ps1'
    if (Test-Path -LiteralPath $envScript -PathType Leaf) {
        $env:EMSDK_QUIET = '1'
        try { . $envScript *> $null } catch { }
    }
}
if (-not (Test-Command 'emcc')) {
    $missing += "Emscripten ${EmscriptenRecommended}:  git clone https://github.com/emscripten-core/emsdk; cd emsdk; ./emsdk install $EmscriptenRecommended; ./emsdk activate $EmscriptenRecommended`n       then run emsdk_env.ps1 in this shell (or set `$env:EMSDK to the checkout) before web/host.ps1"
}
if (Test-Command 'dotnet') {
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $sdks = @(& dotnet --list-sdks 2>$null | ForEach-Object { ($_ -split '\s+')[0] }) } catch { $sdks = @() } finally { $ErrorActionPreference = $saved }
    if (@($sdks | Where-Object { $_ -like '8.*' }).Count -eq 0) { $missing += '.NET 8 SDK (a different version is installed):  https://dotnet.microsoft.com/download/dotnet/8.0' }
} else {
    $missing += '.NET 8 SDK:  https://dotnet.microsoft.com/download/dotnet/8.0   (winget install Microsoft.DotNet.SDK.8)'
}
if (-not (Test-Command 'cmake')) { $missing += 'CMake 3.25 or newer:  https://cmake.org/download/   (winget install Kitware.CMake)' }
if (-not (Test-Command 'ninja')) { $missing += 'Ninja:  winget install Ninja-build.Ninja   (apt install ninja-build / brew install ninja)' }
if (-not (Find-Python)) { $missing += 'Python 3:  https://www.python.org/downloads/' }
if ($inputKind -eq 'image') {
    $exeSuffix = if ($onWindows) { '.exe' } else { '' }
    $haveExtractor = [bool]$env:MKW_DISC_EXTRACT_CMD -or [bool]$env:NODTOOL -or (Test-Command 'nodtool') -or
        (Test-Path -LiteralPath (Join-Path $workspace "Launcher/artifacts/nodtool$exeSuffix") -PathType Leaf) -or
        (Test-Command 'DolphinTool') -or (Test-Command 'dolphin-tool')
    if (-not $haveExtractor) {
        $missing += "nodtool (disc extractor):  download it from https://github.com/encounter/nod/releases/tag/$NodToolVersion,`n       put it on PATH (or set `$env:NODTOOL to its path). Or drop an already extracted game folder instead of an image."
    }
}

if ($missing.Count -gt 0) {
    [Console]::Error.WriteLine('')
    [Console]::Error.WriteLine('Building needs a few tools that are not installed here:')
    $n = 0
    foreach ($m in $missing) { $n++; [Console]::Error.WriteLine(('  {0}. {1}' -f $n, $m)) }
    [Console]::Error.WriteLine('')
    [Console]::Error.WriteLine('Easier: skip all of that and use Docker, which has everything built in:')
    [Console]::Error.WriteLine('    docker compose up        (run from the repository root; reads the same web/game folder)')
    exit 1
}

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
# A hashtable splat binds named parameters (an array splat would pass them as plain text).
$buildParams = @{ Out = $outDir }
if ($retroRoot) { $buildParams['RetroRewind'] = $retroRoot }
if ($Jobs -gt 0) { $buildParams['Jobs'] = $Jobs }

Write-Say ''
Write-Say 'Building (the first build translates and compiles the whole game and can take a long time;'
Write-Say 'later runs reuse it). Progress follows.'
Remove-Item -LiteralPath $fingerprintPath -Force -ErrorAction SilentlyContinue   # a half-built site must never count as current
$buildScript = if ($env:MKW_BUILD_SCRIPT) { $env:MKW_BUILD_SCRIPT } else { Join-Path $PSScriptRoot 'build.ps1' }
$global:LASTEXITCODE = 0
& $buildScript $gameInput @buildParams
if ((-not $?) -or $LASTEXITCODE -ne 0) {
    [Console]::Error.WriteLine('')
    [Console]::Error.WriteLine('The build failed (see the messages above).')
    [Console]::Error.WriteLine('Common causes: not an unmodified PAL (RMCP01) copy of Mario Kart Wii, or too little RAM (try -Jobs 2).')
    exit 1
}
[System.IO.File]::WriteAllText($fingerprintPath, $fingerprint + "`n")

if ($BuildOnly) {
    Write-Say ''
    Write-Say "Build finished: $outDir"
    exit 0
}
Start-Serving
