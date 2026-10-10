#requires -Version 5.1
<#
.SYNOPSIS
    WiiCompiled for the Web - one-click Windows build (called by build.bat at the repository root).

.DESCRIPTION
    For a stock Windows 10/11 PC with nothing installed (cmd + Windows PowerShell 5.1 only):

      1. finds your game file in web\game\
      2. downloads a pinned, hash-verified portable toolchain into tools\ (first run only):
         Python, CMake, Ninja, nodtool, the .NET 8 SDK
      3. installs the pinned Emscripten SDK into tools\emsdk (first run only)
      4-6. extracts, translates and compiles the game with web\host.ps1 / web\build.ps1 and
         assembles web\dist (skipped when nothing changed since the last run)
      7. (only with --serve) starts web\serve.py on http://localhost:8080/ and opens the browser.
         Normally it stops after building: double-click start-server.bat to play; closing that
         window stops the server.

    Everything is logged to web\build\build.log. No admin rights; nothing outside this folder is
    changed (the user-level environment is left alone).

    Options (all also accepted with a single dash):
      --rebuild        build again even if nothing changed
      --jobs N         limit build parallelism (use on PCs with little RAM)
      --port N         port to serve on (default 8080)
      --lan            let other devices on the network connect (see the note printed)
      --serve          start the server after building (default: build only; use start-server.bat)
      --no-serve       build only (the default; kept for compatibility)
      --no-browser     do not open the browser
      --tools-only     install the toolchain and stop
      --game DIR       use DIR instead of web\game
      --help

    Test hooks (used by the automated tests, not needed by users):
      --tools-dir DIR  --lock FILE  --no-open-folder  --dist DIR  --python EXE  --host-script FILE
#>
param(
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$CliArgs
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # no progress bars (slow in 5.1, noise when output is captured)

$here = $PSScriptRoot
. (Join-Path $here 'mkw-lib.ps1')

$root = Split-Path -Parent (Split-Path -Parent $here)
$onWindows = $script:OnWindows
$TotalSteps = 7
$script:Handled = $false
$script:StepNow = 0
$script:Started = Get-Date

# ---------------------------------------------------------------------------
# Options
# ---------------------------------------------------------------------------
$opt = @{
    Rebuild = $false; Jobs = 0; Port = 8080; Lan = $false; NoServe = $true; NoBrowser = $false
    ToolsOnly = $false; Game = ''; ToolsDir = ''; Lock = ''; NoOpenFolder = $false; Help = $false
    Dist = ''; Python = ''; HostScript = ''
}
$argList = @($CliArgs | Where-Object { $null -ne $_ })
$ai = 0
while ($ai -lt $argList.Count) {
    $name = ([string]$argList[$ai]).TrimStart('-').ToLowerInvariant()
    switch ($name) {
        'rebuild' { $opt.Rebuild = $true }
        'jobs' { $ai++; $opt.Jobs = [int]$argList[$ai] }
        'port' { $ai++; $opt.Port = [int]$argList[$ai] }
        'lan' { $opt.Lan = $true }
        'serve' { $opt.NoServe = $false }
        'no-serve' { $opt.NoServe = $true }
        'noserve' { $opt.NoServe = $true }
        'no-browser' { $opt.NoBrowser = $true }
        'nobrowser' { $opt.NoBrowser = $true }
        'tools-only' { $opt.ToolsOnly = $true }
        'game' { $ai++; $opt.Game = [string]$argList[$ai] }
        'tools-dir' { $ai++; $opt.ToolsDir = [string]$argList[$ai] }
        'lock' { $ai++; $opt.Lock = [string]$argList[$ai] }
        'no-open-folder' { $opt.NoOpenFolder = $true }
        'dist' { $ai++; $opt.Dist = [string]$argList[$ai] }
        'python' { $ai++; $opt.Python = [string]$argList[$ai] }
        'host-script' { $ai++; $opt.HostScript = [string]$argList[$ai] }
        { $_ -in @('h', 'help', '?') } { $opt.Help = $true }
        default { Write-Host "Unknown option: $($argList[$ai]). Use --help to see the options."; exit 2 }
    }
    $ai++
}
if ($opt.Help) {
    Get-Help $MyInvocation.MyCommand.Path -Detailed | Out-String | Write-Host
    exit 0
}

$gameDir = if ($opt.Game) { $opt.Game } else { Join-Path (Join-Path $root 'web') 'game' }
$toolsDir = if ($opt.ToolsDir) { $opt.ToolsDir } else { Join-Path $root 'tools' }
$lockPath = if ($opt.Lock) { $opt.Lock } else { Join-Path $here 'toolchain.lock.json' }
$buildDirRoot = Join-Path (Join-Path $root 'web') 'build'
$logPath = Join-Path $buildDirRoot 'build.log'
$distDir = if ($opt.Dist) { $opt.Dist } else { Join-Path (Join-Path $root 'web') 'dist' }
$hostScript = if ($opt.HostScript) { $opt.HostScript } else { Join-Path (Join-Path $root 'web') 'host.ps1' }
$downloadDir = Join-Path $toolsDir 'downloads'
$keepDownloads = [bool]$env:MKW_KEEP_DOWNLOADS
$certPath = Join-Path (Join-Path (Join-Path (Join-Path $root 'runtime') 'assets') 'certs') 'cacert.pem'

# ---------------------------------------------------------------------------
# Presentation
# ---------------------------------------------------------------------------
function Start-Step {
    param([int]$Number, [string]$Text)
    $script:StepNow = $Number
    Write-Say ''
    Write-Say ("Step {0}/{1}: {2}" -f $Number, $TotalSteps, $Text) 'Cyan'
}

# Print what went wrong, what to do, where the log is; then stop.
function Stop-Build {
    param([string]$Problem, [string]$Fix = '', [switch]$ShowTail)
    $script:Handled = $true
    Write-Say ''
    Write-Say '=====================================================================' 'Red'
    if ($script:StepNow -gt 0) { Write-Say ("  STOPPED during step {0} of {1}" -f $script:StepNow, $TotalSteps) 'Red' } else { Write-Say '  STOPPED before the first step' 'Red' }
    Write-Say '=====================================================================' 'Red'
    Write-Say $Problem
    if ($ShowTail -and $script:Tail.Count -gt 0) {
        Write-Say ''
        Write-Say 'Last lines of output:'
        foreach ($l in @($script:Tail.ToArray() | Select-Object -Last 15)) { Write-Say ('    ' + $l) }
    }
    if ($Fix) {
        Write-Say ''
        Write-Say ('What to try: ' + $Fix) 'Yellow'
    }
    if ($script:LogPath) {
        Write-Say ''
        Write-Say ('Full log: ' + $script:LogPath)
    }
    throw 'build stopped'
}

# A problem the user fixes by changing something (game files), not a failure.
function Stop-WithGuidance {
    param([string]$Text)
    $script:Handled = $true
    Write-Say ''
    Write-Say '---------------------------------------------------------------------' 'Yellow'
    Write-Say $Text 'Yellow'
    Write-Say '---------------------------------------------------------------------' 'Yellow'
    throw 'needs user action'
}

# ---------------------------------------------------------------------------
# Toolchain environment (process-local only; nothing is written to the user's settings)
# ---------------------------------------------------------------------------
function Add-PathFront {
    param([string]$Dir)
    if ($Dir -and (Test-Path -LiteralPath $Dir -PathType Container)) {
        $env:PATH = $Dir + [System.IO.Path]::PathSeparator + $env:PATH
    }
}

function Set-ToolchainEnvironment {
    # Python: build.ps1 / host.ps1 honour $env:PYTHON, so the Microsoft Store 'python' stub is never used.
    $pythonExe = Join-Path (Join-Path $toolsDir 'python') 'python.exe'
    if (Test-Path -LiteralPath $pythonExe) { $env:PYTHON = $pythonExe }
    $nodtoolExe = Join-Path (Join-Path $toolsDir 'nodtool') 'nodtool.exe'
    if (Test-Path -LiteralPath $nodtoolExe) {
        $env:NODTOOL = $nodtoolExe
        # nodtool is a Rust program that needs the Visual C++ runtime; use the copy that ships
        # with the portable Python if the PC has none.
        $py = Join-Path $toolsDir 'python'
        foreach ($dll in @('vcruntime140.dll', 'vcruntime140_1.dll')) {
            $from = Join-Path $py $dll
            $to = Join-Path (Join-Path $toolsDir 'nodtool') $dll
            if ((Test-Path -LiteralPath $from) -and -not (Test-Path -LiteralPath $to)) { Copy-Item -LiteralPath $from -Destination $to -Force }
        }
    }

    $dotnetDir = Join-Path $toolsDir 'dotnet'
    if (Test-Path -LiteralPath $dotnetDir -PathType Container) {
        $env:DOTNET_ROOT = $dotnetDir
        $env:DOTNET_MULTILEVEL_LOOKUP = '0'
        $env:DOTNET_CLI_HOME = Join-Path $toolsDir 'dotnet-home'
        $env:NUGET_PACKAGES = Join-Path $toolsDir 'nuget-packages'
        $env:DOTNET_NOLOGO = '1'
        $env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
        $env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'
        $env:MSBUILDDISABLENODEREUSE = '1'
    }

    Add-PathFront (Join-Path $toolsDir 'dotnet')
    Add-PathFront (Join-Path $toolsDir 'ninja')
    Add-PathFront (Join-Path (Join-Path $toolsDir 'cmake') 'bin')
    Add-PathFront (Join-Path $toolsDir 'python')

    # Python must not pick up the user's PYTHONHOME/PYTHONPATH, and should print UTF-8.
    Remove-Item Env:PYTHONHOME -ErrorAction SilentlyContinue
    Remove-Item Env:PYTHONPATH -ErrorAction SilentlyContinue
    $env:PYTHONUTF8 = '1'
    $env:PYTHONUNBUFFERED = '1'
    $env:EMSDK_QUIET = '1'

    # TLS: CMake's FetchContent failed on some PCs with "certificate signer not trusted" until a CA
    # bundle was given through SSL_CERT_FILE (CMAKE_TLS_CAINFO alone was not enough).
    if (Test-Path -LiteralPath $certPath -PathType Leaf) {
        $env:SSL_CERT_FILE = $certPath
        $env:CURL_CA_BUNDLE = $certPath
        # CMake pastes CMAKE_TLS_CAINFO verbatim into generated FetchContent scripts, where a
        # backslash path is a syntax error; give it forward slashes.
        $certPathCMake = $certPath.Replace('\', '/')
        $env:CMAKE_TLS_CAINFO = $certPathCMake
        $env:REQUESTS_CA_BUNDLE = $certPath
        $existing = ''
        if ($env:MKW_CMAKE_ARGS) { $existing = $env:MKW_CMAKE_ARGS + '|' }
        $env:MKW_CMAKE_ARGS = $existing + '-DCMAKE_TLS_CAINFO=' + $certPathCMake
    } else {
        Write-Say "    warning: CA bundle not found at $certPath (downloads inside CMake may fail on some PCs)"
    }
}

# ---------------------------------------------------------------------------
# Emscripten SDK
# ---------------------------------------------------------------------------
# emsdk.py is run by the portable Python directly (emsdk.bat would look for 'python' on PATH).
# `emsdk install` itself downloads three archives without checking them, so they are fetched
# first (resumable, hash-checked) into emsdk\downloads, where emsdk finds and reuses them (EMSDK_KEEP_DOWNLOADS).
function Install-Emsdk {
    param($Tool)
    $title = Get-Prop $Tool 'title' 'Emscripten SDK'
    $version = $Tool.version
    $dir = Join-Path $toolsDir $Tool.dest
    $py = Join-Path (Join-Path $toolsDir 'python') 'python.exe'
    $emsdkPy = Join-Path $dir 'emsdk.py'
    $ready = Join-Path $dir ('.mkw-ready-' + $version)
    $fingerprint = Get-ToolFingerprint $Tool
    $envFile = Join-Path $dir 'emsdk_set_env.ps1'

    $alreadyReady = $false
    if ((Test-Path -LiteralPath $ready -PathType Leaf) -and ((Get-Content -LiteralPath $ready -Raw).Trim() -eq $fingerprint)) { $alreadyReady = $true }

    if (-not $alreadyReady) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        foreach ($f in @($Tool.files)) {
            [void](Get-VerifiedDownload -Url $f.url -Final (Join-Path $dir $f.name) -Entry $f -Label ('emsdk ' + $f.name))
        }
        $zips = Join-Path $dir 'downloads'
        $upstreamDone = Test-Path -LiteralPath (Join-Path (Join-Path $dir 'upstream') '.emsdk_version')
        if (-not $upstreamDone) {
            Write-Say ('    ' + $title + ' is a large download; if it is interrupted, run build.bat again and it resumes.')
            foreach ($pkg in @($Tool.packages)) {
                [void](Get-VerifiedDownload -Url $pkg.url -Final (Join-Path $zips $pkg.name) -Entry $pkg -Label $pkg.title)
            }
        }
        $env:EMSDK_KEEP_DOWNLOADS = '1'
        Write-Say '    installing the SDK (unpacking about 2 GB; this takes a few minutes) ...'
        $code = Invoke-Logged -Exe $py -Arguments @($emsdkPy, 'install', $version) -WorkDir $dir -Echo
        if ($code -ne 0) { Stop-Build "The Emscripten SDK install failed (exit code $code)." 'Check your internet connection and free disk space (about 5 GB), then run build.bat again.' -ShowTail }
        $env:EMSDK_POWERSHELL = '1'
        $code = Invoke-Logged -Exe $py -Arguments @($emsdkPy, 'activate', $version) -WorkDir $dir -Echo
        if ($code -ne 0) { Stop-Build "Activating the Emscripten SDK failed (exit code $code)." 'Run build.bat again.' -ShowTail }
        Remove-Item Env:EMSDK_KEEP_DOWNLOADS -ErrorAction SilentlyContinue
        if (-not $keepDownloads) { Remove-Tree $zips }
        [System.IO.File]::WriteAllText($ready, $fingerprint + "`n")
    } else {
        Write-Say ("    {0}: already installed" -f $title)
    }

    # Environment for this process only (what emsdk_env.ps1 would set).
    Remove-Item -LiteralPath $envFile -Force -ErrorAction SilentlyContinue
    $env:EMSDK_POWERSHELL = '1'
    $code = Invoke-Logged -Exe $py -Arguments @($emsdkPy, 'construct_env') -WorkDir $dir
    Remove-Item Env:EMSDK_POWERSHELL -ErrorAction SilentlyContinue
    if ($code -ne 0 -or -not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
        Stop-Build "Could not read the Emscripten environment (emsdk construct_env exit code $code)." 'Delete the folder tools\emsdk and run build.bat again.' -ShowTail
    }
    foreach ($line in (Get-Content -LiteralPath $envFile)) {
        $m = [regex]::Match($line, '^\$env:([A-Za-z_][A-Za-z0-9_]*)="(.*)"\s*$')
        if ($m.Success) {
            [System.Environment]::SetEnvironmentVariable($m.Groups[1].Value, $m.Groups[2].Value, 'Process')
            continue
        }
        $m = [regex]::Match($line, '^Remove-Item env:([A-Za-z_][A-Za-z0-9_]*)')
        if ($m.Success) { [System.Environment]::SetEnvironmentVariable($m.Groups[1].Value, $null, 'Process') }
    }
    Remove-Item -LiteralPath $envFile -Force -ErrorAction SilentlyContinue
    $env:EMSDK_QUIET = '1'
}

# Fallback for the .NET SDK: Microsoft's dotnet-install.ps1 (hash-pinned in the manifest).
function Install-DotnetWithScript {
    param($Lock, $Tool)
    $fb = Get-Prop (Get-Prop $Lock 'fallbacks' $null) 'dotnetInstallScript' $null
    if ($null -eq $fb) { throw 'no dotnet-install.ps1 fallback in the manifest' }
    $script = Get-VerifiedDownload -Url $fb.url -Final (Join-Path $downloadDir $fb.file) -Entry $fb -Label 'dotnet-install.ps1'
    $dest = Join-Path $toolsDir $Tool.dest
    Remove-Tree $dest
    $psExe = (Get-Process -Id $PID).Path
    $code = Invoke-Logged -Exe $psExe -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script, '-Version', $fb.sdkVersion, '-InstallDir', $dest, '-NoPath', '-Architecture', 'x64') -Echo
    if ($code -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $dest 'dotnet.exe'))) { throw "dotnet-install.ps1 failed (exit code $code)" }
    Set-ToolInstalled $Tool $toolsDir
}

# ===========================================================================
# Main
# ===========================================================================
function Invoke-Main {
    # Launched from Git Bash/MSYS (e.g. "cmd //c build.bat"), these leak into every child: MSYSTEM
    # makes emsdk write a POSIX PATH (/c/...:/c/...) that cmd cannot use, so emcc is "not
    # recognized"; NoDefaultCurrentDirectoryInExePath stops cmd running tools by bare name from
    # their own folder. A double-clicked build.bat has neither; make every launch look like that.
    foreach ($leak in 'MSYSTEM', 'NoDefaultCurrentDirectoryInExePath') {
        [System.Environment]::SetEnvironmentVariable($leak, $null, 'Process')
    }
    New-Item -ItemType Directory -Force -Path $buildDirRoot | Out-Null
    Open-Log $logPath
    Write-Log ('=' * 70)
    Write-Log ('build.bat run ' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + '  PowerShell ' + $PSVersionTable.PSVersion + '  args: ' + ($argList -join ' '))
    Write-Log ('repository: ' + $root)
    Initialize-Network

    Write-Say ''
    Write-Say 'WiiCompiled for the Web - build and start' 'Green'
    Write-Say '------------------------------------------'
    Write-Say 'This builds the game for your browser from YOUR OWN game file and then'
    Write-Say 'serves it on this PC. The first run takes a while (about 30 minutes plus'
    Write-Say 'downloads); later runs start in seconds. Keep this window open.'
    Write-Say ('Log file: ' + $logPath)

    # ---- Checks that save time later -------------------------------------
    if ($onWindows) {
        if (-not [Environment]::Is64BitOperatingSystem) {
            Stop-Build 'This needs a 64-bit version of Windows 10 or 11.' 'It cannot run on 32-bit Windows.'
        }
        if ([Environment]::OSVersion.Version.Major -lt 10) {
            Stop-Build 'This needs Windows 10 or 11.' 'Update Windows, or use the Docker route described in the README.'
        }
        if ($root.Length -gt 80 -and -not $env:MKW_ALLOW_LONG_PATH) {
            Stop-Build ("This folder's path is too long for the build tools ({0} characters):`n    {1}" -f $root.Length, $root) 'Move the whole WiiCompiled folder to a short path such as C:\WiiCompiled (cut and paste it in Explorer), then double-click build.bat there.'
        }
        $free = Get-FreeSpaceGB $root
        if ($free -ge 0 -and $free -lt 20) {
            Stop-Build ("Only {0} GB of disk space is free on this drive; the first build needs about 20 GB." -f $free) 'Free some space (or move this folder to a drive with more), then run build.bat again.'
        }
        $ram = Get-TotalMemoryGB
        if ($ram -ge 0 -and $ram -lt 8) {
            Write-Say ("    note: this PC has {0} GB of RAM; 8 GB or more is recommended. If the build fails, close other programs and run: build.bat --jobs 2" -f $ram) 'Yellow'
        }
    }
    foreach ($needed in @('projects/mkwii/recomp.yml', 'web/serve.py', 'web/build.ps1', 'web/host.ps1', 'runtime/CMakeLists.txt')) {
        if (-not (Test-Path -LiteralPath (Join-Path $root $needed.Replace('/', [IO.Path]::DirectorySeparatorChar)))) {
            Stop-Build ("Part of the WiiCompiled download is missing: $needed") 'If you downloaded a ZIP, right-click it and choose "Extract All..." first, then run build.bat from the extracted folder (not from inside the ZIP).'
        }
    }

    $lock = Read-ToolchainLock $lockPath

    # ---- Step 1: game files ---------------------------------------------
    Start-Step 1 'checking your game files'
    $game = Find-GameFiles $gameDir
    if (-not $game.Ok) {
        if ($onWindows -and -not $opt.NoOpenFolder -and $game.Images.Count -eq 0 -and $game.Trees.Count -eq 0) {
            try { Start-Process -FilePath 'explorer.exe' -ArgumentList ('"' + (Resolve-Path -LiteralPath $gameDir).Path + '"') } catch { }
        }
        Stop-WithGuidance $game.Message
    }
    if ($game.Kind -eq 'image') {
        $imgSize = (Get-Item -LiteralPath $game.Input).Length
        Write-Say ("    game:          {0}  ({1}; disc image)" -f $game.Input, (Format-Size $imgSize))
    } else {
        Write-Say ("    game:          {0}  (extracted folder)" -f $game.Input)
    }
    if ($game.RetroRoot) { Write-Say ("    Retro Rewind:  {0}  (will be built too)" -f $game.RetroRoot) } else { Write-Say '    Retro Rewind:  not found (optional; put the RetroRewind6 folder in web\game to add it)' }

    # ---- Step 2: portable tools ------------------------------------------
    $toolList = @($lock.tools | Where-Object { (Get-Prop $_ 'kind' '') -ne 'emsdk' })
    $need = @($toolList | Where-Object { -not (Test-ToolInstalled $_ $toolsDir) })
    if ($need.Count -gt 0) {
        Start-Step 2 ('getting the build tools (first time only; about 400 MB: ' + (($need | ForEach-Object { $_.id }) -join ', ') + ')')
    } else {
        Start-Step 2 'build tools (already installed)'
    }
    New-Item -ItemType Directory -Force -Path $toolsDir, $downloadDir | Out-Null
    foreach ($tool in $toolList) {
        try {
            Install-LockedTool -Tool $tool -ToolsDir $toolsDir -DownloadDir $downloadDir -KeepDownloads:$keepDownloads
        } catch {
            $why = $_.Exception.Message
            if ($tool.id -eq 'dotnet') {
                Write-Say ("    direct download failed ({0}); trying Microsoft's dotnet-install.ps1" -f $why)
                try { Install-DotnetWithScript -Lock $lock -Tool $tool } catch { Stop-Build ("Could not install {0}: {1}" -f $tool.title, $_.Exception.Message) (Get-LikelyFix $why) }
            } else {
                Stop-Build ("Could not install {0}: {1}" -f (Get-Prop $tool 'title' $tool.id), $why) (Get-LikelyFix $why)
            }
        }
    }
    if (-not $keepDownloads) { Remove-Item -LiteralPath (Join-Path $downloadDir 'dotnet-install.ps1') -Force -ErrorAction SilentlyContinue }
    Set-ToolchainEnvironment

    # ---- Step 3: Emscripten ----------------------------------------------
    $emsdkTool = @($lock.tools | Where-Object { (Get-Prop $_ 'kind' '') -eq 'emsdk' } | Select-Object -First 1)
    if ($emsdkTool.Count -gt 0) {
        $et = $emsdkTool[0]
        $emsdkReady = Test-Path -LiteralPath (Join-Path (Join-Path $toolsDir $et.dest) ('.mkw-ready-' + $et.version))
        if ($emsdkReady) {
            Start-Step 3 ('WebAssembly compiler (Emscripten ' + $et.version + ', already installed)')
        } else {
            Start-Step 3 ('installing the WebAssembly compiler, Emscripten ' + $et.version + ' (first time only; about 770 MB to download, 10 minutes)')
        }
        Install-Emsdk $et
        if ($onWindows) {
            $code = Invoke-Logged -Exe 'cmd.exe' -Arguments @('/d', '/c', 'emcc', '--version')
            $first = ''
            if ($script:Tail.Count -gt 0) { $first = $script:Tail.ToArray()[0] }
            if ($code -ne 0) { Stop-Build "The Emscripten compiler (emcc) does not run (exit code $code)." 'Delete the folder tools\emsdk and run build.bat again.' -ShowTail }
            Write-Say ('    ' + $first)
        }
    } else {
        Start-Step 3 'WebAssembly compiler (not in this manifest)'
    }

    # Prebuilt web libraries: web\build.ps1 itself unpacks web\prebuilt\web-prebuilt.tar.xz (after
    # checking its .sha256) with the portable Python and passes -DMKW_WEB_PREBUILT_DIR to CMake, so
    # nothing is needed here; the file is part of the source fingerprint below.

    if ($opt.ToolsOnly) {
        Write-Say ''
        Write-Say 'Toolchain is ready (--tools-only).' 'Green'
        return 0
    }

    # ---- Steps 4-6: translate, compile, assemble --------------------------
    # web\host.ps1 decides whether anything must be rebuilt (game files + a hash of these sources).
    Write-Say ''
    Write-Say '    checking whether the game needs to be (re)built ...'
    $env:MKW_REPO_COMMIT = Get-SourceFingerprint $root
    $psExe = (Get-Process -Id $PID).Path
    # host.ps1 looks for the disc image and Retro Rewind inside a game FOLDER, so give it the folder.
    $hostArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $hostScript,
        '-Game', (Resolve-Path -LiteralPath $gameDir).Path, '-BuildOnly', '-Out', $distDir)
    if ($opt.Rebuild) { $hostArgs += '-Rebuild' }
    if ($opt.Jobs -gt 0) { $hostArgs += @('-Jobs', [string]$opt.Jobs) }

    $script:LastNinja = -1
    $script:UpToDate = $false
    $script:InCompile = $false
    $onBuildLine = {
        param([string]$line)
        if ($line -match '^==> \[\d+\] (.+)$') {
            $text = $Matches[1]
            if ($text -match '^(Configuring|Compiling)') {
                if ($script:StepNow -lt 5) { Start-Step 5 'compiling the game - about 20 minutes, the first time only (later runs skip this)' }
                $script:InCompile = ($text -match '^Compiling')
            } elseif ($text -match '^Assembling') {
                if ($script:StepNow -lt 6) { Start-Step 6 'assembling the web page' }
                $script:InCompile = $false
            } elseif ($script:StepNow -lt 4) {
                Start-Step 4 'preparing the game: reading the disc, translating it (a few minutes; a compressed .rvz takes longest)'
            }
            Write-Say ('    - ' + $text)
            return
        }
        if ($line -match 'is up to date for these game files') {
            $script:UpToDate = $true
            Write-Say ''
            Write-Say 'Steps 4-6/7: nothing to rebuild - your game is already built for this version.' 'Cyan'
            Write-Say '    (use build.bat --rebuild to build again)'
            return
        }
        if ($line -match '^\[(\d+)/(\d+)\] ') {
            $done = [int]$Matches[1]; $total = [int]$Matches[2]
            if ($total -gt 0) {
                $pct = [int][math]::Floor(100.0 * $done / $total)
                if ($pct -ge ($script:LastNinja + 5) -or $done -eq $total) {
                    $script:LastNinja = $pct
                    Write-Say ('    compiling: {0} of {1} files ({2}%)' -f $done, $total, $pct)
                }
            }
            return
        }
        if ($line -match 'error|FAILED|fatal|Exception') { Write-Say ('    ' + $line); return }
        if (-not $script:InCompile -and $line -match '^    \S') { Write-Say $line }
    }
    $code = Invoke-Logged -Exe $psExe -Arguments $hostArgs -WorkDir $root -OnLine $onBuildLine
    if ($code -ne 0) {
        $tailText = ($script:Tail.ToArray() -join "`n")
        Stop-Build 'The build did not finish.' (Get-LikelyFix $tailText) -ShowTail
    }
    if (-not (Test-Path -LiteralPath (Join-Path $distDir 'index.html') -PathType Leaf)) {
        Stop-Build ('The build reported success but ' + $distDir + ' has no index.html.') 'Run build.bat --rebuild.'
    }
    if (-not $script:UpToDate) {
        Write-Say ''
        Write-Say ('Build finished in ' + (Format-Duration ((Get-Date) - $script:Started)) + '.') 'Green'
    }

    if ($opt.NoServe) {
        Write-Say ''
        Write-Say 'Done. To play, double-click start-server.bat in this folder (closing its window' 'Green'
        Write-Say 'stops the server), then open http://localhost:8080/ in Chrome or Edge.' 'Green'
        return 0
    }

    # ---- Step 7: serve ----------------------------------------------------
    Start-Step 7 'starting the web server'
    $py = if ($opt.Python) { $opt.Python } else { Join-Path (Join-Path $toolsDir 'python') 'python.exe' }
    $serve = Join-Path (Join-Path $root 'web') 'serve.py'
    $port = $opt.Port
    $bindAddr = '127.0.0.1'
    $serveExtra = @()
    if ($opt.Lan) {
        # TODO(serve-lan): a parallel change adds `serve.py --https --lan`. Use it when it exists;
        # until then fall back to a plain 0.0.0.0 bind (other devices still cannot use WebGPU over
        # plain http, so say so).
        $helpText = New-Object System.Text.StringBuilder
        [void](Invoke-Logged -Exe $py -Arguments @($serve, '--help') -OnLine { param([string]$l) [void]$helpText.AppendLine($l) })
        if ($helpText.ToString() -match '--lan') {
            $serveExtra = @('--https', '--lan')
            $bindAddr = '0.0.0.0'
        } else {
            $serveExtra = @('--bind', '0.0.0.0')
            $bindAddr = '0.0.0.0'
            Write-Say '    note: this version of serve.py has no HTTPS mode yet. Other devices can open the page, but browsers only allow WebGPU on http://localhost or https://, so they will see "WebGPU missing".' 'Yellow'
        }
    }
    if (-not (Test-PortFree $port $bindAddr)) {
        $picked = 0
        foreach ($cand in ($port + 1)..($port + 20)) { if (Test-PortFree $cand $bindAddr) { $picked = $cand; break } }
        if ($picked -eq 0) { Stop-Build "Port $port is already in use (and the next 20 ports too)." 'Close the other program or the other build.bat window that is still running, or pick a port with: build.bat --port 9000' }
        Write-Say ("    port {0} is busy (is another build.bat window still open?); using {1} instead" -f $port, $picked) 'Yellow'
        $port = $picked
    }
    $url = "http://localhost:$port/"
    $serveArgs = @($serve, '--dir', $distDir, '--port', [string]$port)
    if ($serveExtra.Count -gt 0) { $serveArgs += $serveExtra } else { $serveArgs += @('--bind', $bindAddr) }

    Write-Say ''
    Write-Say '=====================================================================' 'Green'
    Write-Say '  Ready. Open this address in Chrome or Edge (version 137 or newer):' 'Green'
    Write-Say ''
    Write-Say ('      ' + $url) 'White'
    Write-Say ''
    if ($opt.Lan) {
        try {
            foreach ($a in [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName())) {
                if ($a.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork) { Write-Say ('      other devices on your network: http://' + $a.ToString() + ':' + $port + '/') }
            }
        } catch { }
    }
    Write-Say '  Keep this window open while you play. Close it (or press Ctrl+C) to stop.' 'Green'
    Write-Say '=====================================================================' 'Green'
    Write-Say ''
    Write-Log ('serving: ' + $py + ' ' + (ConvertTo-ArgString $serveArgs))

    $env:PYTHONUNBUFFERED = '1'
    $server = Start-Process -FilePath $py -ArgumentList (ConvertTo-ArgString $serveArgs) -NoNewWindow -PassThru
    if (-not (Wait-TcpPort $port 20)) {
        Stop-Build 'The web server did not start.' 'Run build.bat again; if it keeps failing, send the log file.'
    }
    if (-not $opt.NoBrowser) {
        try { Start-Process $url } catch { Write-Say ('    (could not open the browser automatically; open ' + $url + ' yourself)') }
    }
    $server.WaitForExit()
    Write-Say ''
    Write-Say 'The server has stopped.'
    return 0
}

$exitCode = 1
try {
    $r = @(Invoke-Main)
    $exitCode = [int]$r[-1]
}
catch {
    if (-not $script:Handled) {
        $msg = $_.Exception.Message
        Write-Log ('UNEXPECTED ERROR: ' + ($_ | Out-String))
        Write-Host ''
        Write-Host '=====================================================================' -ForegroundColor Red
        Write-Host ('  STOPPED: ' + $msg) -ForegroundColor Red
        Write-Host '=====================================================================' -ForegroundColor Red
        Write-Host ('What to try: ' + (Get-LikelyFix $msg)) -ForegroundColor Yellow
        if ($script:LogPath) { Write-Host ('Full log: ' + $script:LogPath) }
    }
    if ($script:Handled -and $_.Exception.Message -eq 'needs user action') { $exitCode = 2 } else { $exitCode = 1 }
}
finally {
    Close-Log
}
exit $exitCode
