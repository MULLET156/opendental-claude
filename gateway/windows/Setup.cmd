@echo off
rem Open Dental Gateway setup. Double-click to install, update or change settings.
set "SCRIPT=%~dp0app\gateway\windows\setup.ps1"
if not exist "%SCRIPT%" set "SCRIPT=%~dp0setup.ps1"
if not exist "%SCRIPT%" (
  echo Cannot find setup.ps1. Extract the whole zip file first ^(right-click it, Extract All^), then run Setup.cmd from the extracted folder.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
