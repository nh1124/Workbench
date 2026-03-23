@echo off
setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "PROJECT_ROOT=%SCRIPT_DIR%\.."

call "%SCRIPT_DIR%\initialize_system.bat"
if errorlevel 1 exit /b 1

echo Building all workspaces...
cd /d "%PROJECT_ROOT%"
npm run build

endlocal