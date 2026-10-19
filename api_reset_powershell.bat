@echo off
chcp 65001 >nul
set "DIR=%USERPROFILE%\Documents\Programación\Cajas\Extension"

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList @('-NoExit','-NoProfile','-ExecutionPolicy','Bypass','-Command', ('Set-Location -LiteralPath ([Environment]::GetFolderPath(''MyDocuments'') + ''\Programación\Cajas\Extension''); & .\data-api\update-windows-api.ps1'))"

pause