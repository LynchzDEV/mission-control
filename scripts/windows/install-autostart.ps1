# Usage: .\install-autostart.ps1 [-Distro Ubuntu-24.04] [-RepoPath ~/mission-control] [-Remove]
[CmdletBinding()]
param(
    [string]$Distro = 'Ubuntu-24.04',
    [string]$RepoPath = '~/mission-control',
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$TaskName = 'Mission Control'

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
$bashCommand = "cd $RepoPath && bun start"
$action = New-ScheduledTaskAction -Execute 'wsl.exe' -Argument "-d $Distro -- bash -lc `"$bashCommand`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

Write-Host "Registered '$TaskName': at log on it runs wsl.exe -d $Distro -- bash -lc `"$bashCommand`""
Write-Host "Start it now without logging out:  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Then open http://localhost:7777. Keep Windows sleep off if it must run 24/7."
