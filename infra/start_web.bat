@echo off
setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "PROJECT_ROOT=%SCRIPT_DIR%\.."

call "%SCRIPT_DIR%\initialize_system.bat"
if errorlevel 1 exit /b 1

for %%P in (5173) do (
  for /f "tokens=5" %%A in ('netstat -ano ^| findstr ":%%P " ^| findstr "LISTENING"') do (
    echo [ERROR] Port %%P is already in use by PID %%A. Please stop the process and retry.
    exit /b 1
  )
)

echo Starting Workbench frontend (web UI only)...
echo [INFO] Backend APIs are NOT started by this script.
echo [INFO] Start infra\start_services.bat in another terminal first.
cd /d "%PROJECT_ROOT%"
npm run dev:web

endlocal
