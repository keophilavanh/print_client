@echo off
setlocal EnableExtensions EnableDelayedExpansion
title Install Print Client service

rem ---- Settings ----------------------------------------------------------
set "SERVICE_ID=PrintClient"
set "SERVICE_NAME=Print Client"
set "SERVICE_DESC=Receives print jobs from Print Service and sends them to the shop printers."
set "WINSW_URL=https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW.NET461.exe"
rem -----------------------------------------------------------------------

net session >nul 2>&1
if errorlevel 1 (
  echo Requesting administrator rights...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

cd /d "%~dp0"
set "APP_DIR=%~dp0"
set "APP_DIR=%APP_DIR:~0,-1%"
set "SERVICE_DIR=%APP_DIR%\service"
set "SERVICE_EXE=%SERVICE_DIR%\%SERVICE_ID%.exe"
set "SERVICE_XML=%SERVICE_DIR%\%SERVICE_ID%.xml"

set "PORT=3020"
if exist ".env" (
  for /f "usebackq tokens=1,* delims==" %%a in (".env") do if /i "%%a"=="PORT" set "PORT=%%b"
)

echo.
echo === Print Client service installer ===
echo Folder : %APP_DIR%
echo Port   : %PORT%
echo.

rem ---- Node.js ------------------------------------------------------------
set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE (
  echo [ERROR] Node.js was not found. Install Node.js 22 or newer from https://nodejs.org and run this again.
  goto :fail
)
for /f "tokens=1 delims=." %%v in ('"!NODE_EXE!" --version') do set "NODE_MAJOR=%%v"
set "NODE_MAJOR=!NODE_MAJOR:v=!"
if !NODE_MAJOR! LSS 22 (
  echo [ERROR] Node.js 22 or newer is required. Found:
  "!NODE_EXE!" --version
  goto :fail
)
echo [OK] Node.js: !NODE_EXE!

rem ---- Remove an existing installation -----------------------------------
sc query "%SERVICE_ID%" >nul 2>&1
if not errorlevel 1 (
  echo Removing the existing %SERVICE_ID% service...
  if exist "!SERVICE_EXE!" (
    "!SERVICE_EXE!" stopwait >nul 2>&1
    "!SERVICE_EXE!" uninstall >nul 2>&1
  ) else (
    sc stop "%SERVICE_ID%" >nul 2>&1
    sc delete "%SERVICE_ID%" >nul 2>&1
  )
  timeout /t 3 /nobreak >nul
)

rem ---- Port must be free --------------------------------------------------
netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul
if not errorlevel 1 (
  echo [ERROR] Port %PORT% is already in use. Close the other Print Client window ^(npm start / npm run dev^) and run this again.
  goto :fail
)

rem ---- Build --------------------------------------------------------------
if not exist "node_modules" (
  echo Installing packages...
  call npm install
  if errorlevel 1 goto :fail
)
echo Building...
call npm run build
if errorlevel 1 goto :fail
echo [OK] Build finished

rem ---- Service wrapper ----------------------------------------------------
if not exist "!SERVICE_DIR!" mkdir "!SERVICE_DIR!"
if not exist "!SERVICE_EXE!" (
  echo Downloading WinSW service wrapper...
  powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol = 'Tls12'; Invoke-WebRequest -UseBasicParsing -Uri '%WINSW_URL%' -OutFile '!SERVICE_EXE!'"
  if errorlevel 1 (
    echo [ERROR] Download failed. Download %WINSW_URL%
    echo         manually and save it as !SERVICE_EXE!
    goto :fail
  )
)

> "%SERVICE_XML%" (
  echo ^<service^>
  echo   ^<id^>%SERVICE_ID%^</id^>
  echo   ^<name^>%SERVICE_NAME%^</name^>
  echo   ^<description^>%SERVICE_DESC%^</description^>
  echo   ^<executable^>!NODE_EXE!^</executable^>
  echo   ^<arguments^>--env-file-if-exists=.env --disable-warning=ExperimentalWarning dist\server.js^</arguments^>
  echo   ^<workingdirectory^>!APP_DIR!^</workingdirectory^>
  echo   ^<startmode^>Automatic^</startmode^>
  echo   ^<stoptimeout^>15 sec^</stoptimeout^>
  echo   ^<onfailure action="restart" delay="10 sec"/^>
  echo   ^<resetfailure^>1 hour^</resetfailure^>
  echo   ^<logpath^>!SERVICE_DIR!\logs^</logpath^>
  echo   ^<log mode="roll-by-size"^>
  echo     ^<sizeThreshold^>10240^</sizeThreshold^>
  echo     ^<keepFiles^>5^</keepFiles^>
  echo   ^</log^>
  echo ^</service^>
)

rem ---- Install and start --------------------------------------------------
echo Installing service...
"!SERVICE_EXE!" install
if errorlevel 1 goto :fail
echo Starting service...
"!SERVICE_EXE!" start
if errorlevel 1 goto :fail

echo Waiting for the service to answer...
set "HEALTHY="
for /l %%n in (1,1,15) do (
  if not defined HEALTHY (
    timeout /t 1 /nobreak >nul
    powershell -NoProfile -Command "try { $null = Invoke-RestMethod 'http://localhost:%PORT%/health' -TimeoutSec 2; exit 0 } catch { exit 1 }" >nul 2>&1
    if not errorlevel 1 set "HEALTHY=1"
  )
)
if not defined HEALTHY (
  echo [ERROR] The service was installed but is not answering on port %PORT%.
  echo         Check the logs in !SERVICE_DIR!\logs
  goto :fail
)

echo.
echo [OK] "%SERVICE_NAME%" is installed and running. It starts automatically with Windows.
echo      Dashboard: http://localhost:%PORT%
echo      Logs     : !SERVICE_DIR!\logs
echo.
pause
exit /b 0

:fail
echo.
echo Installation did not finish.
pause
exit /b 1
