#requires -Version 5.1
<#
.SYNOPSIS
    WiiCompiled for the Web - operator pipeline (Windows PowerShell 5.1 or PowerShell 7; Windows / Linux / macOS).

.DESCRIPTION
    Takes the operator's own PAL (RMCP01) Mario Kart Wii disc image (or an already extracted DATA
    tree), extracts it, runs the same translator pipeline as Launcher/local-build.sh, compiles the
    runtime + translated code to WebAssembly with Emscripten, and writes a self-contained static
    site (default web/dist/). With -RetroRewind it also builds the Retro Rewind product.
    Any static web server with HTTP Range support can host that directory; web/serve.py is a
    small one for local testing. The repository itself never contains game data.

    Same behaviour and options as web/build.sh.

.PARAMETER DiscImage
    Your own PAL Mario Kart Wii (RMCP01) disc image (ISO, GCM, GCZ, CISO, WBFS, WIA or RVZ) OR an
    already extracted DATA partition tree (a folder with sys/main.dol and files/; one extra level of
    nesting such as DIR/DATA/sys/main.dol is accepted). A tree skips the extraction; the clean-PAL
    hash check still runs.

.PARAMETER Out
    Output site directory (default: web/dist).

.PARAMETER BuildDir
    CMake/Ninja + disc extraction work directory (default: web/build).

.PARAMETER Jobs
    Pin translator threads, translated-shard compile pool and Ninja parallelism to N
    (default: derived from CPU count and RAM).

.PARAMETER SkipTranslate
    Reuse the existing generated/ translation (skips translate-recursive and emit-base-manifest;
    generate-data-init and emit-build-shards still run).

.PARAMETER RetroRewind
    Also build Retro Rewind: the RetroRewind6 folder (it contains Binaries/Code.pul) or a folder
    containing RetroRewind6/. Adds the RetroRewind product, dist/mods/RetroRewind6 (+ manifest) and
    dist/products.json lists both products. Networking is compiled out of the web build, so no
    Retro-WFC payload is used.

.NOTES
    Environment variables:
      EMSDK                  emsdk checkout; its emsdk_env.ps1 is sourced if emcc is not on PATH
      NODTOOL                Path to a nodtool binary (otherwise PATH, then Launcher/artifacts/nodtool[.exe])
      MKW_DISC_EXTRACT_CMD   Override the extraction command. Whitespace-separated words, with
                             {IMAGE} and {OUT} replaced, e.g.
                               $env:MKW_DISC_EXTRACT_CMD = 'C:\tools\nodtool.exe extract {IMAGE} {OUT} -q'
                               $env:MKW_DISC_EXTRACT_CMD = 'DolphinTool extract -i {IMAGE} -o {OUT} -p DATA'
                             (paths containing spaces are fine: replacement happens after splitting)
      PYTHON                 Python 3 interpreter (default: python3, then python, then py -3)
      MKW_CMAKE_ARGS         Extra CMake configure arguments, separated by '|' (build.bat uses this for
                             -DCMAKE_TLS_CAINFO and the prebuilt-library package)

.EXAMPLE
    pwsh web/build.ps1 D:\games\mkwii-pal.iso
    pwsh web/build.ps1 ./mkwii-pal.rvz -Out ./site -Jobs 4
    pwsh web/build.ps1 D:\game\DATA -RetroRewind D:\game\RetroRewind6
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)][string]$DiscImage,
    [string]$Out,
    [string]$BuildDir,
    [int]$Jobs = 0,
    [switch]$SkipTranslate,
    [string]$RetroRewind,
    [Alias('h')][switch]$Help,
    # Bash-style spellings (--out DIR, --build-dir DIR, --jobs N, --skip-translate, --retro-rewind DIR, --help)
    # land here and are re-parsed below.
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # no progress bars (slow in Windows PowerShell 5.1, noise when output is captured)

# ---------------------------------------------------------------------------
# Settings you may want to adjust (names of the CMake target and its outputs).
# ---------------------------------------------------------------------------
# CMake targets that link web products: <Target>.js (Emscripten glue) + <Target>.wasm, plus the
# optional extras <Target>.data / <Target>.wasm.map. RetroRewind is added with -RetroRewind.
$BaseTarget = 'WiiCompiled'
$RetroTarget = 'RetroRewind'
$WebExtraSuffixes = @('.data', '.wasm.map')
$DiscManifestName = 'disc-manifest.json'
$ModsDirName = 'mods'
$RetroModDirName = 'RetroRewind6'    # dist/mods/RetroRewind6 + dist/mods/RetroRewind6-manifest.json
$EmscriptenRecommended = '6.0.12'
$CMakeMin = [version]'3.25'
# Pinned clean PAL RMCP01 hashes; identical to projects/mkwii/recomp.yml and
# Launcher/macos/extract-disc.command.
$ExpectedDolSha256 = '80d18895b39c63bd80f457398bfcbb91b7d16ac116a41a88967e954080155b05'
$ExpectedRelSha256 = '16d9d146112541fefea701ecb5bc1a496f9d50e4a752fbb5b6778e7c6399f67d'
$NodToolVersion = 'v2.0.0-alpha.10'  # same release the native setup downloads (Launcher/WiiCompiled.Setup.Common)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
# Windows PowerShell 5.1 has no $IsWindows variable.
$onWindows = ($env:OS -eq 'Windows_NT')
$scriptDir = $PSScriptRoot
$workspace = (Resolve-Path -LiteralPath (Join-Path $scriptDir '..')).Path
$script:stepNo = 0

function Write-Step([string]$Text) {
    $script:stepNo++
    Write-Host ''
    Write-Host ('==> [{0}] {1}' -f $script:stepNo, $Text)
}
function Write-Info([string]$Text) { Write-Host "    $Text" }
function Write-Warn([string]$Text) { [Console]::Error.WriteLine("build.ps1: warning: $Text") }
function Stop-Build([string]$Text) {
    [Console]::Error.WriteLine("build.ps1: error: $Text")
    exit 1
}

function Show-Usage {
    @'
Usage: web/build.ps1 DISC_IMAGE_OR_DIR [options]      (pwsh web/build.ps1 ...)

  DISC_IMAGE_OR_DIR     Your own PAL Mario Kart Wii (RMCP01) disc image (ISO, GCM, GCZ, CISO,
                        WBFS, WIA or RVZ) OR an already extracted DATA partition tree (a folder
                        holding sys/main.dol and files/; DIR/DATA/sys/main.dol also works).

Options:
  -Out DIR              Output site directory (default: web/dist)
  -BuildDir DIR         CMake/Ninja + disc extraction work directory (default: web/build)
  -Jobs N               Pin translator threads, translated-shard compile pool and Ninja
                        parallelism to N (default: derived from CPU count and RAM)
  -SkipTranslate        Reuse the existing generated/ translation (skips translate-recursive and
                        emit-base-manifest; generate-data-init and emit-build-shards still run)
  -RetroRewind DIR      Also build Retro Rewind: DIR is the RetroRewind6 folder (it contains
                        Binaries/Code.pul) or a folder containing RetroRewind6/
  -Help                 Show this help (also: -h, --help)
  (bash-style --out/--build-dir/--jobs/--skip-translate/--retro-rewind are accepted too)

Environment: EMSDK, NODTOOL, MKW_DISC_EXTRACT_CMD, PYTHON (see 'Get-Help web/build.ps1 -Full').
'@ | Write-Host
}

# Accept the bash-style spellings too (--out, --build-dir, --jobs, --skip-translate, --retro-rewind, --help).
if ($Help) { Show-Usage; exit 0 }
$rest = @($Rest | Where-Object { $null -ne $_ })
$i = 0
while ($i -lt $rest.Count) {
    $a = [string]$rest[$i]
    switch -Regex ($a) {
        '^--?(h|help|\?)$' { Show-Usage; exit 0 }
        '^--out$' { $i++; $Out = [string]$rest[$i]; break }
        '^--build-dir$' { $i++; $BuildDir = [string]$rest[$i]; break }
        '^--jobs$' { $i++; $Jobs = [int]$rest[$i]; break }
        '^--skip-translate$' { $SkipTranslate = [switch]$true; break }
        '^--retro-rewind$' { $i++; $RetroRewind = [string]$rest[$i]; break }
        '^-' { Show-Usage; Stop-Build "unknown option: $a" }
        default {
            if ($DiscImage) { Stop-Build "more than one disc image given ('$DiscImage' and '$a')" }
            $DiscImage = $a
        }
    }
    $i++
}

if ($DiscImage -match '^--?(h|help|\?)$') { Show-Usage; exit 0 }
if (-not $DiscImage) { Show-Usage; Stop-Build 'a disc image path is required' }
if (-not (Test-Path -LiteralPath $DiscImage)) { Stop-Build "disc image or extracted tree does not exist: $DiscImage" }
$discIsTree = Test-Path -LiteralPath $DiscImage -PathType Container
if ($RetroRewind -and -not (Test-Path -LiteralPath $RetroRewind -PathType Container)) { Stop-Build "-RetroRewind: not a directory: $RetroRewind" }
if ($Jobs -lt 0) { Stop-Build '-Jobs must be a positive integer' }

function Get-AbsoluteDir([string]$Path) {
    # GetFullPath(path, basePath) is .NET Core only; combine by hand so Windows PowerShell 5.1 works too.
    $full = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine((Get-Location).ProviderPath, $Path))
    New-Item -ItemType Directory -Force -Path $full | Out-Null
    return $full
}

$DiscImage = (Resolve-Path -LiteralPath $DiscImage).Path
$outDir = Get-AbsoluteDir $(if ($Out) { $Out } else { Join-Path $workspace 'web/dist' })
$buildDir = Get-AbsoluteDir $(if ($BuildDir) { $BuildDir } else { Join-Path $workspace 'web/build' })

function Get-Sha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

# SHA-256 over the concatenated bytes of several files (same value as `cat a b c | sha256sum`).
function Get-ConcatSha256([string[]]$Paths) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $buffer = New-Object byte[] (1MB)
        foreach ($p in $Paths) {
            $stream = [System.IO.File]::OpenRead($p)
            try {
                while (($n = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) { [void]$sha.TransformBlock($buffer, 0, $n, $null, 0) }
            } finally { $stream.Dispose() }
        }
        [void]$sha.TransformFinalBlock([byte[]]::new(0), 0, 0)
        return ([System.BitConverter]::ToString($sha.Hash) -replace '-', '').ToLowerInvariant()
    } finally { $sha.Dispose() }
}

function Get-FirstVersion([string]$Text) {
    $m = [regex]::Match($Text, '[0-9]+\.[0-9]+(\.[0-9]+)?')
    if ($m.Success) { return $m.Value }
    return $null
}

function Test-Command([string]$Name) { return [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

# Run a native probe command and return its stdout lines, discarding stderr. Windows PowerShell 5.1
# can turn native stderr into a terminating error under $ErrorActionPreference = 'Stop', so relax it here.
function Get-NativeOutput([string]$Exe, [string[]]$Arguments) {
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = @(& $Exe @Arguments 2>$null)
        return $lines
    } catch {
        $global:LASTEXITCODE = 1
        return @()
    } finally { $ErrorActionPreference = $saved }
}

# Run a native command; stop the build with a message if it exits non-zero.
function Invoke-Native([string]$What, [string]$Exe, [string[]]$Arguments) {
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) { Stop-Build "$What failed (exit code $LASTEXITCODE)" }
}

function Remove-Tree([string]$Path) {
    if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Recurse -Force }
}

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
Write-Step 'Checking prerequisites'

# Emscripten ---------------------------------------------------------------
if (-not (Test-Command 'emcc')) {
    if ($env:EMSDK) {
        $envScript = Join-Path $env:EMSDK 'emsdk_env.ps1'
        if (Test-Path -LiteralPath $envScript -PathType Leaf) {
            Write-Info "emcc not on PATH; sourcing $envScript"
            $env:EMSDK_QUIET = '1'
            try { . $envScript *> $null } catch { }
        }
    }
}
if (-not (Test-Command 'emcc')) {
    Stop-Build @"
Emscripten (emcc) was not found. Install emsdk (https://emscripten.org/docs/getting_started/downloads.html):
    git clone https://github.com/emscripten-core/emsdk; cd emsdk; ./emsdk install $EmscriptenRecommended; ./emsdk activate $EmscriptenRecommended
  then run emsdk_env.ps1 in this shell, or set `$env:EMSDK to the checkout.
"@
}
if (-not (Test-Command 'emcmake')) { Stop-Build 'emcmake not found next to emcc; your Emscripten install looks incomplete' }
$emccVersion = $null
try { $emccVersion = Get-FirstVersion ((Get-NativeOutput 'emcc' @('--version') | Select-Object -First 1) | Out-String) } catch { }
if (-not $emccVersion) {
    Write-Warn "could not determine the Emscripten version; $EmscriptenRecommended is recommended"
} elseif ($emccVersion -ne $EmscriptenRecommended) {
    Write-Warn "Emscripten $emccVersion found; $EmscriptenRecommended is the tested version (JSPI flags differ between releases)"
} else {
    Write-Info "Emscripten $emccVersion"
}

# .NET 8 SDK ----------------------------------------------------------------
if (-not (Test-Command 'dotnet')) { Stop-Build '.NET SDK not found. Install the .NET 8 SDK: https://dotnet.microsoft.com/download/dotnet/8.0' }
$sdks = @(Get-NativeOutput 'dotnet' @('--list-sdks') | ForEach-Object { ($_ -split '\s+')[0] })
$sdk8 = @($sdks | Where-Object { $_ -like '8.*' })
if ($sdk8.Count -eq 0) {
    Stop-Build ".NET 8 SDK not found (installed SDKs: $($sdks -join ' ')). The translator targets net8.0; install https://dotnet.microsoft.com/download/dotnet/8.0"
}
Write-Info ".NET SDK $($sdk8[-1])"

# CMake >= 3.25, Ninja ------------------------------------------------------
if (-not (Test-Command 'cmake')) { Stop-Build "CMake not found (need >= $CMakeMin): https://cmake.org/download/" }
$cmakeVersionText = Get-FirstVersion ((& cmake --version | Select-Object -First 1) | Out-String)
if (-not $cmakeVersionText -or ([version]$cmakeVersionText) -lt $CMakeMin) {
    Stop-Build "CMake $cmakeVersionText is too old; need >= $CMakeMin"
}
Write-Info "CMake $cmakeVersionText"
if (-not (Test-Command 'ninja')) { Stop-Build 'Ninja not found (winget install Ninja-build.Ninja / apt install ninja-build / brew install ninja)' }
Write-Info "Ninja $(& ninja --version)"

# Python 3 ------------------------------------------------------------------
# $pythonCmd is an array: executable followed by fixed leading arguments (e.g. py -3).
$pythonCmd = $null
# Built in a list: an if-expression unrolls one level, so a lone @(, @(path)) would become the
# path string itself and $cand[0] its first character ("C"), hiding a valid $env:PYTHON.
$pythonCandidates = New-Object System.Collections.Generic.List[object]
if ($env:PYTHON) { $pythonCandidates.Add(@($env:PYTHON)) } else { $pythonCandidates.Add(@('python3')); $pythonCandidates.Add(@('python')); $pythonCandidates.Add(@('py', '-3')) }
foreach ($cand in $pythonCandidates) {
    if (-not (Test-Command $cand[0])) { continue }
    $leading = @($cand | Select-Object -Skip 1)
    [void](Get-NativeOutput $cand[0] (@($leading) + @('-c', 'import sys; sys.exit(0 if sys.version_info[0] >= 3 else 1)')))
    if ($LASTEXITCODE -eq 0) { $pythonCmd = $cand; break }
}
if (-not $pythonCmd) { Stop-Build "Python 3 not found (tried: $(($pythonCandidates | ForEach-Object { $_ -join ' ' }) -join ', ')); install it or set `$env:PYTHON" }
$pythonExe = $pythonCmd[0]
$pythonLead = @($pythonCmd | Select-Object -Skip 1)
Write-Info "Python $(& $pythonExe @pythonLead -c 'import platform; print(platform.python_version())')"

# Disc extractor ------------------------------------------------------------
# Result: $extractCmd is an array of words with {IMAGE}/{OUT} placeholders.
$extractCmd = @()
if ($discIsTree) {
    Write-Info 'input is an extracted tree; no disc extractor needed'
} elseif ($env:MKW_DISC_EXTRACT_CMD) {
    $extractCmd = @($env:MKW_DISC_EXTRACT_CMD -split '\s+' | Where-Object { $_ })
    Write-Info "disc extractor: MKW_DISC_EXTRACT_CMD ($($env:MKW_DISC_EXTRACT_CMD))"
} else {
    $nodtoolBin = $null
    $exeSuffix = if ($onWindows) { '.exe' } else { '' }
    if ($env:NODTOOL) {
        if (-not (Test-Path -LiteralPath $env:NODTOOL -PathType Leaf)) { Stop-Build "NODTOOL is set but is not a file: $($env:NODTOOL)" }
        $nodtoolBin = $env:NODTOOL
    } elseif (Test-Command 'nodtool') {
        $nodtoolBin = (Get-Command 'nodtool' -CommandType Application | Select-Object -First 1).Source
    } elseif (Test-Path -LiteralPath (Join-Path $workspace "Launcher/artifacts/nodtool$exeSuffix") -PathType Leaf) {
        $nodtoolBin = Join-Path $workspace "Launcher/artifacts/nodtool$exeSuffix" # cached by the native setup
    }
    if ($nodtoolBin) {
        # Same invocation the native setup uses (Launcher/WiiCompiled.Setup.Linux/DiscTool.cs).
        $extractCmd = @($nodtoolBin, 'extract', '{IMAGE}', '{OUT}', '-q')
        Write-Info "disc extractor: nodtool ($nodtoolBin)"
    } else {
        $dolphinBin = $null
        foreach ($candidate in 'DolphinTool', 'dolphin-tool') {
            if (Test-Command $candidate) { $dolphinBin = (Get-Command $candidate -CommandType Application | Select-Object -First 1).Source; break }
        }
        if ($dolphinBin) {
            $extractCmd = @($dolphinBin, 'extract', '-i', '{IMAGE}', '-o', '{OUT}', '-p', 'DATA')
            Write-Info "disc extractor: DolphinTool ($dolphinBin)"
        } else {
            Stop-Build @"
no disc extractor found. Install one of:
    nodtool     https://github.com/encounter/nod/releases/tag/$NodToolVersion  (put it on PATH or set `$env:NODTOOL)
    DolphinTool (ships with Dolphin; 'DolphinTool extract -i IMAGE -o DIR')
  or set `$env:MKW_DISC_EXTRACT_CMD='<command> {IMAGE} {OUT}' for another tool.
"@
        }
    }
}

# Repo files this script relies on -------------------------------------------
$project = Join-Path $workspace 'projects/mkwii/recomp.yml'
if (-not (Test-Path -LiteralPath $project -PathType Leaf)) { Stop-Build "translation project not found: $project" }
$siteSrc = Join-Path $workspace 'web/site'
if (-not (Test-Path -LiteralPath (Join-Path $siteSrc 'index.html') -PathType Leaf)) { Stop-Build "frontend not found: $(Join-Path $siteSrc 'index.html')" }
$manifestTool = Join-Path $workspace 'web/tools/make_disc_manifest.py'
$precompressTool = Join-Path $workspace 'web/tools/precompress_dist.py'
if (-not (Test-Path -LiteralPath $manifestTool -PathType Leaf)) {
    Stop-Build "disc manifest generator is missing: $manifestTool (expected CLI: make_disc_manifest.py <disc_root> <out.json>)"
}

# Retro Rewind input -----------------------------------------------------------
# $retroRoot = the RetroRewind6 folder (has Binaries/Code.pul), found in DIR, DIR/RetroRewind6 or a
# few levels below DIR (e.g. DIR/RetroRewind/RetroRewind6).
$retroRoot = $null
if ($RetroRewind) {
    $rrDir = (Resolve-Path -LiteralPath $RetroRewind).Path
    if (Test-Path -LiteralPath (Join-Path $rrDir 'Binaries/Code.pul') -PathType Leaf) {
        $retroRoot = $rrDir
    } elseif (Test-Path -LiteralPath (Join-Path $rrDir 'RetroRewind6/Binaries/Code.pul') -PathType Leaf) {
        $retroRoot = Join-Path $rrDir 'RetroRewind6'
    } else {
        $puls = @(Get-ChildItem -LiteralPath $rrDir -Recurse -Depth 3 -File -Filter 'Code.pul' -ErrorAction SilentlyContinue |
            Where-Object { $_.Directory.Name -eq 'Binaries' })
        if ($puls.Count -eq 0) {
            Stop-Build "-RetroRewind: no Binaries/Code.pul found in $rrDir. Pass the RetroRewind6 folder (the one that contains Binaries/Code.pul) or its parent."
        }
        if ($puls.Count -gt 1) {
            Stop-Build "-RetroRewind: several Code.pul files found under $rrDir; pass the RetroRewind6 folder itself:`n$(($puls | ForEach-Object { $_.FullName }) -join "`n")"
        }
        $retroRoot = $puls[0].Directory.Parent.FullName
    }
    Write-Info "Retro Rewind: $retroRoot"
}
$buildRetro = [bool]$retroRoot

# ---------------------------------------------------------------------------
# Parallelism (same three knobs as Launcher/local-build.sh)
# ---------------------------------------------------------------------------
$cpuCount = [Math]::Max([Environment]::ProcessorCount, 1)
$memGib = 8
try {
    $totalBytes = [System.GC]::GetGCMemoryInfo().TotalAvailableMemoryBytes # ps51-ok: .NET Core only; falls through to the CIM query below on 5.1
    if ($totalBytes -gt 0) { $memGib = [int][Math]::Floor($totalBytes / 1GB) }
} catch {
    try {
        $cs = Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop
        if ($cs.TotalPhysicalMemory -gt 0) { $memGib = [int][Math]::Floor($cs.TotalPhysicalMemory / 1GB) }
    } catch { }
}
if ($memGib -lt 1) { $memGib = 1 }
if ($Jobs -gt 0) {
    $translatorThreads = $Jobs; $translatedJobs = $Jobs; $globalJobs = $Jobs
} else {
    $translatorThreads = [Math]::Max([Math]::Min($cpuCount, 16), 1)
    $memBasedCap = [Math]::Max([int][Math]::Floor($memGib / 2), 1)
    $translatedJobs = [Math]::Max([Math]::Min($cpuCount, $memBasedCap), 1)
    $globalJobs = [Math]::Max($translatedJobs, $cpuCount)
}
Write-Info "parallelism: translator=$translatorThreads translated-compile-pool=$translatedJobs ninja=$globalJobs"

# ---------------------------------------------------------------------------
# (a) Extract the DATA partition (or use the extracted tree as given)
# ---------------------------------------------------------------------------
function Test-DiscValid([string]$Root) {
    return (Test-Path -LiteralPath (Join-Path $Root 'sys/main.dol') -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $Root 'files/rel/StaticR.rel') -PathType Leaf)
}

$stamp = $null
$wantStamp = $null
if ($discIsTree) {
    Write-Step 'Locating the extracted disc tree'
    $workDisc = $null
    if (Test-Path -LiteralPath (Join-Path $DiscImage 'sys/main.dol') -PathType Leaf) {
        $workDisc = $DiscImage
    } else {
        $foundTreeDol = Get-ChildItem -LiteralPath $DiscImage -Recurse -Depth 2 -File -Filter 'main.dol' -ErrorAction SilentlyContinue |
            Where-Object { $_.Directory.Name -eq 'sys' } | Select-Object -First 1
        if ($foundTreeDol) { $workDisc = $foundTreeDol.Directory.Parent.FullName }
    }
    if (-not $workDisc) { Stop-Build "no sys/main.dol found in $DiscImage (or one folder below it). An extracted tree must contain sys/main.dol and files/." }
    if (-not (Test-DiscValid $workDisc)) { Stop-Build "$workDisc has sys/main.dol but no files/rel/StaticR.rel; the tree looks incomplete (is it the DATA partition?)" }
    Write-Info "using $workDisc (no extraction)"
} else {
    $workDisc = Join-Path $buildDir 'disc'   # normalized DATA root: sys/ and files/
    $stamp = Join-Path $buildDir 'disc.stamp'
    $imageInfo = Get-Item -LiteralPath $DiscImage
    $imageMtime = ([DateTimeOffset]$imageInfo.LastWriteTimeUtc).ToUnixTimeSeconds()
    $wantStamp = "$DiscImage|$($imageInfo.Length)-$imageMtime"

    Write-Step 'Extracting the disc image'
    if ((Test-DiscValid $workDisc) -and (Test-Path -LiteralPath $stamp -PathType Leaf) -and ((Get-Content -LiteralPath $stamp -Raw) -ceq $wantStamp)) {
        Write-Info "reusing previous extraction in $workDisc (same image, size and mtime)"
    } else {
        $tmpExtract = Join-Path $buildDir 'disc.extract.tmp'
        Remove-Tree $tmpExtract
        Remove-Tree $workDisc
        if (Test-Path -LiteralPath $stamp) { Remove-Item -LiteralPath $stamp -Force }
        New-Item -ItemType Directory -Force -Path $tmpExtract | Out-Null
        $cmd = @($extractCmd | ForEach-Object { $_.Replace('{IMAGE}', $DiscImage).Replace('{OUT}', $tmpExtract) })
        Write-Info "running: $($cmd -join ' ')"
        $cmdArgs = @($cmd | Select-Object -Skip 1)
        & $cmd[0] @cmdArgs
        if ($LASTEXITCODE -ne 0) {
            Stop-Build 'disc extraction failed. Check the image is a valid RMCP01 disc and supported by your extractor (set MKW_DISC_EXTRACT_CMD to use a different command).'
        }

        # Different tools nest the DATA partition differently (out/, out/DATA/, ...): locate sys/main.dol.
        $foundDol = Get-ChildItem -LiteralPath $tmpExtract -Recurse -Depth 4 -File -Filter 'main.dol' -ErrorAction SilentlyContinue |
            Where-Object { $_.Directory.Name -eq 'sys' } | Select-Object -First 1
        if (-not $foundDol) { Stop-Build "extraction did not produce sys/main.dol under $tmpExtract (is this a Wii disc with a DATA partition?)" }
        $dataRoot = $foundDol.Directory.Parent.FullName
        if (-not (Test-Path -LiteralPath (Join-Path $dataRoot 'files/rel/StaticR.rel') -PathType Leaf)) {
            Stop-Build "extraction did not produce files/rel/StaticR.rel under $dataRoot"
        }
        Move-Item -LiteralPath $dataRoot -Destination $workDisc
        Remove-Tree $tmpExtract
    }
}

# ---------------------------------------------------------------------------
# (b) Verify the clean PAL hashes
# ---------------------------------------------------------------------------
Write-Step 'Verifying the disc is a clean PAL RMCP01 image'
$dolSha = Get-Sha256 (Join-Path $workDisc 'sys/main.dol')
$relSha = Get-Sha256 (Join-Path $workDisc 'files/rel/StaticR.rel')
if ($dolSha -ne $ExpectedDolSha256) {
    if ($stamp) { Remove-Item -LiteralPath $stamp -Force -ErrorAction SilentlyContinue }
    Stop-Build "main.dol sha256 mismatch: expected $ExpectedDolSha256, got $dolSha. Only an unmodified PAL (RMCP01) Mario Kart Wii disc is supported."
}
if ($relSha -ne $ExpectedRelSha256) {
    if ($stamp) { Remove-Item -LiteralPath $stamp -Force -ErrorAction SilentlyContinue }
    Stop-Build "StaticR.rel sha256 mismatch: expected $ExpectedRelSha256, got $relSha. Use a clean PAL (RMCP01) image."
}
if ($stamp) { [System.IO.File]::WriteAllText($stamp, $wantStamp) }
Write-Info 'main.dol and StaticR.rel match'

# ---------------------------------------------------------------------------
# (c) Translate (same commands, order and arguments as Launcher/local-build.sh, base profile)
# ---------------------------------------------------------------------------
$assets = Join-Path $workspace 'Assets'
$generated = Join-Path $workspace 'generated'
$functions = Join-Path $generated 'functions'
$baseMetadata = Join-Path $generated 'base_translation_output.json'
$baseManifestDir = Join-Path $workspace 'build/base'
$baseManifest = Join-Path $baseManifestDir 'mkwii_base_manifest.json'
$shards = Join-Path $generated 'build_shards'
$translationProvenance = Join-Path $generated 'translation-provenance.json'

Write-Step 'Staging main.dol and StaticR.rel into Assets/ (git-ignored)'
New-Item -ItemType Directory -Force -Path $assets | Out-Null
Copy-Item -LiteralPath (Join-Path $workDisc 'sys/main.dol') -Destination (Join-Path $assets 'main.dol') -Force
Copy-Item -LiteralPath (Join-Path $workDisc 'files/rel/StaticR.rel') -Destination (Join-Path $assets 'StaticR.rel') -Force

Write-Step 'Building the translator'
$translatorDll = Join-Path $workspace 'translator/src/Translator.Cli/bin/Release/net8.0/Translator.Cli.dll'
Invoke-Native 'dotnet build' 'dotnet' @('build', (Join-Path $workspace 'translator/src/Translator.Cli/Translator.Cli.csproj'), '-c', 'Release')
if (-not (Test-Path -LiteralPath $translatorDll -PathType Leaf)) { Stop-Build "Translator.Cli.dll was not produced: $translatorDll" }
function Invoke-Translator([string[]]$TranslatorArgs) {
    Invoke-Native "translator $($TranslatorArgs[0])" 'dotnet' (@($translatorDll) + $TranslatorArgs)
}

# First "- 0x..." entry under the top-level `translation:` key of the project file.
$entryPoint = $null
$inTranslation = $false
foreach ($line in Get-Content -LiteralPath $project) {
    if ($line -match '^translation:') { $inTranslation = $true; continue }
    if ($inTranslation -and $line -match '^\s*-\s*(0[xX][0-9a-fA-F]+)\s*$') { $entryPoint = $Matches[1]; break }
}
if (-not $entryPoint) { Stop-Build "could not find a translation entry point in $project" }

$translationFingerprint = Get-ConcatSha256 @((Join-Path $assets 'main.dol'), (Join-Path $assets 'StaticR.rel'), $project)

if ($buildRetro) {
    # Same as Launcher/local-build.sh: the translator finds the mod through the project file's
    # workspace-relative profile paths, and both the base and the mod leg block leaf inlining at
    # every address the profile patches, so the selected Code.pul must sit at the profile's
    # mod_root before either leg runs.
    $sourcePul = Join-Path $retroRoot 'Binaries/Code.pul'
    $stagedBinaries = Join-Path $workspace 'PulsarPacks/completed/RetroRewind/RetroRewind6/Binaries'
    New-Item -ItemType Directory -Force -Path $stagedBinaries | Out-Null
    $stagedPul = Join-Path $stagedBinaries 'Code.pul'
    if ([System.IO.Path]::GetFullPath($sourcePul) -ne [System.IO.Path]::GetFullPath($stagedPul)) {
        Write-Step "Staging Retro Rewind's Code.pul into PulsarPacks/ (ignored by version control)"
        Copy-Item -LiteralPath $sourcePul -Destination $stagedPul -Force
    }
}

$reuseBase = $false
if ($SkipTranslate) {
    if (-not ((Test-Path -LiteralPath $baseMetadata -PathType Leaf) -and (Test-Path -LiteralPath $baseManifest -PathType Leaf) -and (Test-Path -LiteralPath $functions -PathType Container))) {
        Stop-Build "-SkipTranslate needs an existing translation ($baseMetadata, $baseManifest, $functions); run once without it"
    }
    $reuseBase = $true
} elseif (Test-Path -LiteralPath $translationProvenance -PathType Leaf) {
    $m = [regex]::Match((Get-Content -LiteralPath $translationProvenance -Raw), '"TranslationFingerprint"\s*:\s*"([0-9a-f]*)"')
    $recorded = if ($m.Success) { $m.Groups[1].Value } else { '' }
    if ($recorded -eq $translationFingerprint -and (Test-Path -LiteralPath $baseMetadata -PathType Leaf) -and (Test-Path -LiteralPath $baseManifest -PathType Leaf)) {
        $reuseBase = $true
    }
}

if ($reuseBase -and $buildRetro) {
    # A base tree that never saw this Code.pul would silently bake vanilla code into the modded
    # product; check-base-mod-awareness fails closed (anything but exit 0 forces a retranslation).
    $retroCodePul = Join-Path $retroRoot 'Binaries/Code.pul'
    $pulSha = Get-Sha256 $retroCodePul
    $knownPul = Select-String -LiteralPath $baseMetadata -SimpleMatch -Quiet -Pattern "`"codePulSha256`":`"$pulSha`""
    if (-not $knownPul) {
        & dotnet $translatorDll check-base-mod-awareness --project $project --profile retro-rewind `
            --translation-output-metadata $baseMetadata --code-pul $retroCodePul
        if ($LASTEXITCODE -ne 0) {
            Write-Info 'the base translation is stale for this Code.pul; retranslating the base game'
            $reuseBase = $false
        }
    }
}

if ($reuseBase) {
    Write-Step 'Reusing the completed base translation'
} else {
    if (Test-Path -LiteralPath $translationProvenance) { Remove-Item -LiteralPath $translationProvenance -Force }
    New-Item -ItemType Directory -Force -Path $generated, $baseManifestDir | Out-Null

    Write-Step 'Translating the base game (about a minute, 8+ GB of RAM recommended)'
    Invoke-Translator @('translate-recursive', $entryPoint, '--project', $project,
        '--outdir', $functions, '--output-metadata', $baseMetadata,
        '--production-source-bundle', (Join-Path $generated 'base_translation_sources.bin'),
        '--no-function-files', '--prune-stale', '--threads', "$translatorThreads")

    Write-Step 'Creating the base translation manifest'
    Invoke-Translator @('emit-base-manifest', '--project', $project, '--out', $baseManifestDir,
        '--functions-dir', $functions, '--translation-output-metadata', $baseMetadata, '--region', 'P')

    [System.IO.File]::WriteAllText($translationProvenance, "{`"SchemaVersion`":1,`"TranslationFingerprint`":`"$translationFingerprint`"}")
}

$retroOut = Join-Path $workspace 'build/mods/retro_rewind_full_cpp'
if ($buildRetro) {
    # Mirrors Launcher/local-build.sh (--profile both). The browser build has networking compiled
    # out, so there is never a Retro-WFC payload: --skip-retro-wfc.
    Write-Step 'Translating the selected Retro Rewind Code.pul'
    Invoke-Translator @('translate-mod', '--project', $project, '--profile', 'retro-rewind',
        '--base-manifest', $baseManifest, '--base-translation-output-metadata', $baseMetadata,
        '--code-pul', (Join-Path $retroRoot 'Binaries/Code.pul'), '--mod-root', $retroRoot, '--mod-name', 'Retro Rewind',
        '--region', 'P', '--out', $retroOut, '--prefer-cached-inputs', '--emit-cpp',
        '--threads', "$translatorThreads", '--skip-retro-wfc')
}

Write-Step 'Generating game data initialization'
Invoke-Translator @('generate-data-init', '--project', $project)

Write-Step 'Emitting build shards'
$shardArgs = @('emit-build-shards', '--project', $project, '--base-metadata', $baseMetadata,
    '--base-functions-dir', $functions, '--native-source-dir', (Join-Path $workspace 'runtime/src'), '--out', $shards)
if ($buildRetro) {
    $shardArgs += @('--resolved-profile', (Join-Path $retroOut 'resolved_dispatch_profile.json'), '--retro-cpp-dir', (Join-Path $retroOut 'cpp'))
}
Invoke-Translator $shardArgs

# ---------------------------------------------------------------------------
# (d) Emscripten configure + build
# ---------------------------------------------------------------------------
$cmakeBuild = Join-Path $buildDir 'wasm'
$cmakeCache = Join-Path $cmakeBuild 'CMakeCache.txt'
if (Test-Path -LiteralPath $cmakeCache -PathType Leaf) {
    $cacheLines = Get-Content -LiteralPath $cmakeCache
    $cacheHome = ($cacheLines | Where-Object { $_ -like 'CMAKE_HOME_DIRECTORY:INTERNAL=*' } | Select-Object -First 1)
    $cacheTc = ($cacheLines | Where-Object { $_ -like 'CMAKE_TOOLCHAIN_FILE:*' } | Select-Object -First 1)
    $cacheHome = if ($cacheHome) { $cacheHome.Substring($cacheHome.IndexOf('=') + 1) } else { '' }
    $cacheTc = if ($cacheTc) { $cacheTc.Substring($cacheTc.IndexOf('=') + 1) } else { '' }
    $runtimeDir = Join-Path $workspace 'runtime'
    $sameHome = ([System.IO.Path]::GetFullPath($cacheHome) -eq [System.IO.Path]::GetFullPath($runtimeDir))
    if (-not $sameHome -or $cacheTc -notlike '*Emscripten*') {
        Write-Info "CMake cache in $cmakeBuild belongs to another source tree or toolchain; rebuilding from scratch"
        Remove-Tree $cmakeBuild
    }
}

# Prebuilt non-game web libraries (SDL3, aurora, abseil, zstd, ...): web/prebuilt/web-prebuilt.tar.xz plus
# web-prebuilt.tar.xz.sha256 ("<sha256>  web-prebuilt.tar.xz"). Verified, unpacked with Python (tar.exe
# cannot be relied on for .xz) into BuildDir/web-prebuilt and handed to CMake, which checks its own source
# fingerprint and silently falls back to compiling from source if the package does not match.
$prebuiltArgs = @()
$prebuiltPkg = Join-Path $workspace 'web/prebuilt/web-prebuilt.tar.xz'
if (Test-Path -LiteralPath $prebuiltPkg -PathType Leaf) {
    $prebuiltSumFile = $prebuiltPkg + '.sha256'
    $prebuiltWant = $null
    if (Test-Path -LiteralPath $prebuiltSumFile -PathType Leaf) {
        $sm = [regex]::Match((Get-Content -LiteralPath $prebuiltSumFile -Raw), '(?i)\b([0-9a-f]{64})\b')
        if ($sm.Success) { $prebuiltWant = $sm.Groups[1].Value.ToLowerInvariant() }
    }
    if (-not $prebuiltWant) {
        Write-Warn "web/prebuilt/web-prebuilt.tar.xz has no usable .sha256 next to it; ignoring the package and building everything from source"
    } elseif ((Get-Sha256 $prebuiltPkg) -ne $prebuiltWant) {
        Write-Warn 'web/prebuilt/web-prebuilt.tar.xz does not match its .sha256 (damaged download?); ignoring the package and building everything from source'
    } else {
        $prebuiltOut = Join-Path $buildDir 'web-prebuilt'
        $prebuiltStamp = Join-Path $buildDir 'web-prebuilt.stamp'
        $prebuiltCurrent = (Test-Path -LiteralPath $prebuiltStamp -PathType Leaf) -and ((Get-Content -LiteralPath $prebuiltStamp -Raw).Trim() -eq $prebuiltWant) -and
            (Test-Path -LiteralPath $prebuiltOut -PathType Container)
        if (-not $prebuiltCurrent) {
            Write-Info 'unpacking the prebuilt web libraries'
            Remove-Tree $prebuiltOut
            Remove-Item -LiteralPath $prebuiltStamp -Force -ErrorAction SilentlyContinue
            New-Item -ItemType Directory -Force -Path $prebuiltOut | Out-Null
            & $pythonExe @pythonLead -c 'import tarfile,sys; tarfile.open(sys.argv[1]).extractall(sys.argv[2])' $prebuiltPkg $prebuiltOut
            if ($LASTEXITCODE -ne 0) { Stop-Build 'unpacking web/prebuilt/web-prebuilt.tar.xz failed (delete it to build everything from source)' }
            [System.IO.File]::WriteAllText($prebuiltStamp, $prebuiltWant)
        }
        $prebuiltInner = Join-Path $prebuiltOut 'web-prebuilt'
        if (Test-Path -LiteralPath $prebuiltInner -PathType Container) {
            $prebuiltArgs = @("-DMKW_WEB_PREBUILT_DIR=$prebuiltInner")
            Write-Info "prebuilt web libraries: $prebuiltInner"
        } else {
            Write-Warn 'the prebuilt package has no top-level web-prebuilt/ folder; ignoring it'
        }
    }
}

Write-Step 'Configuring the WebAssembly build (emcmake)'
$configureArgs = @('cmake', '-S', (Join-Path $workspace 'runtime'), '-B', $cmakeBuild, '-G', 'Ninja',
    '-DCMAKE_BUILD_TYPE=Release', "-DMKW_PLATFORM_WEB_DIST=$outDir", "-DMKW_TRANSLATED_COMPILE_JOBS=$translatedJobs")
$configureArgs += $prebuiltArgs
if ($env:MKW_CMAKE_ARGS) {
    foreach ($extra in ($env:MKW_CMAKE_ARGS -split '\|')) {
        if ($extra) { $configureArgs += $extra }
    }
}
Invoke-Native 'emcmake cmake (configure)' 'emcmake' $configureArgs

$targets = @($BaseTarget)
if ($buildRetro) { $targets += $RetroTarget }

Write-Step "Compiling $($targets -join ' ') to WebAssembly (this is the long step)"
$buildArgs = @('--build', $cmakeBuild)
foreach ($t in $targets) { $buildArgs += @('--target', $t) }
$buildArgs += @('--parallel', "$globalJobs")
Invoke-Native 'cmake --build' 'cmake' $buildArgs

# ---------------------------------------------------------------------------
# (e) Assemble the static site
# ---------------------------------------------------------------------------
Write-Step "Assembling $outDir"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
Copy-Item -Path (Join-Path $siteSrc '*') -Destination $outDir -Recurse -Force
Remove-Item -LiteralPath (Join-Path $outDir 'products.json') -Force -ErrorAction SilentlyContinue

# Each target emits into the build dir or (via MKW_PLATFORM_WEB_DIST) straight into dist.
foreach ($target in $targets) {
    foreach ($name in @("$target.js", "$target.wasm")) {
        $src = $null
        foreach ($dir in @($cmakeBuild, (Join-Path $cmakeBuild 'web'), $outDir)) {
            $candidate = Join-Path $dir $name
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { $src = $candidate; break }
        }
        if (-not $src) {
            Stop-Build "$target did not produce $name (looked in $cmakeBuild, $(Join-Path $cmakeBuild 'web'), $outDir)."
        }
        $dest = Join-Path $outDir $name
        if ($src -ne $dest) { Copy-Item -LiteralPath $src -Destination $dest -Force }
        Write-Info ('{0} ({1:N1} MiB)' -f $name, ((Get-Item -LiteralPath $dest).Length / 1MB))
    }
    foreach ($suffix in $WebExtraSuffixes) {
        $candidate = Join-Path $cmakeBuild "$target$suffix"
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { Copy-Item -LiteralPath $candidate -Destination (Join-Path $outDir "$target$suffix") -Force; Write-Info "$target$suffix" }
    }
}

Write-Info "copying the disc tree (sys/ and files/) to $(Join-Path $outDir 'disc')"
$discOut = Join-Path $outDir 'disc'
Remove-Tree $discOut
New-Item -ItemType Directory -Force -Path $discOut | Out-Null
Copy-Item -LiteralPath (Join-Path $workDisc 'sys') -Destination (Join-Path $discOut 'sys') -Recurse -Force
Copy-Item -LiteralPath (Join-Path $workDisc 'files') -Destination (Join-Path $discOut 'files') -Recurse -Force

Write-Info "generating $DiscManifestName"
$manifestOut = Join-Path $outDir $DiscManifestName
& $pythonExe @pythonLead $manifestTool $discOut $manifestOut
if ($LASTEXITCODE -ne 0) { Stop-Build 'make_disc_manifest.py failed' }
if (-not (Test-Path -LiteralPath $manifestOut -PathType Leaf) -or (Get-Item -LiteralPath $manifestOut).Length -eq 0) {
    Stop-Build "$DiscManifestName was not written"
}

# products.json tells the page which products this site holds (more than one shows a choice screen).
$products = @([ordered]@{ id = 'WiiCompiled'; title = 'Mario Kart Wii'; glue = 'WiiCompiled.js' })
$modsOut = Join-Path $outDir $ModsDirName
Remove-Tree $modsOut
if ($buildRetro) {
    $modDest = Join-Path $modsOut $RetroModDirName
    Write-Info "copying the Retro Rewind mod tree to $modDest"
    New-Item -ItemType Directory -Force -Path $modsOut | Out-Null
    Copy-Item -LiteralPath $retroRoot -Destination $modDest -Recurse -Force
    $modManifest = Join-Path $modsOut "$RetroModDirName-manifest.json"
    Write-Info "generating $ModsDirName/$RetroModDirName-manifest.json"
    & $pythonExe @pythonLead $manifestTool --tree $modDest $modManifest
    if ($LASTEXITCODE -ne 0) { Stop-Build 'make_disc_manifest.py failed for the Retro Rewind mod tree' }
    $products += [ordered]@{ id = 'RetroRewind'; title = 'Retro Rewind'; glue = 'RetroRewind.js'; modRoot = "$ModsDirName/$RetroModDirName" }
} else {
    # A previous build of this dist dir may have had Retro Rewind; do not leave it half there.
    foreach ($suffix in @('.js', '.wasm', '.data', '.wasm.map')) {
        Remove-Item -LiteralPath (Join-Path $outDir "$RetroTarget$suffix") -Force -ErrorAction SilentlyContinue
    }
    # Content-hashed copies (and their .gz/.br) of an earlier build.
    Get-ChildItem -LiteralPath $outDir -File -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match ('^' + [regex]::Escape($RetroTarget) + '\.[0-9a-f]{8}\.wasm(\.gz|\.br)?$') } |
        Remove-Item -Force -ErrorAction SilentlyContinue
}
$productsJson = ConvertTo-Json -InputObject @($products) -Compress -Depth 4
[System.IO.File]::WriteAllText((Join-Path $outDir 'products.json'), $productsJson + "`n")

# Content-hash the wasm files (cache forever), write .gz/.br next to them and record the names and
# sizes in products.json. See docs/web-hosting.md ("Caching and compression").
Write-Step 'Hashing and precompressing the wasm files'
& $pythonExe @pythonLead $precompressTool $outDir
if ($LASTEXITCODE -ne 0) { Stop-Build 'precompress_dist.py failed' }
Write-Info ('products.json: ' + ([System.IO.File]::ReadAllText((Join-Path $outDir 'products.json'))).Trim())

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
function Get-DirSize([string]$Path) {
    $sum = (Get-ChildItem -LiteralPath $Path -Recurse -File -Force | Measure-Object -Property Length -Sum).Sum
    return ('{0:N1} GiB' -f (([double]$sum) / 1GB))
}
$serveScript = Join-Path $workspace 'web/serve.py'
Write-Host @"

==> Done
    Site:        $outDir
    Total size:  $(Get-DirSize $outDir)  (disc tree $(Get-DirSize $discOut), streamed lazily over HTTP Range)
    Serve:       $pythonExe $($pythonLead -join ' ') "$serveScript" --dir "$outDir"      # http://127.0.0.1:8080/
    Host:        any static server with HTTP Range support (nginx, Caddy, ...), serving .wasm as application/wasm.
                 Other devices need HTTPS for WebGPU: add --https --lan to serve.py (docs/web-hosting.md).
    Players need Chrome/Edge 137+ (WebGPU + JSPI).
"@
