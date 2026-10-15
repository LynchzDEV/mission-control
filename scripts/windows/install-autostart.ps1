# Usage: .\install-autostart.ps1 [-Distro Ubuntu-24.04] [-RepoPath ~/shiki] [-ShowWindow] [-Remove]
[CmdletBinding()]
param(
    [string]$Distro = 'Ubuntu-24.04',
    [string]$RepoPath = '~/shiki',
    [switch]$ShowWindow,
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$TaskName = 'Shikidan'
$LogPath = '~/shiki.log'
# ponytail: task name and clone folder from before Shikidan, drop once no PC still has them
$LegacyTaskName = 'Mission Control'
$LegacyRepoPath = '~/mission-control'

function Remove-TaskIfPresent([string]$Name) {
    if (-not (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue)) { return $false }
    Unregister-ScheduledTask -TaskName $Name -Confirm:$false | Out-Null
    return $true
}

function ConvertTo-BashPath([string]$Path) {
    if ($Path -match '["$`\\%]') {
        throw "RepoPath '$Path' contains a character this task cannot pass through safely (`", `$, backtick, backslash or %)."
    }
    $quote = { param($text) "'" + ($text -replace "'", "'\''") + "'" }
    if ($Path -eq '~') { return '~' }
    if ($Path.StartsWith('~/')) { return '~/' + (& $quote $Path.Substring(2)) }
    return (& $quote $Path)
}

if ($Remove) {
    $removed = @($TaskName, $LegacyTaskName) | Where-Object { Remove-TaskIfPresent $_ }
    if ($removed) {
        Write-Host "Removed the $(($removed | ForEach-Object { "'$_'" }) -join ' and ') task. Shikidan will no longer start at log on."
    } else {
        Write-Host "No '$TaskName' task found; nothing to remove."
    }
    return
}

$installed = (wsl.exe --list --quiet) -replace "`0", '' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
if ($installed -notcontains $Distro) {
    throw "WSL distro '$Distro' is not installed. Run scripts\windows\setup-wsl.ps1 first, or pass -Distro <name>."
}

if (-not $PSBoundParameters.ContainsKey('RepoPath')) {
    wsl.exe -d $Distro -- bash -lc "test ! -d ~/shiki && test -d $LegacyRepoPath" | Out-Null
    if ($LASTEXITCODE -eq 0) {
        $RepoPath = $LegacyRepoPath
        Write-Host "Using the existing clone at $LegacyRepoPath."
    }
}

if (Remove-TaskIfPresent $LegacyTaskName) {
    Write-Host "Removed the old '$LegacyTaskName' task so Shikidan starts only once."
}

$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$bashCommand = "{ cd $(ConvertTo-BashPath $RepoPath) && bun start; } >> $LogPath 2>&1"
$wslArguments = "-d $Distro -- bash -lc `"$bashCommand`""
if ($ShowWindow) {
    $action = New-ScheduledTaskAction -Execute 'wsl.exe' -Argument $wslArguments
} else {
    $action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless wsl.exe $wslArguments"
}
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

Write-Host "Registered '$TaskName': at log on it runs $($action.Execute) $($action.Arguments)"
if ($ShowWindow) {
    Write-Host 'A console window opens at sign-in. Minimize it; closing it stops Shikidan.'
} else {
    Write-Host "It runs hidden. Output goes to $LogPath inside $Distro."
}
Write-Host "Start it now without logging out:  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Stop it:                           Stop-ScheduledTask -TaskName '$TaskName'"
Write-Host "Then open http://localhost:7777. Keep Windows sleep off if it must run 24/7."
