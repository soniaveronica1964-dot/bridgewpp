param(
  [Parameter(Mandatory = $true)]
  [string]$ExtensionId
)

$ErrorActionPreference = "Stop"
if ($ExtensionId -notmatch "^[a-p]{32}$") {
  throw "ExtensionId debe ser el ID publicado de 32 caracteres de Chrome."
}

$compiler = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $compiler)) {
  $compiler = Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe"
}
if (-not (Test-Path $compiler)) {
  throw "No se encontró el compilador .NET Framework requerido para el host nativo."
}

$installDirectory = Join-Path $env:LOCALAPPDATA "BridgeWppDataHost"
New-Item -ItemType Directory -Force -Path $installDirectory | Out-Null
$source = Join-Path $PSScriptRoot "BridgeWppDataHost.cs"
$hostPath = Join-Path $installDirectory "BridgeWppDataHost.exe"
$manifestPath = Join-Path $installDirectory "com.bridgewpp.data.json"

& $compiler /nologo /target:exe /out:$hostPath /reference:System.Web.Extensions.dll $source
if ($LASTEXITCODE -ne 0) {
  throw "No se pudo compilar el host nativo."
}

$manifest = @{
  name = "com.bridgewpp.data"
  description = "BridgeWpp Windows DPAPI profile credential host"
  path = $hostPath
  type = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($manifestPath, $manifest, [System.Text.UTF8Encoding]::new($false))

$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.bridgewpp.data"
New-Item -Path $registryPath -Force | Out-Null
Set-Item -Path $registryPath -Value $manifestPath
Write-Output "Host nativo instalado para el ID de extensión $ExtensionId."
Write-Output "Credenciales por perfil Chrome se cifrarán con DPAPI en %LOCALAPPDATA%\BridgeWppDataHost."
