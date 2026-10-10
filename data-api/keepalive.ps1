$ErrorActionPreference = 'Stop'
$supportDirectory = Join-Path $env:LOCALAPPDATA 'BridgeWppDataApi'
$logPath = Join-Path $supportDirectory 'keepalive.log'
$taskName = 'BridgeWpp Data API'
$apiPort = 3443
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Write-KeepaliveLog([string]$message) {
  Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format o) $message" -Encoding UTF8
}

function Get-HealthResponse($healthUri) {
  try {
    $health = Invoke-RestMethod -Uri $healthUri -Method Get -TimeoutSec 5
    return @{
      Responded = $true
      Healthy = $health.status -eq 'healthy' -and $health.schemaVersion -eq 5
      Detail = "HTTP 200, schema $($health.schemaVersion)"
    }
  } catch {
    $statusCode = [int]$_.Exception.Response.StatusCode
    if ($statusCode) {
      return @{
        Responded = $true
        Healthy = $false
        Detail = "HTTP $statusCode"
      }
    }
    return @{
      Responded = $false
      Healthy = $false
      Detail = $_.Exception.Message
    }
  }
}

Start-Sleep -Seconds 5
$configPath = Join-Path $supportDirectory 'api-config.json'
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
if ($config.ApiPort -ne $apiPort) {
  $apiPort = [int]$config.ApiPort
}
$healthUri = "https://$($config.ApiHost):$apiPort/health"
$probeDetails = @()
$apiResponded = $false
for ($attempt = 1; $attempt -le 3; $attempt++) {
  $probe = Get-HealthResponse $healthUri
  if ($probe.Healthy) {
    exit 0
  }
  if ($probe.Responded) {
    $apiResponded = $true
  }
  $probeDetails += "probe $attempt $($probe.Detail)"
  if ($attempt -lt 3) {
    Start-Sleep -Seconds 5
  }
}

if ($apiResponded) {
  Write-KeepaliveLog "API responded but health check failed; no restart. $($probeDetails -join '; ')"
  exit 0
}

$listener = Get-NetTCPConnection -State Listen -LocalPort $apiPort -ErrorAction SilentlyContinue |
  Select-Object -First 1
if ($listener) {
  Write-KeepaliveLog "HTTPS probe failed but port $apiPort is listening (PID $($listener.OwningProcess)); no restart. $($probeDetails -join '; ')"
  exit 0
}

$recentRecovery = Get-Content -LiteralPath $logPath -Tail 100 -ErrorAction SilentlyContinue |
  Where-Object { $_ -match 'RECOVERY_REQUESTED' } |
  Select-Object -Last 1
$recoveryTime = [DateTimeOffset]::MinValue
if ($recentRecovery -and
  [DateTimeOffset]::TryParse($recentRecovery.Substring(0, 33), [ref]$recoveryTime) -and
  ([DateTimeOffset]::Now - $recoveryTime).TotalSeconds -lt 120) {
  Write-KeepaliveLog "Restart suppressed because a recovery was requested less than 120 seconds ago. $($probeDetails -join '; ')"
  exit 0
}

Write-KeepaliveLog "Three probes could not connect and no listener exists on port $apiPort. $($probeDetails -join '; ')"
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
if ($task.State -eq 'Disabled') {
  throw "La tarea '$taskName' está deshabilitada; no se puede recuperar automáticamente."
}
if ($task.State -eq 'Running') {
  Stop-ScheduledTask -TaskName $taskName
  $deadline = (Get-Date).AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 500
    $task = Get-ScheduledTask -TaskName $taskName
  } while ($task.State -eq 'Running' -and (Get-Date) -lt $deadline)
  if ($task.State -eq 'Running') {
    throw "La tarea '$taskName' no se detuvo para recuperarse."
  }
}

$listener = Get-NetTCPConnection -State Listen -LocalPort $apiPort -ErrorAction SilentlyContinue |
  Select-Object -First 1
if ($listener) {
  Write-KeepaliveLog "A listener appeared on port $apiPort during recovery; no duplicate task was started."
  exit 0
}

Start-ScheduledTask -TaskName $taskName
$deadline = (Get-Date).AddSeconds(30)
do {
  Start-Sleep -Seconds 2
  $listener = Get-NetTCPConnection -State Listen -LocalPort $apiPort -ErrorAction SilentlyContinue |
    Select-Object -First 1
  $probe = Get-HealthResponse $healthUri
} while ((-not $probe.Healthy -or -not $listener) -and (Get-Date) -lt $deadline)
if (-not $probe.Healthy -or -not $listener) {
  throw "Recovery was requested for '$taskName', but API health was not confirmed within 30 seconds. $($probe.Detail)"
}

Write-KeepaliveLog "RECOVERY_REQUESTED '$taskName'; API healthy on schema 5 (PID $($listener.OwningProcess))."
