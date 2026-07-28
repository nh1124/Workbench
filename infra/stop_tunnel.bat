@echo off
setlocal

REM Stops the Cloudflare tunnel started by start_tunnel.bat. `restart:
REM unless-stopped` means the container comes back on its own after a crash or a
REM reboot, so stopping it needs an explicit command rather than closing a shell.

set "SCRIPT_DIR=%~dp0"
set "PROJECT_ROOT=%SCRIPT_DIR%.."
set "COMPOSE_FILE=%SCRIPT_DIR%docker-compose.edge.yml"
set "ENV_FILE=%PROJECT_ROOT%\.env.edge"
set "EDGE_ENV_FILE=../.env.edge"

docker compose version >nul 2>&1
if not errorlevel 1 (
    set "DC=docker compose"
) else (
    docker-compose --version >nul 2>&1
    if errorlevel 1 (
        echo ERROR: Docker Compose not found.
        exit /b 1
    )
    set "DC=docker-compose"
)

echo Stopping Cloudflare tunnel service...
%DC% --env-file "%ENV_FILE%" -f "%COMPOSE_FILE%" --profile edge down

echo Tunnel stopped.

endlocal
