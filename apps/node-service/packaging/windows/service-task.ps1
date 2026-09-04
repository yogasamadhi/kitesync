param(
  [string]$Executable,
  [switch]$Remove,
  [switch]$Status,
  [switch]$StartIfInstalled
)

$ErrorActionPreference = 'Stop'
$taskName = 'KiteSync'

if ($StartIfInstalled) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if (-not $task) {
    Write-Output 'not-installed'
    exit 0
  }
  Start-ScheduledTask -TaskName $taskName
  Write-Output 'started'
  exit 0
}

if ($Status) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if (-not $task) {
    Write-Output 'not-installed'
    exit 0
  }
  Write-Output $task.State.ToString().ToLowerInvariant()
  exit 0
}

if ($Remove) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  exit 0
}

if (-not $Executable -or -not (Test-Path -LiteralPath $Executable)) {
  throw 'KiteSync executable does not exist'
}

$action = New-ScheduledTaskAction -Execute $Executable -Argument 'serve'
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description 'KiteSync 局域网文件同步后台进程' `
  -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
