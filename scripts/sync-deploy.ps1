#Requires -Version 7.2
[CmdletBinding(DefaultParameterSetName = 'Deploy')]
param(
    [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh' }),
    [ValidatePattern('^[a-zA-Z0-9_-]+$')][string]$Profile = 'web',
    [ValidateRange(1, 65535)][int]$Port = 3080,
    [string]$BackupRoot = $(Join-Path ([Environment]::GetFolderPath('UserProfile')) 'project-secrets\dsh-usage-report\deployments'),
    [Parameter(ParameterSetName = 'Deploy')][switch]$NoPull,
    [Parameter(ParameterSetName = 'Deploy')][switch]$CheckOnly,
    [switch]$NoRestart,
    [Parameter(Mandatory, ParameterSetName = 'Rollback')][ValidatePattern('^\d{8}T\d{6}-[a-f0-9]{8}$')][string]$Rollback
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskBackupRoot = [IO.Path]::GetFullPath($BackupRoot)
$taskStage = 'preflight'
$taskMutex = $null
$taskOwnsMutex = $false
$taskRestart = $null
$taskStopped = $false
$taskNewPid = $null
$taskNewCreation = $null
$taskBackup = $null
$taskActivated = $false
$taskBeforeMarker = $null
$taskTestDir = $null
$taskOldEnv = @{}
$taskSafeFailure = $null
$taskOriginalLocation = Get-Location

function Stop-Deployment([string]$Reason) {
    $script:taskSafeFailure = $Reason
    throw 'Deployment stopped.'
}

function Invoke-Quiet([string]$File, [string[]]$Arguments, [string]$Failure) {
    $taskSavedPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $taskOutput = @(& $File @Arguments 2>&1)
        $taskSucceeded = $?
        $taskExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $taskSavedPreference }
    if (-not $taskSucceeded -or $taskExit -ne 0) { Stop-Deployment $Failure }
    return ($taskOutput -join "`n").Trim()
}

function Invoke-Files([string]$Action, [string[]]$Extra = @()) {
    $taskSavedPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $taskOutput = @(& $taskNode (Join-Path $PSScriptRoot 'sync-deploy.mjs') $Action @Extra 2>&1)
        $taskSucceeded = $?
        $taskExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $taskSavedPreference }
    $taskJson = $taskOutput -join "`n"
    if (-not $taskSucceeded -or $taskExit -ne 0) {
        $taskIssue = 'deployment_check_failed'
        try { $taskCode = ($taskJson | ConvertFrom-Json).code; if ($taskCode -match '^[a-z_]{3,80}$') { $taskIssue = $taskCode } } catch { }
        Stop-Deployment "Plugin file check failed: $taskIssue. Installed files and backups were preserved."
    }
    return ($taskJson | ConvertFrom-Json)
}

function Assert-CleanRepo {
    $taskDirty = Invoke-Quiet $taskGit @('-C', $taskRoot, 'status', '--porcelain=v1', '--untracked-files=all') 'Cannot inspect repository status.'
    if ($taskDirty) { Stop-Deployment 'Repository has local changes. Commit or preserve them before updating; nothing will be discarded.' }
}

function New-PrivateDirectory([string]$Path) {
    $taskAt = [IO.Path]::GetFullPath($Path)
    if (Test-Path -LiteralPath $taskAt) { Stop-Deployment 'Backup directory already exists; it will not be overwritten.' }
    while ($taskAt) {
        if ((Test-Path -LiteralPath $taskAt) -and ((Get-Item -LiteralPath $taskAt -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            Stop-Deployment 'A linked backup path was refused.'
        }
        $taskAt = Split-Path -Parent $taskAt
    }
    [IO.Directory]::CreateDirectory($Path) | Out-Null
    $taskSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $taskAcl = [Security.AccessControl.DirectorySecurity]::new()
    $taskAcl.SetAccessRuleProtection($true, $false)
    $taskAcl.SetOwner($taskSid)
    $taskAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($taskSid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    Set-Acl -LiteralPath $Path -AclObject $taskAcl
}

function Get-DefaultWebProcess {
    $taskListeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -EQ $Port)
    if ($taskListeners.Count -eq 0) { return $null }
    if ($NoRestart) { Stop-Deployment 'DSH is listening. Close it first for -NoRestart, or allow the normal guarded restart.' }
    $taskExpectedHome = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh'
    if ($Profile -ne 'web' -or [IO.Path]::GetFullPath($DshHome) -ne [IO.Path]::GetFullPath($taskExpectedHome)) {
        Stop-Deployment 'Automatic restart supports the default home and web profile only. Close the custom host, then use -NoRestart.'
    }
    $taskOwners = @($taskListeners.OwningProcess | Sort-Object -Unique)
    if ($taskOwners.Count -ne 1 -or @($taskListeners | Where-Object LocalAddress -NotIn @('127.0.0.1', '::1')).Count) {
        Stop-Deployment 'Port owner or bind address is not the expected single loopback instance.'
    }
    $taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($taskOwners[0])"
    $taskOwner = Invoke-CimMethod -InputObject $taskProcess -MethodName GetOwnerSid -ErrorAction Stop
    if ($taskOwner.ReturnValue -ne 0 -or $taskOwner.Sid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) {
        Stop-Deployment 'Port owner is not the current Windows user.'
    }
    $taskMatch = [regex]::Match($taskProcess.CommandLine, '^\s*(?:"(?<exe>[^"]+)"|(?<exe>\S+))\s+(?:"(?<script>[^"]+)"|(?<script>\S+))\s+web\s*$')
    if ($taskProcess.Name -ne 'node.exe' -or -not $taskMatch.Success) { Stop-Deployment 'Running process is not a recognized plain dsh web command.' }
    $taskEntry = [IO.Path]::GetFullPath($taskMatch.Groups['script'].Value)
    if ($taskEntry -notmatch '[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js$' -or -not (Test-Path -LiteralPath $taskEntry -PathType Leaf)) {
        Stop-Deployment 'DSH entry point could not be verified.'
    }
    $taskPackage = Get-Content -LiteralPath (Join-Path (Split-Path (Split-Path $taskEntry)) 'package.json') -Raw | ConvertFrom-Json
    if ($taskPackage.name -ne '@deepseek-ai/dsh') { Stop-Deployment 'Unexpected DSH package.' }
    return [pscustomobject]@{ Pid = $taskProcess.ProcessId; Executable = $taskProcess.ExecutablePath; Entry = $taskEntry; Package = (Split-Path (Split-Path $taskEntry)); Creation = $taskProcess.CreationDate; Command = $taskProcess.CommandLine }
}

function Stop-VerifiedHost($Spec) {
    $taskCurrent = Get-CimInstance Win32_Process -Filter "ProcessId=$($Spec.Pid)"
    if (-not $taskCurrent -or $taskCurrent.CreationDate -ne $Spec.Creation -or $taskCurrent.CommandLine -ne $Spec.Command) {
        Stop-Deployment 'DSH process changed during deployment; refusing to stop it.'
    }
    Stop-Process -Id $Spec.Pid -ErrorAction Stop
    $script:taskStopped = $true
    Wait-Process -Id $Spec.Pid -Timeout 15 -ErrorAction SilentlyContinue
    if (Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -EQ $Port) { Stop-Deployment 'Port is still occupied after stopping the verified host.' }
}

function Start-VerifiedHost($Spec) {
    # Suppress host stdout/stderr: startup output can contain a browser login token.
    $taskLaunch = 'const{spawn}=require("node:child_process");const p=spawn(process.argv[1],[process.argv[2],"web"],{cwd:process.argv[3],detached:true,windowsHide:true,stdio:"ignore"});p.on("error",()=>process.exit(1));p.on("spawn",()=>{console.log(p.pid);p.unref()})'
    $taskLaunched = Invoke-Quiet $taskNode @('-e', $taskLaunch, $Spec.Executable, $Spec.Entry, $taskRoot) 'DSH launch failed.'
    $script:taskNewPid = [int]$taskLaunched
    $script:taskNewCreation = (Get-CimInstance Win32_Process -Filter "ProcessId=$script:taskNewPid").CreationDate
    if (-not $script:taskNewCreation) { Stop-Deployment 'DSH exited before its process identity could be recorded.' }
    for ($taskTry = 0; $taskTry -lt 40; $taskTry++) {
        if (-not (Get-Process -Id $script:taskNewPid -ErrorAction SilentlyContinue)) { Stop-Deployment 'DSH exited during startup.' }
        $taskReady = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -EQ $Port)
        if ($taskReady.Count) {
            if (@($taskReady | Where-Object { $_.OwningProcess -ne $script:taskNewPid -or $_.LocalAddress -notin @('127.0.0.1', '::1') }).Count) {
                Stop-Deployment 'Unexpected port owner or bind address after restart.'
            }
            $taskReply = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -NoProxy -SkipHttpErrorCheck -TimeoutSec 3
            if ([int]$taskReply.StatusCode -in @(200, 401)) { return }
        }
        Start-Sleep -Milliseconds 750
    }
    Stop-Deployment 'DSH did not become ready within the startup timeout.'
}

try {
    if (-not $IsWindows) { Stop-Deployment 'This entry point requires Windows and PowerShell 7.2+.' }
    $taskNode = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $taskGit = (Get-Command git -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    Set-Location -LiteralPath $taskRoot
    $taskTop = Invoke-Quiet $taskGit @('rev-parse', '--show-toplevel') 'This is not a Git checkout.'
    if ([IO.Path]::GetFullPath($taskTop) -ne [IO.Path]::GetFullPath($taskRoot)) { Stop-Deployment 'Script must run from its own checkout.' }
    $taskRemote = Invoke-Quiet $taskGit @('remote', 'get-url', 'origin') 'Origin was not found.'
    if ($taskRemote -notmatch '^(https://github\.com/|git@github\.com:|ssh://git@github\.com/)Yac836/dsh-usage-report(?:\.git)?$') { Stop-Deployment 'Origin is not the expected credential-free GitHub repository URL.' }
    if (-not $Rollback) {
        $taskGh = (Get-Command gh -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
        $taskPrivate = Invoke-Quiet $taskGh @('repo', 'view', 'Yac836/dsh-usage-report', '--json', 'isPrivate', '--jq', '.isPrivate') 'Cannot confirm GitHub visibility. Check gh authentication yourself.'
        if ($taskPrivate -ne 'true') { Write-Warning 'Repository is public. Visibility is informational; continuing with the guarded sync.' }
        Assert-CleanRepo
    }
    foreach ($taskForbiddenRoot in @($taskRoot, $DshHome)) {
        $taskForbidden = [IO.Path]::GetFullPath($taskForbiddenRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
        if ($taskBackupRoot -eq $taskForbidden -or $taskBackupRoot.StartsWith($taskForbidden + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
            Stop-Deployment 'Backup root must be outside the source checkout and DSH home.'
        }
    }
    $taskLockId = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes("$DshHome|$Profile"))).Substring(0, 16)
    $taskMutex = [Threading.Mutex]::new($false, "Local\dsh-usage-report-$taskLockId")
    $taskOwnsMutex = $taskMutex.WaitOne(0)
    if (-not $taskOwnsMutex) { Stop-Deployment 'Another deployment is already running.' }
    $taskOptions = @('--source', $taskRoot, '--home', $DshHome, '--profile', $Profile)
    if ($Rollback) {
        $taskStage = 'rollback_preflight'
        $taskBackup = Join-Path $taskBackupRoot $Rollback
        if (-not (Test-Path -LiteralPath (Join-Path $taskBackup 'deployment.json') -PathType Leaf)) { Stop-Deployment 'Requested rollback record was not found.' }
        $taskRecord = Get-Content -LiteralPath (Join-Path $taskBackup 'deployment.json') -Raw | ConvertFrom-Json
        if ([IO.Path]::GetFullPath($taskRecord.dshHome) -ne [IO.Path]::GetFullPath($DshHome) -or $taskRecord.profile -ne $Profile) { Stop-Deployment 'Rollback belongs to another home or profile.' }
        $taskBeforeMarker = (Invoke-Files 'inspect' $taskOptions).markerHash
    } else {
        $taskStage = 'sync'
        if (-not $NoPull -and -not $CheckOnly) {
            $taskUpstream = Invoke-Quiet $taskGit @('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}') 'Configure an origin tracking branch before updating.'
            if (-not $taskUpstream.StartsWith('origin/')) { Stop-Deployment 'Only an origin tracking branch can be synchronized.' }
            Write-Host 'Pulling the current tracking branch (fast-forward only)...'
            $taskGitPrompt = $env:GIT_TERMINAL_PROMPT; $taskGcmPrompt = $env:GCM_INTERACTIVE
            try {
                $env:GIT_TERMINAL_PROMPT = '0'; $env:GCM_INTERACTIVE = 'Never'
                $null = Invoke-Quiet $taskGit @('pull', '--ff-only', '--no-rebase') 'Pull failed; check Git access and the upstream branch yourself. Installed plugin files have not changed.'
            } finally { $env:GIT_TERMINAL_PROMPT = $taskGitPrompt; $env:GCM_INTERACTIVE = $taskGcmPrompt }
            Assert-CleanRepo
            $taskPulledHead = Invoke-Quiet $taskGit @('rev-parse', 'HEAD') 'Cannot recheck pulled commit.'
            $taskUpstreamHead = Invoke-Quiet $taskGit @('rev-parse', '@{upstream}') 'Cannot recheck upstream commit.'
            if ($taskPulledHead -ne $taskUpstreamHead) { Stop-Deployment 'Local branch has unpublished commits. Push/review them first, or explicitly deploy an audited local commit with -NoPull.' }
        }
        $taskCommit = Invoke-Quiet $taskGit @('rev-parse', 'HEAD') 'Cannot read source commit.'
        $taskOptions += @('--commit', $taskCommit)
        $taskPlan = Invoke-Files 'plan' $taskOptions
        $taskBeforeMarker = $taskPlan.beforeMarkerHash
        if ($CheckOnly) { Write-Host "Checks passed. Source: $($taskCommit.Substring(0, 7)); installed: $($taskPlan.before.commit.Substring(0, 7)). No pull, install, file replacement, or restart performed."; return }
        if ($taskPlan.unchanged) { Write-Host "Plugin files already match source $($taskCommit.Substring(0, 7)); installed record: $($taskPlan.before.commit.Substring(0, 7)). No restart needed."; return }
        $taskStage = 'tests'
        $taskTestHost = Get-DefaultWebProcess
        $taskHostPackage = if ($taskTestHost) { $taskTestHost.Package } else { Join-Path $DshHome 'profiles/node_modules/@deepseek-ai/dsh' }
        if (-not (Test-Path -LiteralPath (Join-Path $taskHostPackage 'package.json') -PathType Leaf)) { Stop-Deployment 'Installed DSH package was not found; compatibility verification cannot be skipped.' }
        Write-Host 'Installing locked test dependencies and running compatibility checks and tests...'
        $taskNpm = (Get-Command npm.cmd -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
        $taskTestDir = Join-Path ([Environment]::GetFolderPath('UserProfile')) ('codex-temp\dsh-sync-test-' + [guid]::NewGuid().ToString('N'))
        [IO.Directory]::CreateDirectory($taskTestDir) | Out-Null
        foreach ($taskName in @('DSH_HOME', 'TEMP', 'TMP')) { $taskOldEnv[$taskName] = [Environment]::GetEnvironmentVariable($taskName, 'Process') }
        $env:TEMP = $taskTestDir; $env:TMP = $taskTestDir; $env:DSH_HOME = Join-Path $taskTestDir 'isolated-dsh'
        try {
            $null = Invoke-Quiet $taskNpm @('ci', '--ignore-scripts', '--no-audit', '--no-fund', '--logs-max=0') 'Dependency installation failed; installed plugin was not changed.'
            $null = Invoke-Quiet $taskNode @('scripts/verify.mjs', '--dsh', $taskHostPackage) 'Compatibility check failed; installed plugin was not changed.'
            $null = Invoke-Quiet $taskNpm @('test', '--logs-max=0') 'Tests failed; installed plugin was not changed.'
            $null = Invoke-Quiet (Join-Path $PSHOME 'pwsh.exe') @('-NoProfile', '-File', 'scripts/test/sync-deploy.Tests.ps1') 'Windows deployment guard tests failed; installed plugin was not changed.'
        } finally {
            foreach ($taskName in $taskOldEnv.Keys) { [Environment]::SetEnvironmentVariable($taskName, $taskOldEnv[$taskName], 'Process') }
        }
        Assert-CleanRepo
        if ((Invoke-Quiet $taskGit @('rev-parse', 'HEAD') 'Cannot recheck commit.') -ne $taskCommit) { Stop-Deployment 'Source commit changed during testing.' }
    }
    $taskStage = 'host_preflight'
    $taskRestart = Get-DefaultWebProcess
    if ($taskTestHost -and (-not $taskRestart -or $taskRestart.Creation -ne $taskTestHost.Creation -or $taskRestart.Command -ne $taskTestHost.Command)) { Stop-Deployment 'DSH changed during testing. Run the update again against the current host.' }
    if (-not $taskRestart -and -not $NoRestart) { Stop-Deployment 'No verified running host. Start the usual dsh web instance, or use -NoRestart to deploy while it is closed.' }
    if (-not $Rollback) {
        $taskStage = 'prepare'
        $taskId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
        $taskBackup = Join-Path $taskBackupRoot $taskId
        New-PrivateDirectory $taskBackup
        $null = Invoke-Files 'prepare' ($taskOptions + @('--backup', $taskBackup))
    }
    if ($taskRestart) {
        $taskStage = 'stop'
        Write-Host 'Restarting the verified local DSH web instance...'
        Stop-VerifiedHost $taskRestart
        $taskStopped = $true
    }
    $taskStage = 'activate'
    $taskResult = Invoke-Files $(if ($Rollback) { 'rollback' } else { 'activate' }) @('--backup', $taskBackup)
    $taskActivated = $true
    if ($taskRestart) { $taskStage = 'restart'; Start-VerifiedHost $taskRestart; $taskStopped = $false }
    Write-Host "Deployed: $($taskResult.commit.Substring(0, 7)). Configuration and session files were preserved."
    if ($taskRestart) { Write-Host "DSH is listening on loopback. Open your existing signed-in browser: http://127.0.0.1:$Port/ (verify the Usage panel and refresh)." }
    else { Write-Host 'Start DSH normally to load this version.' }
    if (-not $Rollback) { Write-Host "Rollback command: pwsh -NoProfile -File .\scripts\sync-deploy.ps1 -Rollback $taskId"; Write-Host 'Reuse any custom -DshHome, -Profile, -Port, -BackupRoot and -NoRestart arguments for rollback.' }
} catch {
    # Raw external errors can include URLs or credential-bearing diagnostics. Do not print them.
    Write-Host "Stopped at stage: $taskStage."
    if ($taskSafeFailure) { Write-Host $taskSafeFailure }
    if ($taskStopped -and $taskRestart) {
        try {
            if ($taskNewPid) {
                $taskNew = Get-CimInstance Win32_Process -Filter "ProcessId=$taskNewPid"
                if ($taskNew -and $taskNew.CreationDate -eq $taskNewCreation -and $taskNew.ExecutablePath -eq $taskRestart.Executable -and $taskNew.CommandLine.Contains($taskRestart.Entry)) { Stop-Process -Id $taskNewPid -ErrorAction Stop }
            }
            if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) { throw 'Port occupied; manual recovery required.' }
            if ($taskActivated -and -not $Rollback) { $null = Invoke-Files 'rollback' @('--backup', $taskBackup) }
            $taskRecovery = Invoke-Files 'inspect' $taskOptions
            $taskExpectedMarker = if ($Rollback -and $taskActivated) { $taskRecord.beforeMarkerHash } else { $taskBeforeMarker }
            if ($taskRecovery.markerHash -ne $taskExpectedMarker) { Stop-Deployment 'Recovery files do not match a verified version. Manual inspection is required.' }
            Start-VerifiedHost $taskRestart
            Write-Host 'Preserved installed version restarted; review the recovery record.'
        } catch { Write-Host 'Automatic recovery could not be confirmed. Preserve the backup and inspect DSH locally; no unknown process was stopped.' }
    }
    if ($taskBackup) { Write-Host "Recovery record: $(Join-Path $taskBackup 'deployment.json')" }
    Write-Host 'Check repository cleanliness/private visibility, gh access, tests, installed file hashes, and the exact local host. No raw diagnostics were written.'
    exit 1
} finally {
    Set-Location -LiteralPath $taskOriginalLocation
    if ($taskOwnsMutex) { $taskMutex.ReleaseMutex() }
    if ($taskMutex) { $taskMutex.Dispose() }
    # Tests own this new directory. Validate its absolute location before recursive cleanup.
    if ($taskTestDir -and (Test-Path -LiteralPath $taskTestDir)) {
        $taskTempRoot = [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('UserProfile')) 'codex-temp')) + [IO.Path]::DirectorySeparatorChar
        $taskResolvedTemp = [IO.Path]::GetFullPath($taskTestDir)
        if ($taskResolvedTemp.StartsWith($taskTempRoot, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path $taskResolvedTemp -Leaf) -match '^dsh-sync-test-[a-f0-9]{32}$') {
            Remove-Item -LiteralPath $taskResolvedTemp -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
