@echo off
setlocal

set SCRIPT_DIR=%~dp0

if "%~1"=="--up" (
  powershell -ExecutionPolicy Bypass -File "%SCRIPT_DIR%load-offline-images.ps1" -Up
) else (
  powershell -ExecutionPolicy Bypass -File "%SCRIPT_DIR%load-offline-images.ps1"
)

endlocal
