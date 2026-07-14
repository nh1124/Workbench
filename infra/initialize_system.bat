@echo off
setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "PROJECT_ROOT=%SCRIPT_DIR%\.."

node "%SCRIPT_DIR%\scripts\ensure-npm-install.mjs"
if errorlevel 1 exit /b 1

call :ensure_env "%PROJECT_ROOT%\infra\workbench.env" "%PROJECT_ROOT%\infra\workbench.env.example"
if errorlevel 1 exit /b 1
call :ensure_env "%PROJECT_ROOT%\services\notes\.env" "%PROJECT_ROOT%\services\notes\.env.example"
if errorlevel 1 exit /b 1
call :ensure_env "%PROJECT_ROOT%\services\artifacts\.env" "%PROJECT_ROOT%\services\artifacts\.env.example"
if errorlevel 1 exit /b 1
call :ensure_env "%PROJECT_ROOT%\services\tasks\.env" "%PROJECT_ROOT%\services\tasks\.env.example"
if errorlevel 1 exit /b 1
call :ensure_env "%PROJECT_ROOT%\services\projects\.env" "%PROJECT_ROOT%\services\projects\.env.example"
if errorlevel 1 exit /b 1
if errorlevel 1 exit /b 1
call :ensure_env "%PROJECT_ROOT%\services\insights\.env" "%PROJECT_ROOT%\services\insights\.env.example"
if errorlevel 1 exit /b 1
call :ensure_env "%PROJECT_ROOT%\services\workbench-core\.env" "%PROJECT_ROOT%\services\workbench-core\.env.example"
if errorlevel 1 exit /b 1
call :ensure_env "%PROJECT_ROOT%\ui\.env" "%PROJECT_ROOT%\ui\.env.example"
if errorlevel 1 exit /b 1
call :ensure_env "%PROJECT_ROOT%\native\desktop\.env" "%PROJECT_ROOT%\native\desktop\.env.example"
if errorlevel 1 exit /b 1

node "%SCRIPT_DIR%\scripts\workbench-env.mjs" sync
if errorlevel 1 exit /b 1

if not exist "%PROJECT_ROOT%\logs" mkdir "%PROJECT_ROOT%\logs"

echo Environment files are ready.
exit /b 0

:ensure_env
set "TARGET=%~1"
set "SAMPLE=%~2"
if exist "%TARGET%" (
  echo [OK] %TARGET%
  exit /b 0
)
if not exist "%SAMPLE%" (
  echo [ERROR] Missing sample file: %SAMPLE%
  exit /b 1
)
copy /Y "%SAMPLE%" "%TARGET%" >nul
if errorlevel 1 (
  echo [ERROR] Failed to create %TARGET%
  exit /b 1
)
echo [CREATED] %TARGET%
exit /b 0
