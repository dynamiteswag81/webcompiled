# Behaviour tests for web/windows/mkw-lib.ps1 and build-windows.ps1 that do not need Windows.
#
# Run with PowerShell 7 (see run-tests.sh). A local web/serve.py stands in for GitHub / nuget:
# it supports HTTP Range, so resume is exercised for real. The fake game files are random bytes;
# no game data is involved.
#
# What is NOT covered here (needs a real Windows PC): Windows PowerShell 5.1 semantics, the real
# downloads, emsdk, cmd/build.bat, the Explorer double-click, the real compile.
param([int]$Port = 18765)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$winDir = Join-Path (Join-Path $repo 'web') 'windows'
. (Join-Path $winDir 'mkw-lib.ps1')

$work = Join-Path ([System.IO.Path]::GetTempPath()) ('mkw-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $work | Out-Null
$srv = Join-Path $work 'srv'
New-Item -ItemType Directory -Force -Path $srv | Out-Null

$script:Pass = 0
$script:Fail = 0
function Assert-That {
    param([bool]$Condition, [string]$Name, [string]$Detail = '')
    if ($Condition) { $script:Pass++; Write-Host ("  ok   {0}" -f $Name) -ForegroundColor Green }
    else { $script:Fail++; Write-Host ("  FAIL {0} {1}" -f $Name, $Detail) -ForegroundColor Red }
}
function Get-LogText { if ($script:LogPath -and (Test-Path -LiteralPath $script:LogPath)) { return [System.IO.File]::ReadAllText($script:LogPath) } return '' }

# ---------------------------------------------------------------------------
# Fixtures served over HTTP
# ---------------------------------------------------------------------------
$rng = New-Object System.Random(42)
$big = New-Object byte[] (3MB)
$rng.NextBytes($big)
[System.IO.File]::WriteAllBytes((Join-Path $srv 'blob.bin'), $big)
$blobSha256 = Get-HashHex (Join-Path $srv 'blob.bin') 'SHA256'
$blobSha512 = Get-HashHex (Join-Path $srv 'blob.bin') 'SHA512'

# zip with an inner dir (like cmake) and a marker file
$zipSrc = Join-Path $work 'zipsrc'
New-Item -ItemType Directory -Force -Path (Join-Path $zipSrc 'inner-1.0/bin') | Out-Null
[System.IO.File]::WriteAllText((Join-Path $zipSrc 'inner-1.0/bin/tool.txt'), 'hello')
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($zipSrc, (Join-Path $srv 'tool.zip'))
$zipSha256 = Get-HashHex (Join-Path $srv 'tool.zip') 'SHA256'

$serveLog = Join-Path $work 'serve.log'
$server = Start-Process -FilePath 'python3' -ArgumentList @((Join-Path (Join-Path $repo 'web') 'serve.py'), '--dir', $srv, '--port', "$Port", '--quiet') -PassThru -RedirectStandardError $serveLog -RedirectStandardOutput (Join-Path $work 'serve.out')
$base = "http://127.0.0.1:$Port"
if (-not (Wait-TcpPort $Port 15)) { Write-Host 'test server did not start'; exit 2 }
Initialize-Network

try {
    $logFile = Join-Path $work 'test.log'
    Open-Log $logFile

    Write-Host '== hashes and downloads'
    $dl = Join-Path $work 'dl'
    $entry = [pscustomobject]@{ sha256 = $blobSha256; size = $big.Length }
    $p = Get-VerifiedDownload -Url "$base/blob.bin" -Final (Join-Path $dl 'blob.bin') -Entry $entry -Label 'blob'
    Assert-That ((Get-HashHex $p 'SHA256') -eq $blobSha256) 'download is verified and kept at the final path'
    Assert-That (-not (Test-Path -LiteralPath ($p + '.part'))) 'no .part file is left behind'

    $mtime = (Get-Item -LiteralPath $p).LastWriteTimeUtc
    Start-Sleep -Milliseconds 1100
    [void](Get-VerifiedDownload -Url "$base/blob.bin" -Final $p -Entry $entry -Label 'blob')
    Assert-That ((Get-Item -LiteralPath $p).LastWriteTimeUtc -eq $mtime) 'a present, valid file is skipped (not downloaded again)'

    [System.IO.File]::WriteAllBytes($p, [byte[]](1, 2, 3))
    [void](Get-VerifiedDownload -Url "$base/blob.bin" -Final $p -Entry $entry -Label 'blob')
    Assert-That ((Get-HashHex $p 'SHA256') -eq $blobSha256) 'a corrupt cached file is replaced'

    $bad = [pscustomobject]@{ sha256 = ('0' * 64); size = $big.Length }
    $threw = $false
    $badFinal = Join-Path $dl 'bad.bin'
    try { [void](Get-VerifiedDownload -Url "$base/blob.bin" -Final $badFinal -Entry $bad -Label 'bad') } catch { $threw = $true; $msg = $_.Exception.Message }
    Assert-That $threw 'a wrong hash is refused'
    Assert-That ($threw -and $msg -match 'does not match the pinned hash') 'the refusal says why' $msg
    Assert-That ((-not (Test-Path -LiteralPath $badFinal)) -and (-not (Test-Path -LiteralPath ($badFinal + '.part')))) 'nothing unverified is left on disk'

    $noHash = [pscustomobject]@{ size = $big.Length }
    $threw = $false
    try { [void](Get-VerifiedDownload -Url "$base/blob.bin" -Final (Join-Path $dl 'nohash.bin') -Entry $noHash -Label 'nohash') } catch { $threw = $true }
    Assert-That $threw 'an entry without any hash is refused'

    $only512 = [pscustomobject]@{ sha512 = $blobSha512; size = $big.Length }
    $p2 = Get-VerifiedDownload -Url "$base/blob.bin" -Final (Join-Path $dl 'blob512.bin') -Entry $only512 -Label 'blob512'
    Assert-That (Test-Path -LiteralPath $p2) 'a SHA-512-only entry (vendor hash) verifies'

    # Resume: a partial file from an earlier, interrupted run
    $resumeFinal = Join-Path $dl 'resume.bin'
    $partBytes = New-Object byte[] (1MB + 17)
    [Array]::Copy($big, $partBytes, $partBytes.Length)
    [System.IO.File]::WriteAllBytes($resumeFinal + '.part', $partBytes)
    $before = (Get-LogText).Length
    $p3 = Get-VerifiedDownload -Url "$base/blob.bin" -Final $resumeFinal -Entry $entry -Label 'resume'
    Assert-That ((Get-HashHex $p3 'SHA256') -eq $blobSha256) 'an interrupted download resumes and verifies'
    Assert-That ((Get-LogText).Substring($before) -match 'resuming resume at') 'resume was used (Range request), not a full restart'

    # A garbage .part that no longer matches the server file is detected and re-fetched
    $garbageFinal = Join-Path $dl 'garbage.bin'
    [System.IO.File]::WriteAllBytes($garbageFinal + '.part', (New-Object byte[] (500KB)))
    $p4 = Get-VerifiedDownload -Url "$base/blob.bin" -Final $garbageFinal -Entry $entry -Label 'garbage'
    Assert-That ((Get-HashHex $p4 'SHA256') -eq $blobSha256) 'a stale/garbage .part is detected by the hash and downloaded fresh'

    Write-Host '== install from the manifest'
    $tools = Join-Path $work 'tools'
    $dldir = Join-Path $tools 'downloads'
    New-Item -ItemType Directory -Force -Path $tools, $dldir | Out-Null
    $zipTool = [pscustomobject]@{ id = 'ziptool'; title = 'Zip tool'; kind = 'zip'; url = "$base/tool.zip"; file = 'tool.zip'; sha256 = $zipSha256; innerDir = 'inner-1.0'; dest = 'ziptool'; marker = 'bin/tool.txt' }
    Install-LockedTool -Tool $zipTool -ToolsDir $tools -DownloadDir $dldir
    Assert-That (Test-Path -LiteralPath (Join-Path $tools 'ziptool/bin/tool.txt')) 'zip tool unpacked with innerDir stripped'
    Assert-That (Test-ToolInstalled $zipTool $tools) 'installed stamp recorded'
    Assert-That (-not (Test-Path -LiteralPath (Join-Path $dldir 'tool.zip'))) 'archive removed after install'
    $before = (Get-LogText).Length
    Install-LockedTool -Tool $zipTool -ToolsDir $tools -DownloadDir $dldir
    Assert-That ((Get-LogText).Substring($before) -match 'already installed') 'second install is skipped'
    $zipTool2 = [pscustomobject]@{ id = 'ziptool'; title = 'Zip tool'; kind = 'zip'; url = "$base/tool.zip"; file = 'tool.zip'; sha256 = $zipSha256; sha512 = 'x'; innerDir = 'inner-1.0'; dest = 'ziptool'; marker = 'bin/tool.txt' }
    Assert-That (-not (Test-ToolInstalled $zipTool2 $tools)) 'a changed pin invalidates the installed stamp'
    $fileTool = [pscustomobject]@{ id = 'filetool'; title = 'File tool'; kind = 'file'; url = "$base/blob.bin"; file = 'blob.bin'; sha256 = $blobSha256; dest = 'filetool'; name = 'nodtool.exe'; marker = 'nodtool.exe' }
    Install-LockedTool -Tool $fileTool -ToolsDir $tools -DownloadDir $dldir
    Assert-That (Test-Path -LiteralPath (Join-Path $tools 'filetool/nodtool.exe')) 'single-file tool is copied under its name'

    Write-Host '== game folder detection'
    $g = Join-Path $work 'game'
    $r = Find-GameFiles $g
    Assert-That ((-not $r.Ok) -and $r.Message -match 'No game file found') 'empty folder: asks for a disc image'
    Assert-That ($r.Message -match '\.iso' -and $r.Message -match '\.rvz' -and $r.Message -match 'RMCP01') 'empty folder: lists accepted types and the PAL id'
    $forbidden = '(?i)\b(download|obtain|buy|purchase|torrent|dump(ing)? your|rip|where to get|find a copy|piracy)\b'
    Assert-That ($r.Message -notmatch $forbidden) 'guidance never says where/how to obtain game files'
    [System.IO.File]::WriteAllBytes((Join-Path $g 'mkw.rvz'), (New-Object byte[] 10))
    $r = Find-GameFiles $g
    Assert-That ($r.Ok -and $r.Kind -eq 'image' -and $r.Input -like '*mkw.rvz') 'one .rvz is accepted'
    Assert-That (-not $r.RetroRoot) 'no Retro Rewind by default'
    [System.IO.File]::WriteAllBytes((Join-Path $g 'other.ISO'), (New-Object byte[] 10))
    $r = Find-GameFiles $g
    Assert-That ((-not $r.Ok) -and $r.Message -match 'exactly one' -and $r.Message -match 'move all but one') 'two images: says what to do'
    Remove-Item -LiteralPath (Join-Path $g 'other.ISO')
    New-Item -ItemType Directory -Force -Path (Join-Path $g 'RetroRewind6/Binaries') | Out-Null
    [System.IO.File]::WriteAllBytes((Join-Path $g 'RetroRewind6/Binaries/Code.pul'), (New-Object byte[] 4))
    $r = Find-GameFiles $g
    Assert-That ($r.Ok -and $r.RetroRoot -like '*RetroRewind6') 'RetroRewind6 folder is found'
    New-Item -ItemType Directory -Force -Path (Join-Path $g 'more/RetroRewind6/Binaries') | Out-Null
    [System.IO.File]::WriteAllBytes((Join-Path $g 'more/RetroRewind6/Binaries/Code.pul'), (New-Object byte[] 4))
    $r = Find-GameFiles $g
    Assert-That ((-not $r.Ok) -and $r.Message -match 'Retro Rewind') 'two Retro Rewind folders: refused'
    Remove-Item -LiteralPath (Join-Path $g 'more') -Recurse -Force
    New-Item -ItemType Directory -Force -Path (Join-Path $g 'DATA/sys') | Out-Null
    [System.IO.File]::WriteAllBytes((Join-Path $g 'DATA/sys/main.dol'), (New-Object byte[] 4))
    $r = Find-GameFiles $g
    Assert-That ((-not $r.Ok) -and $r.Message -match 'both a disc image and an extracted') 'image + tree: refused'
    Remove-Item -LiteralPath (Join-Path $g 'mkw.rvz')
    $r = Find-GameFiles $g
    Assert-That ($r.Ok -and $r.Kind -eq 'tree') 'extracted DATA tree (one level down) is accepted'

    Write-Host '== helpers'
    Assert-That ((ConvertTo-ArgString @('a b', 'c', '', 'd"e', 'f\')) -eq '"a b" c "" "d\"e" f\') 'argument quoting (spaces, empty, quote, trailing backslash)'
    Assert-That ((ConvertTo-ArgString @('C:\x y\')) -eq '"C:\x y\\"') 'trailing backslash inside quotes is doubled'
    Assert-That ((Get-LikelyFix 'main.dol sha256 mismatch: expected') -match 'PAL') 'fix hint: wrong disc'
    Assert-That ((Get-LikelyFix 'certificate signer not trusted') -match 'github.com') 'fix hint: TLS'
    Assert-That ((Get-LikelyFix 'ninja: error: No space left on device') -match 'disk is full') 'fix hint: disk'
    Assert-That ((Get-LikelyFix 'weird') -match 'again') 'fix hint: default'
    Assert-That (Test-PortFree 18799) 'free port detected'
    Assert-That (-not (Test-PortFree $Port)) 'busy port detected'

    $psExe = (Get-Process -Id $PID).Path
    $seen = New-Object System.Collections.Generic.List[string]
    $code = Invoke-Logged -Exe $psExe -Arguments @('-NoProfile', '-Command', '[Console]::Out.WriteLine("out 1"); [Console]::Error.WriteLine("err 1"); [Console]::Out.WriteLine("out 2"); exit 3') -OnLine { param([string]$l) $seen.Add($l) }
    Assert-That ($code -eq 3) 'Invoke-Logged returns the exit code'
    Assert-That (($seen -contains 'out 1') -and ($seen -contains 'err 1') -and ($seen -contains 'out 2')) 'stdout and stderr lines both arrive'
    Assert-That ((Get-LogText) -match 'err 1') 'child output is written to the log'

    Write-Host '== source fingerprint'
    $fake = Join-Path $work 'fakerepo'
    foreach ($d in 'translator/src/bin/Release', 'runtime', 'aurora-main', 'projects', 'web/build', 'web/dist', 'web/game') { New-Item -ItemType Directory -Force -Path (Join-Path $fake $d) | Out-Null }
    [System.IO.File]::WriteAllText((Join-Path $fake 'runtime/a.cpp'), 'int a;')
    $f1 = Get-SourceFingerprint $fake
    Assert-That ($f1 -match '^src-[0-9a-f]{64}$') 'fingerprint has the expected shape'
    [System.IO.File]::WriteAllText((Join-Path $fake 'web/build/junk.o'), 'x')
    [System.IO.File]::WriteAllText((Join-Path $fake 'web/dist/index.html'), 'x')
    [System.IO.File]::WriteAllText((Join-Path $fake 'web/game/mkw.iso'), 'x')
    [System.IO.File]::WriteAllText((Join-Path $fake 'translator/src/bin/Release/x.dll'), 'x')
    Assert-That ((Get-SourceFingerprint $fake) -eq $f1) 'build output, dist, game files and bin/obj do not change it'
    [System.IO.File]::WriteAllText((Join-Path $fake 'runtime/a.cpp'), 'int b;')
    Assert-That ((Get-SourceFingerprint $fake) -ne $f1) 'a source edit changes it'

    Close-Log

    Write-Host '== build-windows.ps1 end to end (stubbed host.ps1, fake lock)'
    # fake lock: one zip tool, one single-file tool, no emsdk
    $lockObj = [ordered]@{
        schema = 1; emscripten = '0'; dotnetSdk = '0'
        tools = @(
            [ordered]@{ id = 'ziptool'; title = 'Zip tool'; kind = 'zip'; url = "$base/tool.zip"; file = 'tool.zip'; sha256 = $zipSha256; innerDir = 'inner-1.0'; dest = 'ziptool'; marker = 'bin/tool.txt' },
            [ordered]@{ id = 'filetool'; title = 'File tool'; kind = 'file'; url = "$base/blob.bin"; file = 'blob.bin'; sha256 = $blobSha256; dest = 'filetool'; name = 'f.bin'; marker = 'f.bin' }
        )
    }
    $lockFile = Join-Path $work 'fake.lock.json'
    [System.IO.File]::WriteAllText($lockFile, ($lockObj | ConvertTo-Json -Depth 6))
    $emptyGame = Join-Path $work 'emptygame'
    New-Item -ItemType Directory -Force -Path $emptyGame | Out-Null
    $okGame = Join-Path $work 'okgame'
    New-Item -ItemType Directory -Force -Path $okGame | Out-Null
    [System.IO.File]::WriteAllBytes((Join-Path $okGame 'fake.rvz'), (New-Object byte[] 64))
    $tools2 = Join-Path $work 'tools2'
    $dist2 = Join-Path $work 'dist2'
    $main = Join-Path $winDir 'build-windows.ps1'

    $fakeHost = Join-Path $work 'fake-host.ps1'
    [System.IO.File]::WriteAllText($fakeHost, @'
param([string]$Game, [switch]$BuildOnly, [switch]$Rebuild, [int]$Jobs, [string]$Out)
if ($env:FAKE_HOST_MODE -eq 'uptodate') {
    Write-Host 'web/dist is up to date for these game files and this version; skipping the build.'
    exit 0
}
Write-Host 'Game files:'
Write-Host "    base game:     $Game (image)"
Write-Host '==> [1] Checking prerequisites'
Write-Host '    Emscripten 6.0.12'
Write-Host '==> [2] Extracting the disc image'
Write-Host '==> [3] Translating the base game (about a minute, 8+ GB of RAM recommended)'
Write-Host '==> [4] Configuring the WebAssembly build (emcmake)'
Write-Host '==> [5] Compiling WiiCompiled to WebAssembly (this is the long step)'
1..20 | ForEach-Object { Write-Host ('[{0}/20] Building CXX object foo{0}.o' -f $_) }
if ($env:FAKE_HOST_MODE -eq 'fail') {
    [Console]::Error.WriteLine('ninja: error: write error: No space left on device')
    exit 1
}
Write-Host '==> [6] Assembling the site'
New-Item -ItemType Directory -Force -Path $Out | Out-Null
Set-Content -LiteralPath (Join-Path $Out 'index.html') -Value '<html>fake</html>'
exit 0
'@)

    function Invoke-Main-Script {
        param([string[]]$MainArgs, [hashtable]$EnvVars = @{})
        $out = Join-Path $work ('run-' + [guid]::NewGuid().ToString('N').Substring(0, 6) + '.txt')
        foreach ($k in $EnvVars.Keys) { [System.Environment]::SetEnvironmentVariable($k, $EnvVars[$k], 'Process') }
        $args2 = @('-NoProfile', '-File', $main) + $MainArgs
        $text = & $psExe @args2 2>&1 | Out-String
        $code = $LASTEXITCODE
        foreach ($k in $EnvVars.Keys) { [System.Environment]::SetEnvironmentVariable($k, $null, 'Process') }
        return [pscustomobject]@{ Code = $code; Text = $text }
    }

    $common = @('--lock', $lockFile, '--tools-dir', $tools2, '--no-open-folder', '--dist', $dist2, '--host-script', $fakeHost)

    $res = Invoke-Main-Script ($common + @('--game', $emptyGame))
    Assert-That ($res.Code -eq 2) 'no game file: exit code 2 (needs user action)' "code=$($res.Code)"
    Assert-That ($res.Text -match 'Step 1/7: checking your game files' -and $res.Text -match 'No game file found') 'no game file: step 1 explains what to do'
    Assert-That ($res.Text -notmatch 'Step 2/7') 'no game file: nothing is downloaded before the game is found'

    $res = Invoke-Main-Script ($common + @('--game', $okGame, '--tools-only'))
    Assert-That ($res.Code -eq 0) 'tools-only run succeeds' "code=$($res.Code) $($res.Text)"
    Assert-That ($res.Text -match 'Step 2/7: getting the build tools' -and $res.Text -match 'Step 3/7') 'tool steps are announced'
    Assert-That ((Test-Path (Join-Path $tools2 'ziptool/bin/tool.txt')) -and (Test-Path (Join-Path $tools2 'filetool/f.bin'))) 'tools are installed under the tools dir'

    $res = Invoke-Main-Script ($common + @('--game', $okGame, '--tools-only'))
    Assert-That ($res.Text -match 'Step 2/7: build tools \(already installed\)') 'second run: tools already installed, no downloads' $res.Text

    $res = Invoke-Main-Script ($common + @('--game', $okGame, '--no-serve'))
    Assert-That ($res.Code -eq 0) 'build run (stubbed host) succeeds' "code=$($res.Code) $($res.Text)"
    foreach ($n in 4, 5, 6) { Assert-That ($res.Text -match "Step $n/7") "step $n announced" }
    Assert-That ($res.Text -match 'Step 5/7: compiling the game - about 20 minutes, the first time only') 'step 5 carries the time warning'
    Assert-That ($res.Text -match 'compiling: 20 of 20 files \(100%\)') 'compile progress is condensed'
    Assert-That ($res.Text -notmatch 'Building CXX object foo7') 'raw compiler lines stay out of the console'
    $logText = [System.IO.File]::ReadAllText((Join-Path $repo 'web/build/build.log'))
    Assert-That ($logText -match 'Building CXX object foo7.o') 'but they are in web/build/build.log'
    Assert-That (Test-Path (Join-Path $dist2 'index.html')) 'dist was assembled by the (stub) host'

    $res = Invoke-Main-Script ($common + @('--game', $okGame, '--no-serve')) @{ FAKE_HOST_MODE = 'uptodate' }
    Assert-That ($res.Text -match 'nothing to rebuild' -and $res.Text -notmatch 'Step 5/7') 'up to date: steps 4-6 are skipped with a message'

    $res = Invoke-Main-Script ($common + @('--game', $okGame, '--no-serve')) @{ FAKE_HOST_MODE = 'fail' }
    Assert-That ($res.Code -eq 1) 'failed build: exit code 1'
    Assert-That ($res.Text -match 'STOPPED' -and $res.Text -match 'disk is full' -and $res.Text -match 'build\.log') 'failed build: message, likely fix and log path'

    # serve: start the real serve.py (system python3 stands in for tools\python) and fetch the page
    $servePort = $Port + 1
    $outFile = Join-Path $work 'serve-run.txt'
    $env:FAKE_HOST_MODE = 'uptodate'
    $mainProc = Start-Process -FilePath $psExe -ArgumentList (ConvertTo-ArgString (@('-NoProfile', '-File', $main) + $common + @('--game', $okGame, '--no-browser', '--port', "$servePort", '--python', (Get-Command python3).Source))) -PassThru -RedirectStandardOutput $outFile -RedirectStandardError (Join-Path $work 'serve-run.err')
    Remove-Item Env:FAKE_HOST_MODE
    $got = ''
    for ($i = 0; $i -lt 60 -and -not $got; $i++) {
        Start-Sleep -Milliseconds 500
        try { $got = (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$servePort/").Content } catch { }
    }
    Assert-That ($got -match 'fake') 'step 7: the site is served on 127.0.0.1 after the build'
    $shown = if (Test-Path $outFile) { [System.IO.File]::ReadAllText($outFile) } else { '' }
    Assert-That ($shown -match "http://localhost:$servePort/" -and $shown -match 'Step 7/7') 'step 7: the URL is printed'
    try { Stop-Process -Id $mainProc.Id -Force } catch { }
    Get-Process -Name python3 -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $server.Id } | ForEach-Object { try { Stop-Process -Id $_.Id -Force } catch { } }
}
finally {
    Close-Log
    try { Stop-Process -Id $server.Id -Force } catch { }
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host ("{0} passed, {1} failed" -f $script:Pass, $script:Fail)
if ($script:Fail -gt 0) { exit 1 }
exit 0
