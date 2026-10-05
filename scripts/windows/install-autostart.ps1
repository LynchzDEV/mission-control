# Usage: .\install-autostart.ps1 [-Distro Ubuntu-24.04] [-RepoPath ~/mission-control] [-ShowWindow] [-Remove]
[CmdletBinding()]
param(
    [string]$Distro = 'Ubuntu-24.04',
    [string]$RepoPath = '~/mission-control',
    [switch]$ShowWindow,
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$TaskName = 'Mission Control'
$LogPath = '~/mission-control.log'

function ConvertTo-BashPath([string]$Path) {
    if ($Path -match '["$`\\]') {
        throw "RepoPath '$Path' contains a character this task cannot pass through safely (`", `$, backtick or backslash)."
    }
    $quote = { param($text) "'" + ($text -replace "'", "'\''") + "'" }
    if ($Path -eq '~') { return '~' }
    if ($Path.StartsWith('~/')) { return '~/' + (& $quote $Path.Substring(2)) }
    return (& $quote $Path)
}

if ($Remove) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed the '$TaskName' task. Mission Control will no longer start at log on."
    } else {
        Write-Host "No '$TaskName' task found; nothing to remove."
    }
    return
}

$installed = (wsl.exe --list --quiet) -replace "`0", '' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
if ($installed -notcontains $Distro) {
    throw "WSL distro '$Distro' is not installed. Run scripts\windows\setup-wsl.ps1 first, or pass -Distro <name>."
}

$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$bashCommand = "cd $(ConvertTo-BashPath $RepoPath) && bun start >> $LogPath 2>&1"
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
    Write-Host 'A console window opens at sign-in. Minimize it; closing it stops Mission Control.'
} else {
    Write-Host "It runs hidden. Output goes to $LogPath inside $Distro."
}
Write-Host "Start it now without logging out:  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Stop it:                           Stop-ScheduledTask -TaskName '$TaskName'"
Write-Host "Then open http://localhost:7777. Keep Windows sleep off if it must run 24/7."
