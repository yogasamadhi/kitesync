param(
  [string]$Syncthing,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$ruleGroup = 'KiteSync'

Get-NetFirewallRule -Group $ruleGroup -ErrorAction SilentlyContinue |
  Remove-NetFirewallRule -ErrorAction SilentlyContinue

if ($Remove) {
  exit 0
}

if (-not $Syncthing -or -not (Test-Path -LiteralPath $Syncthing)) {
  throw 'Syncthing executable does not exist'
}

New-NetFirewallRule `
  -DisplayName 'KiteSync Syncthing TCP' `
  -Group $ruleGroup `
  -Direction Inbound `
  -Action Allow `
  -Enabled True `
  -Profile Private `
  -Program $Syncthing `
  -Protocol TCP | Out-Null

New-NetFirewallRule `
  -DisplayName 'KiteSync Syncthing UDP' `
  -Group $ruleGroup `
  -Direction Inbound `
  -Action Allow `
  -Enabled True `
  -Profile Private `
  -Program $Syncthing `
  -Protocol UDP | Out-Null
