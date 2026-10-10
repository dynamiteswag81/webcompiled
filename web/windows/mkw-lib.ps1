# Helper functions for web/windows/build-windows.ps1 (build.bat).
#
# Works in Windows PowerShell 5.1 (the only PowerShell a stock Windows 10/11 PC has) and in
# PowerShell 7 (used by the automated tests on Linux). Keep it that way:
# no ??, ?., ternary, &&, ||, -AsHashtable, ForEach-Object -Parallel, $IsWindows, pwsh-only .NET.
# `web/windows/tests/Test-Ps51Compat.ps1` enforces this. Keep the file ASCII-only (Windows
# PowerShell reads a BOM-less file in the ANSI code page).
#
# Dot-source it; it only defines functions and a few script-scope variables.

$script:OnWindows = ($env:OS -eq 'Windows_NT')
$script:LogWriter = $null
$script:LogPath = ''
$script:Tail = New-Object 'System.Collections.Generic.Queue[string]'
$script:LastProgressPercent = -1

# ---------------------------------------------------------------------------
# Output and log
# ---------------------------------------------------------------------------
function Open-Log {
    param([Parameter(Mandatory = $true)][string]$Path)
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    if ((Test-Path -LiteralPath $Path) -and ((Get-Item -LiteralPath $Path).Length -gt 20MB)) {
        Move-Item -LiteralPath $Path -Destination ($Path + '.old') -Force
    }
    $fs = New-Object System.IO.FileStream($Path, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
    $script:LogWriter = New-Object System.IO.StreamWriter($fs, (New-Object System.Text.UTF8Encoding($false)))
    $script:LogWriter.AutoFlush = $true
    $script:LogPath = $Path
}

function Close-Log {
    if ($script:LogWriter) {
        try { $script:LogWriter.Dispose() } catch { }
        $script:LogWriter = $null
    }
}

function Write-Log {
    param([string]$Text = '')
    if ($script:LogWriter) {
        try { $script:LogWriter.WriteLine($Text) } catch { }
    }
}

# Console and log.
function Write-Say {
    param([string]$Text = '', [string]$Color = '')
    if ($Color) { Write-Host $Text -ForegroundColor $Color } else { Write-Host $Text }
    Write-Log ((Get-Date).ToString('HH:mm:ss') + ' ' + $Text)
}

function Format-Size {
    param([double]$Bytes)
    if ($Bytes -ge 1GB) { return ('{0:N2} GB' -f ($Bytes / 1GB)) }
    if ($Bytes -ge 1MB) { return ('{0:N1} MB' -f ($Bytes / 1MB)) }
    if ($Bytes -ge 1KB) { return ('{0:N0} KB' -f ($Bytes / 1KB)) }
    return ('{0:N0} bytes' -f $Bytes)
}

function Format-Duration {
    param([TimeSpan]$Span)
    if ($Span.TotalHours -ge 1) { return ('{0}h {1:00}m {2:00}s' -f [int][math]::Floor($Span.TotalHours), $Span.Minutes, $Span.Seconds) }
    if ($Span.TotalMinutes -ge 1) { return ('{0}m {1:00}s' -f $Span.Minutes, $Span.Seconds) }
    return ('{0}s' -f [int][math]::Round($Span.TotalSeconds))
}

# Read an optional property of a ConvertFrom-Json object (strict mode throws on a missing one).
function Get-Prop {
    param($Obj, [string]$Name, $Default = $null)
    if ($null -eq $Obj) { return $Default }
    $p = $Obj.PSObject.Properties[$Name]
    if ($null -eq $p) { return $Default }
    return $p.Value
}

function Remove-Tree {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    try {
        Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
    } catch {
        if ($script:OnWindows) {
            # Deep trees and read-only files: cmd's rmdir copes where Remove-Item sometimes does not.
            & cmd.exe /d /c ('rmdir /s /q "' + $Path + '"') 2>&1 | Out-Null
        }
        if (Test-Path -LiteralPath $Path) { throw }
    }
}

# ---------------------------------------------------------------------------
# Network, hashes, archives
# ---------------------------------------------------------------------------
function Initialize-Network {
    # Windows PowerShell 5.1 defaults to TLS 1.0/1.1 on older .NET settings; GitHub and Google need 1.2.
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }
    try { [Net.ServicePointManager]::Expect100Continue = $false } catch { }
}

function Get-HashHex {
    param([string]$Path, [string]$Algorithm)
    return (Get-FileHash -LiteralPath $Path -Algorithm $Algorithm).Hash.ToLowerInvariant()
}

# Returns '' when every hash the entry declares matches, otherwise a description of the mismatch.
function Test-FileHashes {
    param([string]$Path, $Entry)
    $problems = @()
    $any = $false
    foreach ($algo in @('sha256', 'sha512')) {
        $want = Get-Prop $Entry $algo ''
        if (-not $want) { continue }
        $any = $true
        $got = Get-HashHex $Path $algo
        if ($got -ne $want.ToLowerInvariant()) { $problems += ('{0} expected {1} but the file has {2}' -f $algo.ToUpperInvariant(), $want, $got) }
    }
    if (-not $any) { return 'the manifest has no hash for this file (refusing to use an unverified download)' }
    return ($problems -join '; ')
}

function Write-DownloadProgress {
    param([string]$Label, [long]$Done, [long]$Total, [double]$BytesPerSecond, [switch]$Final)
    $interactive = $true
    try { $interactive = -not [Console]::IsOutputRedirected } catch { }
    if ($Total -gt 0) {
        $percent = [int][math]::Floor(100.0 * $Done / $Total)
        $text = ('    {0}: {1}%  {2} of {3}  ({4}/s)' -f $Label, $percent, (Format-Size $Done), (Format-Size $Total), (Format-Size $BytesPerSecond))
    } else {
        $percent = -1
        $text = ('    {0}: {1}  ({2}/s)' -f $Label, (Format-Size $Done), (Format-Size $BytesPerSecond))
    }
    if ($interactive) {
        if ($Final) {
            Write-Host ("`r" + $text.PadRight(78))
        } else {
            Write-Host ("`r" + $text.PadRight(78)) -NoNewline
        }
    } elseif ($Final -or ($percent -ge 0 -and $percent -ge ($script:LastProgressPercent + 20))) {
        Write-Host $text
        $script:LastProgressPercent = $percent
    }
}

# One attempt: stream Url into $Part, continuing from what is already there (HTTP Range).
function Save-DownloadOnce {
    param([string]$Url, [string]$Part, [string]$Label, [long]$ExpectedSize)
    $existing = 0
    if (Test-Path -LiteralPath $Part) { $existing = (Get-Item -LiteralPath $Part).Length }
    if ($ExpectedSize -gt 0 -and $existing -gt $ExpectedSize) { Remove-Item -LiteralPath $Part -Force; $existing = 0 }

    $req = [System.Net.HttpWebRequest][System.Net.WebRequest]::Create($Url)
    $req.UserAgent = 'WiiCompiled-web-build'
    $req.Timeout = 60000
    $req.ReadWriteTimeout = 60000
    $req.AllowAutoRedirect = $true
    try {
        $req.Proxy = [System.Net.WebRequest]::GetSystemWebProxy()
        $req.Proxy.Credentials = [System.Net.CredentialCache]::DefaultCredentials
    } catch { }
    if ($existing -gt 0) { $req.AddRange([long]$existing) }

    $resp = $null
    try {
        try {
            $resp = $req.GetResponse()
        } catch [System.Net.WebException] {
            $r = $_.Exception.Response
            if ($null -ne $r -and [int]$r.StatusCode -eq 416 -and $existing -gt 0) { return }   # the part file is already complete
            throw
        }
        $append = ([int]$resp.StatusCode -eq 206 -and $existing -gt 0)
        if (-not $append) { $existing = 0 }
        $total = 0
        if ($resp.ContentLength -gt 0) { $total = $resp.ContentLength + $existing } elseif ($ExpectedSize -gt 0) { $total = $ExpectedSize }
        if ($existing -gt 0) { Write-Say ('    resuming {0} at {1}' -f $Label, (Format-Size $existing)) }

        $mode = [System.IO.FileMode]::Create
        if ($append) { $mode = [System.IO.FileMode]::Append }
        $in = $resp.GetResponseStream()
        $out = New-Object System.IO.FileStream($Part, $mode, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
        try {
            $buffer = New-Object byte[] (256KB)
            $done = $existing
            $started = Get-Date
            $lastShown = $started
            $script:LastProgressPercent = -1
            while (($n = $in.Read($buffer, 0, $buffer.Length)) -gt 0) {
                $out.Write($buffer, 0, $n)
                $done += $n
                $now = Get-Date
                if (($now - $lastShown).TotalMilliseconds -ge 300) {
                    $secs = [math]::Max(($now - $started).TotalSeconds, 0.001)
                    Write-DownloadProgress $Label $done $total (($done - $existing) / $secs)
                    $lastShown = $now
                }
            }
            $secs = [math]::Max(((Get-Date) - $started).TotalSeconds, 0.001)
            Write-DownloadProgress $Label $done $total (($done - $existing) / $secs) -Final
        } finally {
            $out.Dispose()
            $in.Dispose()
        }
    } finally {
        if ($null -ne $resp) { $resp.Close() }
    }
}

# Download with up to three retries; each retry continues where the last one stopped.
function Save-Download {
    param([string]$Url, [string]$Part, [string]$Label, [long]$ExpectedSize = 0)
    $attempt = 0
    while ($true) {
        $attempt++
        try {
            Save-DownloadOnce -Url $Url -Part $Part -Label $Label -ExpectedSize $ExpectedSize
            return
        } catch {
            if ($attempt -ge 4) { throw }
            Write-Say ('    download interrupted ({0}); retrying {1}/3 ...' -f $_.Exception.Message, $attempt)
            Start-Sleep -Seconds (2 * $attempt)
        }
    }
}

# Download Url to $Final unless a file there already matches the entry's hashes. Never leaves an
# unverified file at $Final; a partial download stays at "$Final.part" so the next run resumes it.
function Get-VerifiedDownload {
    param([string]$Url, [string]$Final, $Entry, [string]$Label)
    $dir = Split-Path -Parent $Final
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    if (Test-Path -LiteralPath $Final) {
        $bad = Test-FileHashes $Final $Entry
        if (-not $bad) { return $Final }
        Write-Say ("    {0}: the copy on disk does not match the pinned hash, downloading it again" -f $Label)
        Remove-Item -LiteralPath $Final -Force
    }
    if (-not ((Get-Prop $Entry 'sha256' '') -or (Get-Prop $Entry 'sha512' ''))) {
        throw ("There is no pinned hash for {0} in the toolchain manifest; refusing to download an unverified file." -f $Label)
    }
    $part = $Final + '.part'
    $size = [long](Get-Prop $Entry 'size' 0)
    $lastProblem = ''
    for ($try = 1; $try -le 2; $try++) {
        Write-Say ("    downloading {0}" -f $Label)
        Write-Log ("      from {0}" -f $Url)
        Save-Download -Url $Url -Part $part -Label $Label -ExpectedSize $size
        Write-Say '    checking the download ...'
        $lastProblem = Test-FileHashes $part $Entry
        if (-not $lastProblem) {
            Move-Item -LiteralPath $part -Destination $Final -Force
            return $Final
        }
        Write-Say ("    hash mismatch: {0}" -f $lastProblem)
        Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue
    }
    throw ("The download of {0} does not match the pinned hash ({1}). Nothing was installed. If you are behind a proxy, firewall or antivirus that rewrites downloads, allow {2} and try again." -f $Label, $lastProblem, $Url)
}

function Expand-ZipArchive {
    param([string]$Zip, [string]$Dest)
    Remove-Tree $Dest
    New-Item -ItemType Directory -Force -Path $Dest | Out-Null
    $done = $false
    try {
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [System.IO.Compression.ZipFile]::ExtractToDirectory($Zip, $Dest)
        $done = $true
    } catch {
        Write-Log ('ZipFile extraction failed (' + $_.Exception.Message + '); falling back to Expand-Archive')
        Remove-Tree $Dest
        New-Item -ItemType Directory -Force -Path $Dest | Out-Null
    }
    if (-not $done) { Expand-Archive -LiteralPath $Zip -DestinationPath $Dest -Force }
}

# ---------------------------------------------------------------------------
# Toolchain manifest
# ---------------------------------------------------------------------------
function Read-ToolchainLock {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "The toolchain manifest is missing: $Path" }
    $lock = (Get-Content -LiteralPath $Path -Raw) | ConvertFrom-Json
    if ((Get-Prop $lock 'schema' 0) -ne 1) { throw "Unsupported toolchain manifest schema in $Path" }
    return $lock
}

# A short string that changes when the pinned download of a tool changes.
function Get-ToolFingerprint {
    param($Tool)
    $kind = Get-Prop $Tool 'kind' ''
    $parts = @($Tool.id, $kind)
    if ($kind -eq 'emsdk') {
        foreach ($f in @($Tool.files)) { $parts += (Get-Prop $f 'sha256' '') }
        foreach ($p in @($Tool.packages)) { $parts += (Get-Prop $p 'sha256' '') }
        $parts += (Get-Prop $Tool 'version' '')
    } else {
        $parts += (Get-Prop $Tool 'sha256' '')
        $parts += (Get-Prop $Tool 'sha512' '')
    }
    return ($parts -join '|')
}

function Test-ToolInstalled {
    param($Tool, [string]$ToolsDir)
    $dest = Join-Path $ToolsDir $Tool.dest
    $stamp = Join-Path $dest '.mkw-installed'
    $marker = Join-Path $dest ((Get-Prop $Tool 'marker' '') -replace '/', [IO.Path]::DirectorySeparatorChar)
    if (-not (Test-Path -LiteralPath $marker)) { return $false }
    if (-not (Test-Path -LiteralPath $stamp -PathType Leaf)) { return $false }
    return ((Get-Content -LiteralPath $stamp -Raw).Trim() -eq (Get-ToolFingerprint $Tool))
}

function Set-ToolInstalled {
    param($Tool, [string]$ToolsDir)
    $stamp = Join-Path (Join-Path $ToolsDir $Tool.dest) '.mkw-installed'
    [System.IO.File]::WriteAllText($stamp, (Get-ToolFingerprint $Tool) + "`n")
}

# Install one 'zip' or 'file' tool from the manifest into $ToolsDir\<dest>. Skips it when present.
function Install-LockedTool {
    param($Tool, [string]$ToolsDir, [string]$DownloadDir, [switch]$KeepDownloads)
    $title = Get-Prop $Tool 'title' $Tool.id
    if (Test-ToolInstalled $Tool $ToolsDir) {
        Write-Say ("    {0}: already installed" -f $title)
        return
    }
    $dest = Join-Path $ToolsDir $Tool.dest
    $archive = Get-VerifiedDownload -Url $Tool.url -Final (Join-Path $DownloadDir $Tool.file) -Entry $Tool -Label $title
    $kind = Get-Prop $Tool 'kind' 'zip'
    if ($kind -eq 'file') {
        Remove-Tree $dest
        New-Item -ItemType Directory -Force -Path $dest | Out-Null
        Copy-Item -LiteralPath $archive -Destination (Join-Path $dest $Tool.name) -Force
    } elseif ($kind -eq 'zip') {
        Write-Say ("    unpacking {0} ..." -f $title)
        $tmp = Join-Path $ToolsDir ('.extract-' + $Tool.id)
        Expand-ZipArchive -Zip $archive -Dest $tmp
        $src = $tmp
        $inner = Get-Prop $Tool 'innerDir' ''
        if ($inner) { $src = Join-Path $tmp $inner }
        if (-not (Test-Path -LiteralPath $src -PathType Container)) { throw "${title}: the archive layout is not what the manifest expects (missing '$inner')." }
        Remove-Tree $dest
        Move-Item -LiteralPath $src -Destination $dest
        Remove-Tree $tmp
    } else {
        throw "Unknown tool kind '$kind' for $($Tool.id)"
    }
    $marker = Join-Path $dest ((Get-Prop $Tool 'marker' '') -replace '/', [IO.Path]::DirectorySeparatorChar)
    if (-not (Test-Path -LiteralPath $marker)) { throw "$title was unpacked but $marker is missing." }
    Set-ToolInstalled $Tool $ToolsDir
    if (-not $KeepDownloads) { Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue }
    Write-Say ("    {0}: installed" -f $title)
}

# ---------------------------------------------------------------------------
# Running programs with live, filtered console output and a full log
# ---------------------------------------------------------------------------
# Windows command-line quoting (the rules CommandLineToArgvW and the C runtime parse).
function ConvertTo-ArgString {
    param([string[]]$Arguments)
    $parts = @()
    foreach ($a in @($Arguments)) {
        if ($null -eq $a) { continue }
        if ($a.Length -gt 0 -and $a -notmatch '[\s"]') { $parts += $a; continue }
        $s = $a -replace '(\\*)"', '$1$1\"'
        $s = $s -replace '(\\+)$', '$1$1'
        $parts += ('"' + $s + '"')
    }
    return ($parts -join ' ')
}

# Runs a program, copies every output line (stdout and stderr) to the log, hands each line to
# $OnLine (which prints what is worth showing) and returns the exit code. Redirection happens
# in .NET, not in PowerShell, so Windows PowerShell 5.1 cannot turn stderr text into errors.
function Invoke-Logged {
    param(
        [Parameter(Mandatory = $true)][string]$Exe,
        [string[]]$Arguments = @(),
        [string]$WorkDir = '',
        [scriptblock]$OnLine = $null,
        [switch]$Echo
    )
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $Exe
    $psi.Arguments = ConvertTo-ArgString $Arguments
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.RedirectStandardInput = $true
    $psi.CreateNoWindow = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    if ($WorkDir) { $psi.WorkingDirectory = $WorkDir }
    Write-Log ('> ' + $Exe + ' ' + $psi.Arguments)
    $script:Tail.Clear()

    $p = [System.Diagnostics.Process]::Start($psi)
    $p.StandardInput.Close()   # nothing may wait for a keypress
    $tOut = $p.StandardOutput.ReadLineAsync()
    $tErr = $p.StandardError.ReadLineAsync()
    while (($null -ne $tOut) -or ($null -ne $tErr)) {
        $wait = @()
        if ($null -ne $tOut) { $wait += $tOut }
        if ($null -ne $tErr) { $wait += $tErr }
        [void][System.Threading.Tasks.Task]::WaitAny([System.Threading.Tasks.Task[]]$wait, 500)
        foreach ($which in @('out', 'err')) {
            if ($which -eq 'out') { $task = $tOut } else { $task = $tErr }
            if ($null -eq $task -or -not $task.IsCompleted) { continue }
            $line = $task.Result
            if ($null -eq $line) {
                if ($which -eq 'out') { $tOut = $null } else { $tErr = $null }
                continue
            }
            if ($which -eq 'out') { $tOut = $p.StandardOutput.ReadLineAsync() } else { $tErr = $p.StandardError.ReadLineAsync() }
            Write-Log $line
            $script:Tail.Enqueue($line)
            while ($script:Tail.Count -gt 60) { [void]$script:Tail.Dequeue() }
            if ($null -ne $OnLine) { & $OnLine $line } elseif ($Echo) { Write-Host ('    ' + $line) }
        }
    }
    $p.WaitForExit()
    $code = $p.ExitCode
    $p.Dispose()
    Write-Log ('< exit code ' + $code)
    return $code
}

# ---------------------------------------------------------------------------
# Game files
# ---------------------------------------------------------------------------
$script:DiscExtensions = @('.iso', '.gcm', '.gcz', '.ciso', '.wbfs', '.wia', '.rvz')

# Same rules as web/host.ps1 (disc image up to two folders deep, extracted tree with
# sys/main.dol, optional RetroRewind6\Binaries\Code.pul), but returns the problem text
# instead of exiting.
function Find-GameFiles {
    param([Parameter(Mandatory = $true)][string]$GameDir)
    $result = New-Object psobject -Property @{ Ok = $false; Kind = ''; Input = ''; RetroRoot = ''; Message = ''; Images = @(); Trees = @(); Puls = @() }
    if (-not (Test-Path -LiteralPath $GameDir -PathType Container)) {
        try { New-Item -ItemType Directory -Force -Path $GameDir | Out-Null } catch { }
    }
    if (-not (Test-Path -LiteralPath $GameDir -PathType Container)) {
        $result.Message = "The game folder does not exist and could not be created:`n    $GameDir"
        return $result
    }
    $gameDir = (Resolve-Path -LiteralPath $GameDir).Path

    $images = @(Get-ChildItem -LiteralPath $gameDir -Recurse -Depth 1 -File -ErrorAction SilentlyContinue |
        Where-Object { $script:DiscExtensions -contains $_.Extension.ToLowerInvariant() -and -not $_.Name.StartsWith('._') } |
        Sort-Object FullName | ForEach-Object { $_.FullName })
    $trees = @()
    if (Test-Path -LiteralPath (Join-Path (Join-Path $gameDir 'sys') 'main.dol') -PathType Leaf) {
        $trees = @($gameDir)
    } else {
        $trees = @(Get-ChildItem -LiteralPath $gameDir -Recurse -Depth 2 -File -Filter 'main.dol' -ErrorAction SilentlyContinue |
            Where-Object { $_.Directory.Name -eq 'sys' } | Sort-Object FullName | ForEach-Object { $_.Directory.Parent.FullName })
    }
    $puls = @(Get-ChildItem -LiteralPath $gameDir -Recurse -Depth 3 -File -Filter 'Code.pul' -ErrorAction SilentlyContinue |
        Where-Object { $_.Directory.Name -eq 'Binaries' } | Sort-Object FullName | ForEach-Object { $_.FullName })
    $result.Images = $images
    $result.Trees = $trees
    $result.Puls = $puls

    $accepted = '.iso  .rvz  .wbfs  .gcz  .ciso  .wia  .gcm'
    if ($images.Count -gt 0 -and $trees.Count -gt 0) {
        $result.Message = "Found both a disc image and an extracted game folder in:`n    $gameDir`n    $($images[0])`n    $($trees[0])`nWhat to do: keep only ONE of them. Move the other one out of that folder, then run build.bat again."
        return $result
    }
    if ($images.Count -gt 1) {
        $result.Message = "Found $($images.Count) disc images, but exactly one is wanted:`n" + (($images | ForEach-Object { "    $_" }) -join "`n") + "`nWhat to do: move all but one out of the folder, then run build.bat again."
        return $result
    }
    if ($trees.Count -gt 1) {
        $result.Message = "Found $($trees.Count) extracted game folders (each with sys\main.dol):`n" + (($trees | ForEach-Object { "    $_" }) -join "`n") + "`nWhat to do: keep only one, then run build.bat again."
        return $result
    }
    if ($puls.Count -gt 1) {
        $result.Message = "Found $($puls.Count) Retro Rewind folders (several Binaries\Code.pul):`n" + (($puls | ForEach-Object { "    $_" }) -join "`n") + "`nWhat to do: keep only one RetroRewind6 folder, then run build.bat again."
        return $result
    }
    if ($images.Count -eq 0 -and $trees.Count -eq 0) {
        $result.Message = "No game file found in:`n    $gameDir`n`nWhat to do:`n  1. Copy YOUR OWN Mario Kart Wii disc image (PAL version, game ID RMCP01) into that folder.`n     Accepted file types: $accepted`n     (or an already extracted DATA folder that contains sys\main.dol and a files folder).`n  2. Optional, for Retro Rewind: also copy the RetroRewind6 folder there`n     (the one that contains Binaries\Code.pul).`n  3. Double-click build.bat again."
        return $result
    }
    if ($images.Count -eq 1) { $result.Kind = 'image'; $result.Input = $images[0] } else { $result.Kind = 'tree'; $result.Input = $trees[0] }
    if ($puls.Count -eq 1) { $result.RetroRoot = (Get-Item -LiteralPath $puls[0]).Directory.Parent.FullName }
    $result.Ok = $true
    return $result
}

# ---------------------------------------------------------------------------
# Fingerprint of this source tree (a downloaded ZIP has no git history to ask)
# ---------------------------------------------------------------------------
# Hash of the file contents under the folders the build reads, minus generated output. Passed to
# web/host.ps1 as MKW_REPO_COMMIT so its "already built?" check notices when the sources change.
function Get-SourceFingerprint {
    param([Parameter(Mandatory = $true)][string]$Root)
    $rootFull = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\', '/')
    $skip = '^(translator/.*/(bin|obj|TestResults)/|web/(build|dist|game|windows/tests)/)|/__pycache__/|\.pyc$'
    $lines = New-Object 'System.Collections.Generic.List[string]'
    foreach ($top in @('translator', 'runtime', 'aurora-main', 'projects', 'web')) {
        $dir = Join-Path $rootFull $top
        if (-not (Test-Path -LiteralPath $dir -PathType Container)) { continue }
        $di = New-Object System.IO.DirectoryInfo($dir)
        foreach ($fi in $di.EnumerateFiles('*', [System.IO.SearchOption]::AllDirectories)) {
            $rel = $fi.FullName.Substring($rootFull.Length + 1).Replace('\', '/')
            if ($rel -match $skip) { continue }
            $lines.Add($rel + '|' + (Get-HashHex $fi.FullName 'SHA256'))
        }
    }
    $arr = $lines.ToArray()
    [Array]::Sort($arr, [StringComparer]::Ordinal)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes(($arr -join "`n"))
        return 'src-' + ([System.BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').ToLowerInvariant()
    } finally { $sha.Dispose() }
}

# ---------------------------------------------------------------------------
# Environment and diagnosis helpers
# ---------------------------------------------------------------------------
function Get-FreeSpaceGB {
    param([string]$Path)
    try {
        $drive = New-Object System.IO.DriveInfo([System.IO.Path]::GetPathRoot($Path))
        return [int][math]::Floor($drive.AvailableFreeSpace / 1GB)
    } catch { return -1 }
}

function Get-TotalMemoryGB {
    try {
        $cs = Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop
        return [int][math]::Floor($cs.TotalPhysicalMemory / 1GB)
    } catch { return -1 }
}

function Test-PortFree {
    param([int]$Port, [string]$Address = '127.0.0.1')
    $listener = $null
    try {
        $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Parse($Address), $Port)
        $listener.Start()
        return $true
    } catch { return $false } finally {
        if ($null -ne $listener) { try { $listener.Stop() } catch { } }
    }
}

function Wait-TcpPort {
    param([int]$Port, [int]$TimeoutSeconds = 15)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $client = New-Object System.Net.Sockets.TcpClient
        try {
            $client.Connect('127.0.0.1', $Port)
            return $true
        } catch {
            Start-Sleep -Milliseconds 200
        } finally { $client.Close() }
    }
    return $false
}

# Map the end of a failed run's output to a plain-language suggestion.
function Get-LikelyFix {
    param([string]$Text)
    if ($Text -match 'sha256 mismatch') {
        return "The disc image is not an unmodified PAL (RMCP01) copy of Mario Kart Wii. Use a clean, unmodified PAL disc image."
    }
    if ($Text -match 'certificate|SSL|TLS|CERT_|signer') {
        return "A secure download was blocked. Antivirus 'web shield' or a company proxy can do this. Pause HTTPS scanning (or allow github.com and storage.googleapis.com) and run build.bat again; finished downloads are kept."
    }
    if ($Text -match 'No space left|not enough space|There is not enough space|disk full') {
        return "The disk is full. The first build needs about 20 GB free. Free some space and run build.bat again."
    }
    if ($Text -match 'out of memory|bad_alloc|Cannot allocate memory|killed|OutOfMemory') {
        return "The computer ran out of memory. Close other programs (browser tabs, games) and run: build.bat --jobs 2"
    }
    if ($Text -match 'too long|MAX_PATH|Filename too long|path.*(260|exceed)') {
        return "A file path got too long for Windows. Move the whole WiiCompiled folder to a short path such as C:\WiiCompiled and run build.bat again."
    }
    if ($Text -match 'Could not resolve|name resolution|Unable to connect|timed out|No such host|download.*(fail|interrupt)|Couldn.t connect|Failed to download|WebException') {
        return "A download failed. Check your internet connection (and proxy/firewall) and run build.bat again; it continues where it stopped."
    }
    if ($Text -match 'Access to the path|being used by another process|denied') {
        return "Windows blocked a file. Antivirus can lock freshly built files; wait a minute (or exclude this folder from scanning) and run build.bat again."
    }
    return "Run build.bat again; it continues where it stopped. If it fails the same way, send the log file."
}
