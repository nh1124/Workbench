@echo off
setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "PROJECT_ROOT=%SCRIPT_DIR%\.."

call "%SCRIPT_DIR%\initialize_system.bat"
if errorlevel 1 exit /b 1

for %%P in (4100 4101 4102 4103 4104 5173) do (
  for /f "tokens=5" %%A in ('netstat -ano ^| findstr ":%%P " ^| findstr "LISTENING"') do (
    echo [ERROR] Port %%P is already in use by PID %%A. Please stop the process and retry.
    exit /b 1
  )
)

echo Starting Workbench web stack (services + web UI)...
cd /d "%PROJECT_ROOT%"
docker compose up -d
if errorlevel 1 (
  echo [ERROR] Failed to start PostgreSQL containers. Please ensure Docker Desktop is running.
  exit /b 1
)
npm run dev

endlocal
