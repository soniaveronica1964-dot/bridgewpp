$ErrorActionPreference = 'Stop'
$supportDirectory = Join-Path $env:LOCALAPPDATA 'BridgeWppDataApi'
$config = Get-Content -LiteralPath (Join-Path $supportDirectory 'api-config.json') -Raw | ConvertFrom-Json
$logPath = Join-Path $supportDirectory 'api.log'
$nodeExitCode = $null
$startedAt = Get-Date

function Write-ApiLog([string]$message) {
  Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format o) $message" -Encoding UTF8
}

try {
  $env:DATA_API_HOST = $config.ApiHost
  $env:DATA_API_PORT = $config.ApiPort
  $env:DATA_ENCRYPTION_KEY = $config.EncryptionKey
  $env:DATA_ALLOWED_EXTENSION_IDS = $config.ExtensionIds
  $env:DATA_TLS_CERT_FILE = $config.TlsCert
  $env:DATA_TLS_KEY_FILE = $config.TlsKey
  $env:DATA_WORKSPACE_ID = $config.WorkspaceId
  $env:DATA_PGHOST = $config.DbHost
  $env:DATA_PGPORT = $config.DbPort
  $env:DATA_PGDATABASE = $config.DbName
  $env:DATA_PGUSER = $config.DbUser
  $env:DATA_PGPASSWORD = $config.DbPassword

  Set-Location -LiteralPath $config.Repo
  $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
  $serverPath = Join-Path $config.Repo 'data-api\server.js'
  Write-ApiLog "LAUNCHER_START powershellPid=$PID nodePath=$nodePath serverPath=$serverPath"

  $nativeErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & $nodePath $serverPath *>> $logPath
    $nodeExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $nativeErrorActionPreference
  }
} catch {
  Write-ApiLog "LAUNCHER_ERROR type=$($_.Exception.GetType().FullName) message=$($_.Exception.Message)"
  throw
} finally {
  $elapsedMs = [int]((Get-Date) - $startedAt).TotalMilliseconds
  if ($null -eq $nodeExitCode) {
    Write-ApiLog "LAUNCHER_END powershellPid=$PID nodeExitCode=not-started elapsedMs=$elapsedMs"
  } else {
    Write-ApiLog "LAUNCHER_END powershellPid=$PID nodeExitCode=$nodeExitCode elapsedMs=$elapsedMs"
  }
}

if ($null -eq $nodeExitCode -or $nodeExitCode -ne 0) {
  exit 1
}
