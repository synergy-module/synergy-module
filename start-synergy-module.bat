@echo off
setlocal

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [Synergy Module] Node.js 24 or newer is required.
  echo [Synergy Module] Install Node.js, then run this launcher again.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [Synergy Module] npm was not found on your PATH.
  echo [Synergy Module] Repair your Node.js installation, then run this launcher again.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo [Synergy Module] Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo [Synergy Module] Dependency installation failed.
    pause
    exit /b 1
  )
)

set "synergyModuleHost=%HOST%"
set "synergyModulePort=%PORT%"
if not defined synergyModuleHost set "synergyModuleHost=127.0.0.1"
if not defined synergyModulePort set "synergyModulePort=3000"

echo [Synergy Module] Starting the MVC app at http://%synergyModuleHost%:%synergyModulePort%
echo [Synergy Module] Authentication configuration: npm start loads .env when present.
if defined SYNERGY_MODULE_SKIP_BROWSER (
  echo [Synergy Module] Browser launch skipped.
) else (
  echo [Synergy Module] Opening the local site in your default browser...
  start "" "http://%synergyModuleHost%:%synergyModulePort%"
)
echo [Synergy Module] Press Ctrl+C to stop the server.
call npm start
set "exitCode=%errorlevel%"

if not "%exitCode%"=="0" (
  echo [Synergy Module] The server exited with code %exitCode%.
  pause
)

endlocal & exit /b %exitCode%
