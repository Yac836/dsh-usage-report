#Requires -Version 7.2
# Tests import function declarations only. No real DSH process is queried or stopped.
$ErrorActionPreference = 'Stop'
$taskErrors = $null; $taskTokens = $null
$taskScript = Join-Path $PSScriptRoot '..\sync-deploy.ps1'
$taskAst = [Management.Automation.Language.Parser]::ParseFile($taskScript, [ref]$taskTokens, [ref]$taskErrors)
if ($taskErrors.Count) { throw 'PowerShell source must parse.' }
foreach ($taskFunction in $taskAst.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
    . ([scriptblock]::Create($taskFunction.Extent.Text))
}

$taskAssertions = 0
function Assert([bool]$Value, [string]$Label) { if (-not $Value) { throw "Assertion failed: $Label" }; $script:taskAssertions++ }
function Refuses([scriptblock]$Action, [string]$Label) {
    $taskRejected = $false
    try { & $Action | Out-Null } catch { $taskRejected = $true }
    Assert $taskRejected $Label
}

$taskTempBase = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'codex-temp'
$taskFixture = Join-Path $taskTempBase ('dsh-ps-test-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($taskFixture) | Out-Null
try {
    $taskRoot = $taskFixture
    $taskNode = (Get-Command node -CommandType Application | Select-Object -First 1).Source
    $taskSafeFailure = $null
    Refuses { Invoke-Quiet $taskNode @('-e', 'console.error("fixture diagnostic text");process.exit(1)') 'known_failure' } 'failed external commands are rejected'
    Assert ($taskSafeFailure -eq 'known_failure') 'raw command diagnostics are not used as the failure message'

    $taskPrivate = Join-Path $taskFixture 'private'
    New-PrivateDirectory $taskPrivate
    $taskAcl = Get-Acl -LiteralPath $taskPrivate
    $taskSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    Assert $taskAcl.AreAccessRulesProtected 'backup ACL disables inherited access'
    Assert (@($taskAcl.Access).Count -eq 1) 'backup ACL has a single rule'
    Assert ($taskAcl.Access[0].IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $taskSid) 'backup is restricted to the current user'

    $taskPkg = Join-Path $taskFixture 'node_modules\@deepseek-ai\dsh'
    [IO.Directory]::CreateDirectory((Join-Path $taskPkg 'lib')) | Out-Null
    Set-Content -LiteralPath (Join-Path $taskPkg 'package.json') -Value '{"name":"@deepseek-ai/dsh","version":"0.2.0-rc.2"}'
    $taskEntry = Join-Path $taskPkg 'lib\bin.js'
    Set-Content -LiteralPath $taskEntry -Value '// fixture only'
    $DshHome = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh'
    $Profile = 'web'; $Port = 3080; $NoRestart = $false
    $taskFakeListeners = @([pscustomobject]@{ OwningProcess = 12345; LocalAddress = '127.0.0.1'; LocalPort = $Port })
    $taskFakeProcess = [pscustomobject]@{ ProcessId = 12345; Name = 'node.exe'; ExecutablePath = $taskNode; CommandLine = ('"{0}" "{1}" web' -f $taskNode, $taskEntry); CreationDate = [DateTime]::UtcNow }
    $taskStopCount = 0
    function Get-NetTCPConnection { [CmdletBinding()]param($State, $LocalPort) return $script:taskFakeListeners }
    $taskFakeDesktop = @()
    function Get-CimInstance { [CmdletBinding()]param($ClassName, $Filter) if ($Filter -eq "Name='DeepSeek Harness.exe'") { return $script:taskFakeDesktop }; return $script:taskFakeProcess }
    $taskFakeOwner = $taskSid
    function Invoke-CimMethod { [CmdletBinding()]param($InputObject, $MethodName) return [pscustomobject]@{ ReturnValue = 0; Sid = $script:taskFakeOwner } }
    function Stop-Process { [CmdletBinding()]param($Id) $script:taskStopCount++; $script:taskFakeListeners = @() }
    function Wait-Process { [CmdletBinding()]param($Id, $Timeout) }
    $taskSpec = Get-DefaultWebProcess
    Assert ($taskSpec.Pid -eq 12345 -and $taskSpec.Entry -eq $taskEntry) 'only the verified plain web invocation is selected'
    $taskFakeProcess.CommandLine = ('"{0}" {1} web' -f $taskNode, $taskEntry)
    Assert ((Get-DefaultWebProcess).Entry -eq $taskEntry) 'unquoted entry paths emitted by the background launcher are recognized'
    $taskFakeProcess.CommandLine = $taskSpec.Command
    $taskFakeOwner = 'S-1-0-0'
    Refuses { Get-DefaultWebProcess } 'another Windows user cannot be restarted'
    $taskFakeOwner = $taskSid

    $taskFakeListeners[0].LocalAddress = '0.0.0.0'
    Refuses { Get-DefaultWebProcess } 'public bind is refused'
    $taskFakeListeners[0].LocalAddress = '127.0.0.1'
    $taskFakeListeners += [pscustomobject]@{ OwningProcess = 23456; LocalAddress = '::1'; LocalPort = $Port }
    Refuses { Get-DefaultWebProcess } 'multiple port owners are refused'
    $taskFakeListeners = @($taskFakeListeners[0])
    $NoRestart = $true
    Refuses { Get-DefaultWebProcess } 'NoRestart requires the target port to be closed'
    $NoRestart = $false
    $Profile = 'desktop'
    Refuses { Get-DefaultWebProcess } 'desktop profile is refused for automatic restart'
    Refuses { Get-TargetProcess } 'desktop deployment explicitly requires NoRestart'
    $NoRestart = $true
    Assert ($null -eq (Get-TargetProcess)) 'a closed Desktop does not conflict with a separate Web listener'
    $taskFakeDesktop = @([pscustomobject]@{ ProcessId = 45678 })
    Refuses { Get-TargetProcess } 'running Desktop is refused regardless of its random HTTP port'
    Assert ($taskStopCount -eq 0) 'Desktop guards never stop an app or the separate Web host'
    $taskFakeDesktop = @(); $NoRestart = $false
    $Profile = 'web'
    $taskCommand = $taskFakeProcess.CommandLine
    $taskFakeProcess.CommandLine += ' --patch custom.yml'
    Refuses { Get-DefaultWebProcess } 'custom launcher flags are refused'
    $taskFakeProcess.CommandLine = $taskCommand
    $taskFakeProcess.CreationDate = $taskFakeProcess.CreationDate.AddSeconds(1)
    Refuses { Stop-VerifiedHost $taskSpec } 'PID reuse or a replacement process is refused'
    Assert ($taskStopCount -eq 0) 'rejected hosts were never stopped'
    $taskFakeProcess.CreationDate = $taskSpec.Creation
    Stop-VerifiedHost $taskSpec
    Assert ($taskStopCount -eq 1 -and $taskStopped) 'only the selected host is stopped and recovery is armed'
    Assert ($null -eq (Get-DefaultWebProcess)) 'a closed listener returns no target'

    # Mock launch and HTTP readiness as well; no background process or network is created.
    function Invoke-Quiet { param($File, $Arguments, $Failure) Assert ($Arguments[1].Contains('stdio:"ignore"')) 'startup output is discarded'; return '34567' }
    function Get-Process { [CmdletBinding()]param($Id) return [pscustomobject]@{ Id = $Id } }
    function Invoke-WebRequest { [CmdletBinding()]param($Uri, [switch]$NoProxy, [switch]$SkipHttpErrorCheck, $TimeoutSec) Assert ($NoProxy -and $SkipHttpErrorCheck -and $Uri -eq 'http://127.0.0.1:3080/') 'readiness uses only local root and never credentials'; return [pscustomobject]@{ StatusCode = 401 } }
    $taskFakeListeners = @([pscustomobject]@{ OwningProcess = 34567; LocalAddress = '127.0.0.1'; LocalPort = $Port })
    Start-VerifiedHost $taskSpec
    Assert ($taskNewPid -eq 34567) 'the new verified PID owns the ready loopback listener'
    $taskFakeListeners[0].OwningProcess = 99999
    Refuses { Start-VerifiedHost $taskSpec } 'an unrelated new listener cannot pass readiness'
    Write-Host "PowerShell deployment checks passed: $taskAssertions assertions. All service operations were mocked."
} finally {
    $taskResolved = [IO.Path]::GetFullPath($taskFixture)
    $taskAllowed = [IO.Path]::GetFullPath($taskTempBase) + [IO.Path]::DirectorySeparatorChar
    if (-not $taskResolved.StartsWith($taskAllowed, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path $taskResolved -Leaf) -notmatch '^dsh-ps-test-[a-f0-9]{32}$') { throw 'Unsafe test cleanup path.' }
    Remove-Item -LiteralPath $taskResolved -Recurse -Force
}

# GitHub's pwsh wrapper propagates LASTEXITCODE from the intentional failed
# native-command fixture unless successful test completion is explicit.
exit 0
