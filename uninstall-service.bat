@echo off
setlocal EnableExtensions EnableDelayedExpansion
title Uninstall Print Client service

set "SERVICE_ID=PrintClient"

net session >nul 2>&1
if errorlevel 1 (
  echo Requesting administrator rights...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

cd /d "%~dp0"
set "SERVICE_DIR=%~dp0service"
set "SERVICE_EXE=%SERVICE_DIR%\%SERVICE_ID%.exe"

echo.
echo === Print Client service uninstaller ===
echo.

sc query "%SERVICE_ID%" >nul 2>&1
if errorlevel 1 (
  echo The %SERVICE_ID% service is not installed.
) else (
  echo Stopping service...
  if exist "!SERVICE_EXE!" (
    "!SERVICE_EXE!" stopwait
    echo Removing service...
    "!SERVICE_EXE!" uninstall
  ) else (
    sc stop "%SERVICE_ID%" >nul 2>&1
    timeout /t 3 /nobreak >nul
    echo Removing service...
    sc delete "%SERVICE_ID%"
  )
  timeout /t 2 /nobreak >nul
  sc query "%SERVICE_ID%" >nul 2>&1
  if errorlevel 1 (
    echo [OK] Service removed.
  ) else (
    echo [WARN] Windows marked the service for deletion. Close the Services window or restart the PC to finish.
  )
)

if exist "!SERVICE_DIR!" (
  echo.
  choice /c YN /n /m "Delete the service folder (wrapper and service logs)? [Y/N] "
  if !errorlevel! equ 1 (
    rmdir /s /q "!SERVICE_DIR!"
    echo [OK] Deleted !SERVICE_DIR!
  )
)

echo.
echo Print jobs and settings in the data folder were kept.
pause
exit /b 0
