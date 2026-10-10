# Static check that the Windows build scripts only use what Windows PowerShell 5.1 understands.
#
# Windows PowerShell 5.1 does not exist on Linux, so the build scripts (which a stock Windows PC runs
# with 5.1) are checked here with the PowerShell 7 parser: first that they parse, then that no node of
# the syntax tree or call uses a PowerShell 6/7-only feature, a .NET-Core-only API, or a non-ASCII byte
# (5.1 reads a BOM-less script in the ANSI code page). Add `# ps51-ok: reason` to a line that is
# deliberately guarded (for example inside try/catch) to silence it.
#
# Run:  pwsh web/windows/tests/Test-Ps51Compat.ps1            (lint the real scripts, then self-test)
#       pwsh web/windows/tests/Test-Ps51Compat.ps1 -Files a.ps1,b.ps1
#
# Exit code 0 = clean.
param(
    [string[]]$Files,
    [switch]$SkipSelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))

$BadVariables = @('IsWindows', 'IsLinux', 'IsMacOS', 'IsCoreCLR', 'PSStyle', 'PSNativeCommandUseErrorActionPreference', 'PSNativeCommandArgumentPassing')
$BadParameters = @{
    'foreach-object' = @('parallel', 'throttlelimit', 'timeoutseconds')
    'convertfrom-json' = @('ashashtable', 'noenumerate', 'depth', 'dateKind')
    'convertto-json' = @('enumsasstrings', 'escapehandling')
    'join-path' = @('additionalchildpath')
    'get-content' = @('asbytestream')
    'set-content' = @('asbytestream')
    'add-content' = @('asbytestream')
    'out-file' = @()
    'invoke-webrequest' = @('skipcertificatecheck', 'skiphttperrorcheck', 'resume', 'allowunencryptedauthentication', 'sslprotocol', 'authentication', 'form', 'token', 'maximumretrycount', 'retryintervalsec', 'preserveauthorizationonredirect', 'skipheadervalidation', 'noproxy')
    'invoke-restmethod' = @('skipcertificatecheck', 'skiphttperrorcheck', 'resume', 'allowunencryptedauthentication', 'sslprotocol', 'authentication', 'form', 'token', 'maximumretrycount', 'retryintervalsec', 'responseheadersvariable', 'statuscodevariable', 'noproxy')
    'select-string' = @('noemphasis')
    'start-process' = @('environment')
    'split-path' = @('leafbase', 'extension')
    'get-date' = @('asutc')
    'new-item' = @()
    'get-childitem' = @()
    'remove-item' = @()
    'test-path' = @('olderthan', 'newerthan')
    'sort-object' = @()
    'get-command' = @('fuzzymatch')
    'write-host' = @()
}
$BadCmdlets = @('test-json', 'get-error', 'invoke-expression-x', 'convertfrom-markdown', 'show-markdown', 'get-uptime', 'remove-alias-x', 'join-string', 'new-temporaryfile-x', 'clear-host-x')
$BadEncodings = @('utf8nobom', 'utf8bom', 'oem', 'ansi')
# Static .NET members that exist only in .NET Core / .NET 5+ (not in .NET Framework 4.x).
$BadStatics = @(
    'Path::Join', 'Path::GetRelativePath', 'Path::TrimEndingDirectorySeparator', 'Path::Exists', 'Path::EndsInDirectorySeparator',
    'Convert::ToHexString', 'Convert::FromHexString', 'Convert::ToHexStringLower',
    'Math::Clamp', 'Math::ScaleB', 'Math::BigMul',
    'Environment::ProcessId', 'Environment::ProcessPath', 'Environment::CpuUsage',
    'GC::GetGCMemoryInfo', 'GC::GetTotalAllocatedBytes',
    'SHA256::HashData', 'SHA1::HashData', 'SHA512::HashData', 'MD5::HashData',
    'RandomNumberGenerator::GetBytes', 'RandomNumberGenerator::GetInt32',
    'OperatingSystem::IsWindows', 'OperatingSystem::IsLinux', 'OperatingSystem::IsMacOS',
    'File::ReadAllBytesAsync', 'File::ReadAllTextAsync', 'File::WriteAllTextAsync', 'File::WriteAllBytesAsync', 'File::Move3', 'File::AppendAllTextAsync',
    'Directory::CreateSymbolicLink', 'File::CreateSymbolicLink', 'File::SetUnixFileMode',
    'Process::Start3', 'Stopwatch::GetElapsedTime', 'Thread::Sleep0',
    'String::Concat0', 'Enum::GetValuesAsUnderlyingType', 'RuntimeInformation::FrameworkDescription0'
)

function Test-Ps51Source {
    param([string]$Text, [string]$Name)
    $findings = New-Object System.Collections.Generic.List[string]
    $lines = $Text -split "`r?`n"
    function Add-Finding([int]$Line, [string]$Message) {
        if ($Line -ge 1 -and $Line -le $lines.Count -and $lines[$Line - 1] -match '#\s*ps51-ok') { return }
        $findings.Add(('{0}:{1}: {2}' -f $Name, $Line, $Message))
    }

    # Non-ASCII.
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '[^\x00-\x7F]') { $findings.Add(('{0}:{1}: non-ASCII character (Windows PowerShell 5.1 reads a BOM-less file as ANSI)' -f $Name, ($i + 1))) }
    }

    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($Text, [ref]$tokens, [ref]$errors)
    foreach ($e in @($errors)) { $findings.Add(('{0}:{1}: PARSE ERROR: {2}' -f $Name, $e.Extent.StartLineNumber, $e.Message)) }

    # #requires
    $req = $ast.ScriptRequirements
    if ($null -ne $req -and $null -ne $req.RequiredPSVersion -and $req.RequiredPSVersion -gt [version]'5.1') {
        $findings.Add(('{0}:1: #requires -Version {1} (must be 5.1 or lower)' -f $Name, $req.RequiredPSVersion))
    }

    # Tokens: operators that do not exist in 5.1.
    foreach ($t in @($tokens)) {
        $kind = $t.Kind.ToString()
        if ($kind -in @('QuestionQuestion', 'QuestionQuestionEquals', 'QuestionDot', 'QuestionLBracket', 'AndAnd', 'OrOr', 'Question')) {
            Add-Finding $t.Extent.StartLineNumber ("operator '{0}' ({1}) is PowerShell 7 only" -f $t.Text, $kind)
        }
    }

    $nodes = $ast.FindAll({ param($n) $true }, $true)
    foreach ($n in $nodes) {
        $typeName = $n.GetType().Name
        $line = $n.Extent.StartLineNumber
        switch ($typeName) {
            'TernaryExpressionAst' { Add-Finding $line 'ternary operator ?: is PowerShell 7 only' }
            'PipelineChainAst' { Add-Finding $line 'pipeline chain operator (&& or ||) is PowerShell 7 only' }
            'VariableExpressionAst' {
                $v = $n.VariablePath.UserPath
                if ($BadVariables -contains $v) { Add-Finding $line ('$' + $v + ' does not exist in Windows PowerShell 5.1 (under strict mode it is an error)') }
            }
            'MemberExpressionAst' {
                if ($n.PSObject.Properties['NullConditional'] -and $n.NullConditional) { Add-Finding $line 'null-conditional member access is PowerShell 7 only' }
            }
            'InvokeMemberExpressionAst' {
                if ($n.PSObject.Properties['NullConditional'] -and $n.NullConditional) { Add-Finding $line 'null-conditional method call is PowerShell 7 only' }
                if ($n.Static -and $n.Expression -is [System.Management.Automation.Language.TypeExpressionAst]) {
                    $tn = $n.Expression.TypeName.Name
                    $short = ($tn -split '\.')[-1]
                    $mem = $n.Member.Extent.Text
                    $key = $short + '::' + $mem
                    $argc = @($n.Arguments).Count
                    if ($BadStatics -contains $key) { Add-Finding $line ('[{0}]::{1} is .NET Core only' -f $tn, $mem) }
                    if ($key -eq 'Path::GetFullPath' -and $argc -ne 1) { Add-Finding $line '[Path]::GetFullPath with a base path argument is .NET Core only' }
                    if ($key -eq 'File::Move' -and $argc -ne 2) { Add-Finding $line '[File]::Move with an overwrite argument is .NET Core only' }
                    if ($key -eq 'Path::Combine' -and $argc -gt 4) { Add-Finding $line '[Path]::Combine with more than 4 parts is .NET Core only' }
                }
                if (-not $n.Static) {
                    $mem = $n.Member.Extent.Text
                    $argc = @($n.Arguments).Count
                    if ($mem -eq 'Replace' -and $argc -ge 3) { Add-Finding $line 'String.Replace with a comparison argument is .NET Core only' }
                    if ($mem -eq 'Split' -and $argc -ge 2 -and $n.Arguments[1] -is [System.Management.Automation.Language.StringConstantExpressionAst]) { Add-Finding $line 'String.Split(string, ...) overloads are .NET Core only' }
                    if ($mem -eq 'Contains' -and $argc -ge 2) { Add-Finding $line 'String.Contains with a comparison argument is .NET Core only' }
                    if ($mem -in @('GetValueOrDefault', 'TryAdd', 'ToHashSet')) { Add-Finding $line ('.{0}() is not available on .NET Framework collections' -f $mem) }
                }
            }
            'IndexExpressionAst' {
                if ($n.PSObject.Properties['NullConditional'] -and $n.NullConditional) { Add-Finding $line 'null-conditional index is PowerShell 7 only' }
            }
            'CommandAst' {
                $cmdName = $n.GetCommandName()
                if (-not $cmdName) { continue }
                $c = $cmdName.ToLowerInvariant()
                if ($BadCmdlets -contains $c) { Add-Finding $line ("cmdlet '{0}' does not exist in Windows PowerShell 5.1" -f $cmdName) }
                $params = @($n.CommandElements | Where-Object { $_ -is [System.Management.Automation.Language.CommandParameterAst] })
                foreach ($p in $params) {
                    $pn = $p.ParameterName.ToLowerInvariant()
                    if ($BadParameters.ContainsKey($c) -and ($BadParameters[$c] | Where-Object { $pn -eq $_.ToLowerInvariant() })) {
                        Add-Finding $line ("'{0} -{1}' is PowerShell 6/7 only" -f $cmdName, $p.ParameterName)
                    }
                    if ($pn -eq 'encoding') {
                        $val = $null
                        if ($p.Argument) { $val = $p.Argument.Extent.Text } else {
                            $idx = [array]::IndexOf(@($n.CommandElements), $p)
                            if ($idx -ge 0 -and $idx + 1 -lt @($n.CommandElements).Count) { $val = @($n.CommandElements)[$idx + 1].Extent.Text }
                        }
                        if ($val) {
                            $vv = $val.Trim('"', "'").ToLowerInvariant()
                            if ($BadEncodings -contains $vv) { Add-Finding $line ("-Encoding {0} is not valid in Windows PowerShell 5.1" -f $val) }
                        }
                    }
                }
                if ($c -in @('invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm')) {
                    $hasBasic = @($params | Where-Object { $_.ParameterName -like 'UseBasic*' }).Count -gt 0
                    if ($c -in @('invoke-webrequest', 'iwr') -and -not $hasBasic) { Add-Finding $line 'Invoke-WebRequest without -UseBasicParsing needs the Internet Explorer engine on 5.1' }
                }
                if ($c -eq 'join-path') {
                    # count positional (non-parameter) elements after the command name
                    $elements = @($n.CommandElements)
                    $positional = 0
                    $skip = $false
                    for ($k = 1; $k -lt $elements.Count; $k++) {
                        $el = $elements[$k]
                        if ($skip) { $skip = $false; continue }
                        if ($el -is [System.Management.Automation.Language.CommandParameterAst]) {
                            if (-not $el.Argument -and $el.ParameterName -notin @('Resolve')) { $skip = $true }
                            continue
                        }
                        $positional++
                    }
                    if ($positional -gt 2) { Add-Finding $line 'Join-Path with more than 2 positional arguments (-AdditionalChildPath) is PowerShell 6+ only' }
                }
            }
        }
    }
    return $findings.ToArray()
}

# ---------------------------------------------------------------------------
# Self test: each snippet must produce at least one finding; the good snippet none.
# ---------------------------------------------------------------------------
function Invoke-SelfTest {
    $bad = [ordered]@{
        'null-coalescing'   = '$a = $b ?? 1'
        'null-cond-assign'  = '$a ??= 1'
        'null-cond-member'  = '${a}?.Length'
        'ternary'           = '$x = $true ? 1 : 2'
        'and-and'           = 'Get-Date && Get-Date'
        'or-or'             = 'Get-Date || Get-Date'
        'as-hashtable'      = '"{}" | ConvertFrom-Json -AsHashtable'
        'parallel'          = '1..3 | ForEach-Object -Parallel { $_ }'
        'join-path-3'       = 'Join-Path "a" "b" "c"'
        'join-path-extra'   = 'Join-Path "a" "b" -AdditionalChildPath "c"'
        'iswindows'         = 'if ($IsWindows) { 1 }'
        'getfullpath-2'     = '[System.IO.Path]::GetFullPath("a", "b")'
        'path-join'         = '[System.IO.Path]::Join("a", "b")'
        'tohexstring'       = '[Convert]::ToHexString([byte[]]@(1))'
        'gc-memory'         = '[System.GC]::GetGCMemoryInfo()'
        'utf8nobom'         = 'Set-Content -Path a -Value b -Encoding utf8NoBOM'
        'iwr-no-basic'      = 'Invoke-WebRequest -Uri http://x -OutFile y'
        'iwr-skipcert'      = 'Invoke-WebRequest -UseBasicParsing -Uri http://x -SkipCertificateCheck'
        'requires-7'        = "#requires -Version 7.0`n1"
        'non-ascii'         = ('$a = "caf' + [char]0xE9 + '"')
        'parse-error'       = 'if ($true) {'
        'asbytestream'      = 'Get-Content -Path a -AsByteStream'
        'split-path-leafbase' = 'Split-Path -Path a -LeafBase'
        'math-clamp'        = '[Math]::Clamp(5, 1, 3)'
    }
    $good = @'
Set-StrictMode -Version Latest
$a = Join-Path (Join-Path 'a' 'b') 'c'
$full = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine('a', 'b'))
$x = if ($true) { 1 } else { 2 }
try { $m = [System.GC]::GetGCMemoryInfo() } catch { }   # ps51-ok: guarded
$j = '{"a":1}' | ConvertFrom-Json
Invoke-WebRequest -UseBasicParsing -Uri 'http://example.invalid/' -OutFile 'x'
Set-Content -LiteralPath 'a' -Value 'b' -Encoding UTF8
'@
    $ok = $true
    foreach ($k in $bad.Keys) {
        $r = @(Test-Ps51Source $bad[$k] "selftest:$k")
        if ($r.Count -eq 0) { Write-Host "SELFTEST FAIL: '$k' was not flagged" -ForegroundColor Red; $ok = $false }
    }
    $r = @(Test-Ps51Source $good 'selftest:good')
    if ($r.Count -ne 0) { Write-Host 'SELFTEST FAIL: the good snippet was flagged:' -ForegroundColor Red; $r | ForEach-Object { Write-Host "  $_" }; $ok = $false }
    if ($ok) { Write-Host ('self-test OK ({0} bad snippets flagged, good snippet clean)' -f $bad.Count) -ForegroundColor Green }
    return $ok
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
if (-not $Files) {
    $Files = @(
        (Join-Path (Join-Path $repo 'web') 'build.ps1'),
        (Join-Path (Join-Path $repo 'web') 'host.ps1'),
        (Join-Path (Join-Path (Join-Path $repo 'web') 'windows') 'build-windows.ps1'),
        (Join-Path (Join-Path (Join-Path $repo 'web') 'windows') 'mkw-lib.ps1')
    )
}

$failed = $false
if (-not $SkipSelfTest) { if (-not (Invoke-SelfTest)) { $failed = $true } }
foreach ($f in $Files) {
    $text = [System.IO.File]::ReadAllText($f)
    $found = @(Test-Ps51Source $text (Split-Path -Leaf $f))
    if ($found.Count -eq 0) {
        Write-Host ('OK    {0}' -f $f) -ForegroundColor Green
    } else {
        $failed = $true
        Write-Host ('FAIL  {0}' -f $f) -ForegroundColor Red
        $found | ForEach-Object { Write-Host ('      ' + $_) }
    }
}
if ($failed) { exit 1 }
exit 0
