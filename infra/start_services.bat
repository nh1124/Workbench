@echo off
setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "PROJECT_ROOT=%SCRIPT_DIR%\.."

call "%SCRIPT_DIR%\initialize_system.bat"
if errorlevel 1 exit /b 1

for %%P in (4100 4101 4102 4103 4104) do (
  for /f "tokens=5" %%A in ('netstat -ano ^| findstr ":%%P " ^| findstr "LISTENING"') do (
    echo [ERROR] Port %%P is already in use by PID %%A. Please stop the process and retry.
    exit /b 1
  )
)

echo Starting Workbench service stack (Core HTTP + internal services + DB)...
cd /d "%PROJECT_ROOT%"
docker compose up -d
if errorlevel 1 (
  echo [ERROR] Failed to start PostgreSQL containers. Please ensure Docker Desktop is running.
  exit /b 1
)
call npm run dev:services
set "APP_EXIT=%ERRORLEVEL%"

call :cleanup_ports

endlocal & exit /b %APP_EXIT%

:cleanup_ports
echo Cleaning up service processes...
for %%P in (4100 4101 4102 4103 4104) do (
  for /f "tokens=5" %%A in ('netstat -ano ^| findstr ":%%P " ^| findstr "LISTENING"') do (
    if not "%%A"=="0" if not "%%A"=="4" (
      echo [INFO] Stopping PID %%A on port %%P
      taskkill /PID %%A /T /F >nul 2>&1
    )
  )
)
exit /b 0

