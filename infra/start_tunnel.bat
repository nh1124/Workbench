@echo off
setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "COMPOSE_FILE=%SCRIPT_DIR%\docker-compose.yml"
set "PROJECT_ROOT=%SCRIPT_DIR%\.."

set "ENV_FILE=%PROJECT_ROOT%\.env.edge"
set "EDGE_ENV_FILE=../.env.edge"

if not exist "%PROJECT_ROOT%\.env.edge" (
    echo ERROR: %PROJECT_ROOT%\.env.edge not found.
    echo Create it with: TUNNEL_TOKEN=^<your-cloudflare-tunnel-token^>
    echo See infra\env_samples\.env.edge.example for reference.
    exit /b 1
)

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

echo Starting Cloudflare tunnel service...
set "EDGE_ENV_FILE=%EDGE_ENV_FILE%"
%DC% --env-file "%ENV_FILE%" -f "%COMPOSE_FILE%" --profile edge up --build tunnel

endlocal
