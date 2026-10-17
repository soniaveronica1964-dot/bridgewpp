$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principalCheck = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principalCheck.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Abrí PowerShell como administrador con la misma cuenta que instaló la API.'
}

$supportDirectory = Join-Path $env:LOCALAPPDATA 'BridgeWppDataApi'
$configPath = Join-Path $supportDirectory 'api-config.json'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
  throw "No se encontró la configuración local de la API: $configPath"
}

$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
if (-not $config.Repo -or -not $config.DbHost -or -not $config.DbPort -or
  -not $config.DbName -or -not $config.DbUser -or -not $config.DbPassword -or
  -not $config.ApiHost -or -not $config.ApiPort) {
  throw 'La configuración local de la API no contiene los datos necesarios para actualizarla.'
}

$repoPath = [IO.Path]::GetFullPath($config.Repo)
$apiDirectory = Join-Path $repoPath 'data-api'
$packagePath = Join-Path $apiDirectory 'package.json'
$lockPath = Join-Path $apiDirectory 'package-lock.json'
$serverPath = Join-Path $repoPath 'data-api\server.js'
$migrationPath = Join-Path $repoPath 'data-api\migrate.js'
foreach ($requiredPath in @($packagePath, $lockPath, $serverPath, $migrationPath)) {
  if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
    throw "No se encontró el archivo requerido para actualizar la API: $requiredPath"
  }
}

$env:PGHOST = $config.DbHost
$env:PGPORT = [string]$config.DbPort
$env:PGDATABASE = $config.DbName
$env:PGUSER = $config.DbUser
$env:PGPASSWORD = $config.DbPassword
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$npmPath = (Get-Command npm.cmd -ErrorAction Stop).Source

Write-Output 'Instalando dependencias de la API...'
& $npmPath ci --omit=dev --prefix $apiDirectory
if ($LASTEXITCODE -ne 0) {
  throw "La instalación de dependencias terminó con código $LASTEXITCODE. La API no se reinició."
}

Write-Output 'Aplicando migraciones PostgreSQL...'
& $nodePath $migrationPath
if ($LASTEXITCODE -ne 0) {
  throw "El migrador terminó con código $LASTEXITCODE. La tarea de la API no se reinició."
}

$taskName = 'BridgeWpp Data API'
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
if ($task.State -eq 'Running') {
  Stop-ScheduledTask -TaskName $taskName
  $stopDeadline = (Get-Date).AddSeconds(20)
  do {
    Start-Sleep -Seconds 1
    $task = Get-ScheduledTask -TaskName $taskName
  } while ($task.State -eq 'Running' -and (Get-Date) -lt $stopDeadline)
  if ($task.State -eq 'Running') {
    throw "La tarea '$taskName' no terminó de detenerse."
  }
}

$oldProcesses = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'node.exe' -and
  $_.CommandLine -and
  $_.CommandLine.IndexOf($serverPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
})
foreach ($process in $oldProcesses) {
  Stop-Process -Id $process.ProcessId
}

$stopDeadline = (Get-Date).AddSeconds(15)
do {
  Start-Sleep -Milliseconds 500
  $remaining = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'node.exe' -and
    $_.CommandLine -and
    $_.CommandLine.IndexOf($serverPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
  })
} while ($remaining.Count -gt 0 -and (Get-Date) -lt $stopDeadline)
if ($remaining.Count -gt 0) {
  throw "No se detuvieron los procesos Node de la API configurada: $serverPath"
}

Start-ScheduledTask -TaskName $taskName
$healthUri = "https://$($config.ApiHost):$($config.ApiPort)/health"
$health = $null
$deadline = (Get-Date).AddSeconds(30)
do {
  Start-Sleep -Seconds 1
  try {
    $health = Invoke-RestMethod -Uri $healthUri -Method Get -TimeoutSec 5
  } catch {
    $health = $null
  }
} while (($null -eq $health -or $health.status -ne 'healthy' -or
    $health.schemaVersion -ne 10) -and (Get-Date) -lt $deadline)

if ($null -eq $health -or $health.status -ne 'healthy' -or $health.schemaVersion -ne 10) {
  throw "La API no confirmó salud con el esquema 10. Revisá $supportDirectory\api.log."
}

Write-Output "API actualizada y saludable con esquema $($health.schemaVersion): $healthUri"
