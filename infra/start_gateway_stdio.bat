@echo off
setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "PROJECT_ROOT=%SCRIPT_DIR%\.."

call "%SCRIPT_DIR%\initialize_system.bat"
if errorlevel 1 exit /b 1

echo Starting Core MCP stdio gateway with internal services...
echo [INFO] External MCP surface is provided by Workbench Core only.
echo [INFO] UI is NOT started in this mode.
cd /d "%PROJECT_ROOT%"
docker compose up -d workbench-core-db notes-db artifacts-db tasks-db projects-db images-db mindmaps-db wbs-db insights-db
if errorlevel 1 (
  echo [ERROR] Failed to start PostgreSQL containers. Please ensure Docker Desktop is running.
  exit /b 1
)
npm run dev:gateway:stdio

endlocal
