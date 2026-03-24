@echo off
setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "PROJECT_ROOT=%SCRIPT_DIR%\.."

if not defined CHECK_INTERVAL_SECONDS set "CHECK_INTERVAL_SECONDS=60"
if not defined ALLOW_DIRTY set "ALLOW_DIRTY=0"
if not defined RESTART_AFTER_PULL set "RESTART_AFTER_PULL=1"
if not defined TARGET_BRANCH set "TARGET_BRANCH="

for %%C in (git npm node) do (
    where %%C >nul 2>&1 || (
        echo [ERROR] Required command not found: %%C
        exit /b 1
    )
)

cd /d "%PROJECT_ROOT%"

if "%TARGET_BRANCH%" == "" (
    for /f "tokens=*" %%B in ('git rev-parse --abbrev-ref HEAD') do set "TARGET_BRANCH=%%B"
    if "!TARGET_BRANCH!" == "HEAD" (
        echo [ERROR] Detached HEAD detected. Set TARGET_BRANCH explicitly.
        exit /b 1
    )
)

echo Checking for updates on origin/%TARGET_BRANCH%...

for /f "tokens=1" %%H in ('git ls-remote --heads origin "%TARGET_BRANCH%" 2^>nul') do set "REMOTE_COMMIT=%%H"
for /f "tokens=*" %%H in ('git rev-parse HEAD') do set "LOCAL_COMMIT=%%H"

if not defined REMOTE_COMMIT (
    echo [ERROR] Could not resolve remote commit for branch origin/%TARGET_BRANCH%
    exit /b 1
)

if "%LOCAL_COMMIT%" == "%REMOTE_COMMIT%" (
    echo No changes on origin/%TARGET_BRANCH% (local=%LOCAL_COMMIT%)
    exit /b 0
)

echo Update detected on origin/%TARGET_BRANCH% (local=%LOCAL_COMMIT%, remote=%REMOTE_COMMIT%)

if not "%ALLOW_DIRTY%" == "1" (
    for /f "tokens=*" %%S in ('git status --porcelain') do (
        echo [WARN] Working tree is dirty. Skipping update ^(set ALLOW_DIRTY=1 to override^).
        exit /b 0
    )
)

echo Pulling latest changes...
git fetch origin "%TARGET_BRANCH%"
git pull --ff-only origin "%TARGET_BRANCH%"
if errorlevel 1 (
    echo [ERROR] git pull failed.
    exit /b 1
)

if "%RESTART_AFTER_PULL%" == "1" (
    echo Running npm install...
    npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed.
        exit /b 1
    )
    echo.
    echo [DONE] Update complete. Please restart the dev server manually:
    echo        npm run dev
) else (
    echo Skipping service restart ^(RESTART_AFTER_PULL=%RESTART_AFTER_PULL%^)
)

endlocal
