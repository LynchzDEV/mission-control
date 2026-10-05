# Usage: .\setup-wsl.ps1 [-Distro Ubuntu-24.04]
[CmdletBinding()]
param(
    [string]$Distro = 'Ubuntu-24.04'
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    throw 'wsl.exe was not found. Mission Control needs Windows 10 version 2004+ or Windows 11.'
}

wsl.exe --status | Out-Null
$wslReady = $LASTEXITCODE -eq 0

$installed = @()
if ($wslReady) {
    $installed = (wsl.exe --list --quiet) -replace "`0", '' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
}

if ($installed -contains $Distro) {
    Write-Host "$Distro is already installed."
} else {
    Write-Host "Installing $Distro (Windows may ask for administrator approval and a restart)..."
    wsl.exe --install -d $Distro
    if ($LASTEXITCODE -ne 0) {
        throw "wsl --install -d $Distro failed (exit $LASTEXITCODE). Restart Windows if it asked you to, then run this script again."
    }
    Write-Host "When $Distro opens for the first time, pick a Linux user name and password."
}

Write-Host ''
Write-Host 'Next, inside Ubuntu (Start menu -> Ubuntu 24.04), run:'
Write-Host '  git clone https://github.com/LynchzDEV/mission-control.git ~/mission-control'
Write-Host '  ~/mission-control/scripts/wsl/setup.sh --with-plugins'
Write-Host 'Then follow the steps it prints. Full guide: docs/install-windows.md'
