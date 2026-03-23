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
npm run dev:gateway:stdio

endlocal

