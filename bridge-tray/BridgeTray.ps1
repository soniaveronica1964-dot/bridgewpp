Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:appDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:appScriptPath = $MyInvocation.MyCommand.Path
$script:extensionDirectory = Split-Path -Parent $script:appDirectory
$script:serverPath = Join-Path $script:extensionDirectory "bridge\server.js"
$script:dataDirectory = Join-Path $env:LOCALAPPDATA "GanamosWhatsAppBridge"
$script:credentialsPath = Join-Path $script:dataDirectory "credentials.json"
$script:logPath = Join-Path $script:dataDirectory "bridge-tray.log"
$script:startupKeyPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$script:startupValueName = "GanamosWhatsAppBridge"
$script:bridgeProcess = $null
$script:bridgeManaged = $false
$script:closing = $false
$script:lastTrayIconState = ""
$script:processDiscoveryWarningLogged = $false
$script:trayIconResources = New-Object 'System.Collections.Generic.List[System.Drawing.Icon]'

Add-Type -Namespace GanamosBridge -Name IconMethods `
    -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool DestroyIcon(System.IntPtr handle);'

function Write-BridgeLog {
    param([Parameter(Mandatory = $true)][string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -LiteralPath $script:logPath -Value "[$timestamp] $Message" -Encoding UTF8
}

function Test-BridgeHealth {
    $request = $null
    $asyncResult = $null
    try {
        $request = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:32145/health")
        $request.Method = "GET"
        $request.Proxy = $null
        $request.Timeout = 500
        $request.ReadWriteTimeout = 500
        $asyncResult = $request.BeginGetResponse($null, $null)
        if (-not $asyncResult.AsyncWaitHandle.WaitOne(500)) {
            $request.Abort()
            return $false
        }

        $response = $request.EndGetResponse($asyncResult)
        try {
            return [int]$response.StatusCode -eq 200
        } finally {
            $response.Close()
        }
    } catch {
        return $false
    } finally {
        if ($asyncResult) {
            $asyncResult.AsyncWaitHandle.Close()
        }
    }
}

function Set-TrayIconState {
    param([ValidateSet("running", "starting", "stopped")][string]$State)
    if ($script:lastTrayIconState -eq $State) {
        return
    }

    $color = switch ($State) {
        "running" { [System.Drawing.Color]::LimeGreen }
        "starting" { [System.Drawing.Color]::Gold }
        default { [System.Drawing.Color]::Tomato }
    }
    $bitmap = New-Object System.Drawing.Bitmap(32, 32)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.Clear([System.Drawing.Color]::FromArgb(30, 41, 41))
    $font = New-Object System.Drawing.Font("Segoe UI", 19, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $brush = New-Object System.Drawing.SolidBrush($color)
    $graphics.DrawString("B", $font, [System.Drawing.Brushes]::White, 3, 2)
    $graphics.FillEllipse($brush, 22, 22, 8, 8)
    $iconHandle = $bitmap.GetHicon()
    $icon = [System.Drawing.Icon]::FromHandle($iconHandle)
    $ownedIcon = [System.Drawing.Icon]$icon.Clone()
    $notifyIcon.Icon = $ownedIcon
    $script:trayIconResources.Add($ownedIcon)
    [GanamosBridge.IconMethods]::DestroyIcon($iconHandle) | Out-Null
    $icon.Dispose()
    $brush.Dispose()
    $font.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
    $script:lastTrayIconState = $State
}

function Get-NodeExecutable {
    $node = Get-Command "node.exe" -ErrorAction SilentlyContinue
    if (-not $node) {
        $node = Get-Command "node" -ErrorAction SilentlyContinue
    }
    if (-not $node) {
        throw "No se encontró Node.js. Instalá Node.js 18 o posterior y volvé a iniciar el bridge."
    }
    return $node.Source
}

function Find-BridgeProcess {
    try {
        $listeners = @(Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort 32145 `
            -State Listen -ErrorAction Stop)
        foreach ($listener in $listeners) {
            $processInfo = Get-CimInstance -ClassName Win32_Process `
                -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction Stop
            if (-not $processInfo -or
                [System.IO.Path]::GetFileName($processInfo.ExecutablePath) -ine "node.exe") {
                continue
            }

            $serverArgument = '"' + $script:serverPath + '"'
            if ($processInfo.CommandLine.IndexOf(
                $serverArgument,
                [System.StringComparison]::OrdinalIgnoreCase
            ) -ge 0) {
                $script:processDiscoveryWarningLogged = $false
                return [System.Diagnostics.Process]::GetProcessById([int]$listener.OwningProcess)
            }
        }
        $script:processDiscoveryWarningLogged = $false
    } catch {
        if (-not $script:processDiscoveryWarningLogged) {
            Write-BridgeLog "No se pudo identificar el proceso del bridge para adoptarlo: $($_.Exception.Message)"
            $script:processDiscoveryWarningLogged = $true
        }
    }
    return $null
}

function Update-TrayState {
    if ($script:bridgeProcess -and $script:bridgeProcess.HasExited) {
        $exitCode = $script:bridgeProcess.ExitCode
        Write-BridgeLog "El proceso del bridge terminó con código $exitCode."
        $script:bridgeProcess.Dispose()
        $script:bridgeProcess = $null
        $script:bridgeManaged = $false
    }

    $isHealthy = Test-BridgeHealth
    if ($isHealthy -and -not $script:bridgeProcess) {
        $script:bridgeProcess = Find-BridgeProcess
        if ($script:bridgeProcess) {
            $script:bridgeManaged = $true
            Write-BridgeLog "Se adoptó el proceso existente del bridge (PID $($script:bridgeProcess.Id))."
        }
    }
    if ($script:bridgeManaged -and -not $isHealthy -and $script:bridgeProcess -and
        -not $script:bridgeProcess.HasExited) {
        $statusItem.Text = "Estado: iniciando bridge..."
        $startItem.Enabled = $false
        $stopItem.Enabled = $true
        $notifyIcon.Text = "Bridge local: iniciando..."
        Set-TrayIconState "starting"
        return
    }

    if ($isHealthy) {
        $statusItem.Text = if ($script:bridgeManaged) {
            "Estado: activo (administrado por la app)"
        } else {
            "Estado: activo (otro proceso)"
        }
        $startItem.Enabled = $false
        $stopItem.Enabled = $script:bridgeManaged
        $notifyIcon.Text = "Bridge local: activo"
        Set-TrayIconState "running"
    } else {
        $statusItem.Text = "Estado: detenido"
        $startItem.Enabled = $true
        $stopItem.Enabled = $false
        $notifyIcon.Text = "Bridge local: detenido"
        Set-TrayIconState "stopped"
    }

    $autoStartItem.Checked = Test-AutoStartEnabled
}

function Test-AutoStartEnabled {
    try {
        $entry = Get-ItemProperty -Path $script:startupKeyPath -Name $script:startupValueName -ErrorAction Stop
        return [bool]$entry.$($script:startupValueName)
    } catch {
        return $false
    }
}

function Set-AutoStart {
    param([bool]$Enabled)
    if ($Enabled) {
        $powershellPath = Join-Path $PSHOME "powershell.exe"
        $command = "`"$powershellPath`" -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script:appScriptPath`""
        New-Item -Path $script:startupKeyPath -Force | Out-Null
        New-ItemProperty -Path $script:startupKeyPath -Name $script:startupValueName `
            -Value $command -PropertyType String -Force | Out-Null
    } else {
        Remove-ItemProperty -Path $script:startupKeyPath -Name $script:startupValueName `
            -ErrorAction SilentlyContinue
    }
    $autoStartItem.Checked = $Enabled
}

function Start-Bridge {
    if ($script:bridgeProcess -and -not $script:bridgeProcess.HasExited) {
        return
    }
    if (Test-BridgeHealth) {
        [System.Windows.Forms.MessageBox]::Show(
            "El bridge ya está activo en el puerto 32145, pero lo inició otro proceso. Detené ese proceso antes de iniciarlo desde esta app.",
            "Bridge ya activo",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Information
        ) | Out-Null
        Update-TrayState
        return
    }
    if (-not (Test-Path -LiteralPath $script:serverPath)) {
        throw "No se encontró el servidor del bridge: $script:serverPath"
    }

    $nodePath = Get-NodeExecutable
    if (-not (Test-Path -LiteralPath $script:dataDirectory)) {
        New-Item -Path $script:dataDirectory -ItemType Directory -Force | Out-Null
    }
    Write-BridgeLog "Iniciando bridge con $nodePath."

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $nodePath
    $startInfo.Arguments = "`"$($script:serverPath)`""
    $startInfo.WorkingDirectory = $script:extensionDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw "Windows no pudo iniciar el proceso del bridge."
    }

    $process.EnableRaisingEvents = $true
    $script:bridgeProcess = $process
    $script:bridgeManaged = $true
    Write-BridgeLog "Proceso del bridge iniciado (PID $($process.Id))."
    Update-TrayState
}

function Stop-Bridge {
    if (-not $script:bridgeProcess -or $script:bridgeProcess.HasExited) {
        $script:bridgeProcess = $null
        $script:bridgeManaged = $false
        Update-TrayState
        return
    }

    $result = [System.Windows.Forms.MessageBox]::Show(
        "¿Querés detener el bridge? Las solicitudes que estén en curso podrían interrumpirse.",
        "Detener bridge",
        [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Warning
    )
    if ($result -ne [System.Windows.Forms.DialogResult]::Yes) {
        return
    }

    try {
        $script:bridgeProcess.Kill()
        $script:bridgeProcess.WaitForExit(5000) | Out-Null
        Write-BridgeLog "Bridge detenido desde el menú de la bandeja."
    } catch {
        Write-BridgeLog "No se pudo detener el bridge: $($_.Exception.Message)"
        [System.Windows.Forms.MessageBox]::Show(
            "No se pudo detener el bridge:`r`n$($_.Exception.Message)",
            "Error al detener",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        ) | Out-Null
    } finally {
        if ($script:bridgeProcess.HasExited) {
            $script:bridgeProcess.Dispose()
            $script:bridgeProcess = $null
            $script:bridgeManaged = $false
        }
        Update-TrayState
    }
}

function Show-BridgeLogs {
    if (-not (Test-Path -LiteralPath $script:logPath)) {
        Write-BridgeLog "Log creado desde la aplicación de bandeja."
    }
    Start-Process -FilePath "notepad.exe" -ArgumentList "`"$($script:logPath)`""
}

function Exit-TrayApp {
    $script:closing = $true
    if ($script:bridgeManaged -and $script:bridgeProcess -and -not $script:bridgeProcess.HasExited) {
        $result = [System.Windows.Forms.MessageBox]::Show(
            "Al salir también se detendrá el bridge. Las solicitudes que estén en curso podrían interrumpirse. ¿Querés salir?",
            "Salir del bridge",
            [System.Windows.Forms.MessageBoxButtons]::YesNo,
            [System.Windows.Forms.MessageBoxIcon]::Warning
        )
        if ($result -ne [System.Windows.Forms.DialogResult]::Yes) {
            $script:closing = $false
            return
        }
        $script:bridgeProcess.Kill()
        $script:bridgeProcess.WaitForExit(5000) | Out-Null
        $script:bridgeProcess.Dispose()
        $script:bridgeProcess = $null
    }
    $healthTimer.Stop()
    $notifyIcon.Visible = $false
    $notifyIcon.Dispose()
    foreach ($iconResource in $script:trayIconResources) {
        $iconResource.Dispose()
    }
    $contextMenu.Dispose()
    $healthTimer.Dispose()
    $mutex.ReleaseMutex()
    $mutex.Dispose()
    $appContext.ExitThread()
}

$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, "GanamosWhatsAppBridgeTray", [ref]$createdNew)
if (-not $createdNew) {
    [System.Windows.Forms.MessageBox]::Show(
        "La aplicación del bridge ya está ejecutándose. Buscá su ícono en la bandeja del sistema.",
        "Bridge local",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Information
    ) | Out-Null
    exit
}

$contextMenu = New-Object System.Windows.Forms.ContextMenuStrip
$statusItem = New-Object System.Windows.Forms.ToolStripMenuItem("Estado: consultando...")
$statusItem.Enabled = $false
$startItem = New-Object System.Windows.Forms.ToolStripMenuItem("Iniciar bridge")
$stopItem = New-Object System.Windows.Forms.ToolStripMenuItem("Detener bridge")
$autoStartItem = New-Object System.Windows.Forms.ToolStripMenuItem("Iniciar con Windows")
$credentialsItem = New-Object System.Windows.Forms.ToolStripMenuItem("Abrir credenciales")
$logsItem = New-Object System.Windows.Forms.ToolStripMenuItem("Ver logs")
$exitItem = New-Object System.Windows.Forms.ToolStripMenuItem("Salir")
$contextMenu.Items.AddRange(@(
    $statusItem,
    (New-Object System.Windows.Forms.ToolStripSeparator),
    $startItem,
    $stopItem,
    $autoStartItem,
    (New-Object System.Windows.Forms.ToolStripSeparator),
    $credentialsItem,
    $logsItem,
    (New-Object System.Windows.Forms.ToolStripSeparator),
    $exitItem
))

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Icon = [System.Drawing.SystemIcons]::Application
$notifyIcon.Text = "Bridge local: iniciando..."
$notifyIcon.ContextMenuStrip = $contextMenu
$notifyIcon.Visible = $true
$notifyIcon.add_DoubleClick({
    if (Test-BridgeHealth) {
        [System.Windows.Forms.MessageBox]::Show(
            "El bridge local está activo y escucha solo en 127.0.0.1:32145.",
            "Bridge local",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Information
        ) | Out-Null
    } else {
        try {
            Start-Bridge
        } catch {
            Write-BridgeLog "No se pudo iniciar el bridge: $($_.Exception.Message)"
            [System.Windows.Forms.MessageBox]::Show(
                $_.Exception.Message,
                "No se pudo iniciar el bridge",
                [System.Windows.Forms.MessageBoxButtons]::OK,
                [System.Windows.Forms.MessageBoxIcon]::Error
            ) | Out-Null
        }
    }
})
$startItem.add_Click({
    try {
        Start-Bridge
    } catch {
        Write-BridgeLog "No se pudo iniciar el bridge: $($_.Exception.Message)"
        [System.Windows.Forms.MessageBox]::Show(
            $_.Exception.Message,
            "No se pudo iniciar el bridge",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        ) | Out-Null
    }
})
$stopItem.add_Click({ Stop-Bridge })
$autoStartItem.add_Click({
    try {
        Set-AutoStart (-not $autoStartItem.Checked)
    } catch {
        [System.Windows.Forms.MessageBox]::Show(
            "No se pudo actualizar el inicio automático:`r`n$($_.Exception.Message)",
            "Error de configuración",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        ) | Out-Null
    }
})
$credentialsItem.add_Click({
    if (-not (Test-Path -LiteralPath $script:credentialsPath)) {
        [System.Windows.Forms.MessageBox]::Show(
            "El archivo de credenciales todavía no existe. Iniciá el bridge primero.",
            "Credenciales no disponibles",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Information
        ) | Out-Null
        return
    }
    Start-Process -FilePath "notepad.exe" -ArgumentList "`"$($script:credentialsPath)`""
})
$logsItem.add_Click({
    try {
        Show-BridgeLogs
    } catch {
        [System.Windows.Forms.MessageBox]::Show(
            "No se pudieron abrir los logs:`r`n$($_.Exception.Message)",
            "Error al abrir logs",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        ) | Out-Null
    }
})
$exitItem.add_Click({ Exit-TrayApp })

$healthTimer = New-Object System.Windows.Forms.Timer
$healthTimer.Interval = 2000
$healthTimer.add_Tick({
    if (-not $script:closing) {
        Update-TrayState
    }
})
$healthTimer.Start()
Update-TrayState

if (Test-AutoStartEnabled) {
    try {
        Start-Bridge
    } catch {
        Write-BridgeLog "No se pudo iniciar automáticamente el bridge: $($_.Exception.Message)"
        $notifyIcon.ShowBalloonTip(
            8000,
            "No se pudo iniciar el bridge",
            $_.Exception.Message,
            [System.Windows.Forms.ToolTipIcon]::Error
        )
    }
}

$appContext = New-Object System.Windows.Forms.ApplicationContext
[System.Windows.Forms.Application]::Run($appContext)
