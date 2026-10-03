Option Explicit

Dim shell, files, scriptPath, powershellPath, command
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")

scriptPath = files.GetParentFolderName(WScript.ScriptFullName) & "\BridgeTray.ps1"
powershellPath = shell.ExpandEnvironmentStrings("%WINDIR%") & _
    "\System32\WindowsPowerShell\v1.0\powershell.exe"
command = """" & powershellPath & """ -NoProfile -STA -WindowStyle Hidden" & _
    " -ExecutionPolicy Bypass -File """ & scriptPath & """"

shell.Run command, 0, False
