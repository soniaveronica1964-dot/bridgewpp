$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principalCheck = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principalCheck.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Abrí PowerShell como administrador con la misma cuenta de Windows y volvé a ejecutar este script.'
}

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$account = $identity.Name
$supportDirectory = Join-Path $env:LOCALAPPDATA 'BridgeWppDataApi'
$configPath = Join-Path $supportDirectory 'api-config.json'
$launcherPath = Join-Path $supportDirectory 'Start-BridgeWppDataApi.ps1'
$launcherSourcePath = Join-Path $PSScriptRoot 'Start-BridgeWppDataApi.ps1'
$keepalivePath = Join-Path $PSScriptRoot 'keepalive.ps1'
foreach ($requiredPath in @($configPath, $launcherSourcePath, $keepalivePath)) {
  if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
    throw "No se encontró el archivo requerido: $requiredPath"
  }
}

$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
if (-not $config.ApiHost -or -not $config.ApiPort -or
  -not $config.WorkspaceId -or -not $config.Repo) {
  throw 'La configuración local de la API está incompleta.'
}
$healthUri = "https://$($config.ApiHost):$($config.ApiPort)/health"
$health = Invoke-RestMethod -Uri $healthUri -Method Get -TimeoutSec 8
if ($health.status -ne 'healthy' -or $health.schemaVersion -ne 5) {
  throw 'La API existente no está saludable con el esquema 5. No se reemplazaron las tareas.'
}

Copy-Item -LiteralPath $launcherSourcePath -Destination $launcherPath -Force

$powerShellPath = Join-Path $PSHOME 'powershell.exe'
$principal = New-ScheduledTaskPrincipal -UserId $account -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -RestartCount 999 `
  -RestartInterval ([TimeSpan]::FromMinutes(1)) `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -DontStopOnIdleEnd `
  -Hidden

$apiAction = New-ScheduledTaskAction `
  -Execute $powerShellPath `
  -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcherPath`""
$apiTriggers = @(
  (New-ScheduledTaskTrigger -AtStartup),
  (New-ScheduledTaskTrigger -AtLogOn -User $account)
)
$apiTask = New-ScheduledTask `
  -Action $apiAction `
  -Trigger $apiTriggers `
  -Principal $principal `
  -Settings $settings `
  -Description 'BridgeWpp PostgreSQL HTTPS API. Runs hidden at system startup and user logon.'

$keepaliveAction = New-ScheduledTaskAction `
  -Execute $powerShellPath `
  -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$keepalivePath`""
$keepaliveTriggers = @(
  (New-ScheduledTaskTrigger -AtStartup),
  (New-ScheduledTaskTrigger `
  -Once `
  -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval ([TimeSpan]::FromMinutes(1)) `
  -RepetitionDuration ([TimeSpan]::FromDays(3650)))
)
$keepaliveTask = New-ScheduledTask `
  -Action $keepaliveAction `
  -Trigger $keepaliveTriggers `
  -Principal $principal `
  -Settings $settings `
  -Description 'Checks BridgeWpp PostgreSQL API health every minute and restarts its task if it is unavailable.'

Register-ScheduledTask -TaskName 'BridgeWpp Data API' -InputObject $apiTask -Force | Out-Null
Register-ScheduledTask -TaskName 'BridgeWpp Data API Keepalive' -InputObject $keepaliveTask -Force | Out-Null
Start-ScheduledTask -TaskName 'BridgeWpp Data API'
Start-ScheduledTask -TaskName 'BridgeWpp Data API Keepalive'

$deadline = (Get-Date).AddSeconds(30)
do {
  Start-Sleep -Seconds 1
  try {
    $health = Invoke-RestMethod -Uri $healthUri -Method Get -TimeoutSec 5
  } catch {
    $health = $null
  }
} while (($null -eq $health -or $health.status -ne 'healthy' -or $health.schemaVersion -ne 5) -and
  (Get-Date) -lt $deadline)

if ($null -eq $health -or $health.status -ne 'healthy' -or $health.schemaVersion -ne 5) {
  throw 'Las tareas se instalaron, pero la API no confirmó salud con el esquema 5.'
}

Write-Output 'Tareas instaladas: BridgeWpp Data API (inicio del sistema/logon) y BridgeWpp Data API Keepalive (comprobación cada minuto).'
Write-Output "API saludable: $healthUri"
