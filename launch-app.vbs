Option Explicit

Dim fileSystem, shell, appDirectory, command
Set fileSystem = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
appDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & appDirectory & "\launch-app.ps1"""
shell.Run command, 0, False
